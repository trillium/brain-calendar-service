// OAuth credential plumbing: load, refresh, store, and hand the transport a header.
//
// Hard rules, enforced here rather than by convention:
//   1. NOTHING IS READ FROM THE REPO. Credentials come from environment variables
//      or from a file that must sit OUTSIDE the repository root and be mode 0600.
//      A secret that can be committed eventually will be.
//   2. NO SECRET IS EVER PRINTED. Errors name the variable or the field that is
//      wrong, never its value, and never the token endpoint's response body.
//   3. The token endpoint must be https, or loopback so tests can fake it. A
//      refresh token sent over plain http to a non-local host is a leak.
//
// Everything with a side effect (fs, fetch, clock) is injected, so the whole
// module is testable against a fake token endpoint with no real account.

import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh this long before expiry so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

export class TokenRefreshError extends Error {
  constructor(
    message: string,
    /** True when only a human can fix it: the refresh token was revoked or expired. */
    readonly reconsentRequired: boolean,
  ) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

interface OAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly tokenUrl: string;
}

interface CachedToken {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

const CredentialFile = z.object({
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  token_url: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  expires_at: z.number().optional(),
});

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

const ErrorResponse = z.object({ error: z.string().min(1) });

interface CredentialSource {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Repo root. A credential file inside it is refused. */
  readonly repoRoot: string;
}

const insideRoot = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

/** Refuse a credential file that is in the repo, not a plain file, or readable by others. */
const assertSafeFile = (path: string, repoRoot: string): void => {
  if (insideRoot(repoRoot, path)) {
    throw new CredentialsError("CALENDAR_OAUTH_FILE must be outside the repository");
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new CredentialsError("CALENDAR_OAUTH_FILE must be a regular file");
  if ((stat.mode & 0o077) !== 0) {
    throw new CredentialsError(
      `CALENDAR_OAUTH_FILE must be mode 0600, found ${(stat.mode & 0o777).toString(8)}`,
    );
  }
};

const assertSafeTokenUrl = (raw: string): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CredentialsError("token endpoint is not a valid URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CredentialsError("token endpoint must be https (http only on loopback)");
  }
};

interface Loaded {
  readonly credentials: OAuthCredentials;
  readonly cached: CachedToken | null;
  /** Set only when the credentials came from a file, which is where tokens get saved. */
  readonly filePath: string | null;
}

const readFileFields = (path: string | undefined, repoRoot: string) => {
  if (path === undefined) return CredentialFile.parse({});
  assertSafeFile(path, repoRoot);
  return CredentialFile.parse(JSON.parse(readFileSync(path, "utf8")));
};

/** Env wins per field; the file fills in the rest. Missing fields are named, not guessed. */
export const loadCredentials = (source: CredentialSource): Loaded => {
  const { env } = source;
  const filePath = env.CALENDAR_OAUTH_FILE;
  const file = readFileFields(filePath, source.repoRoot);
  const clientId = env.CALENDAR_OAUTH_CLIENT_ID ?? file.client_id;
  const clientSecret = env.CALENDAR_OAUTH_CLIENT_SECRET ?? file.client_secret;
  const refreshToken = env.CALENDAR_OAUTH_REFRESH_TOKEN ?? file.refresh_token;
  const missing = [
    clientId ? null : "CALENDAR_OAUTH_CLIENT_ID",
    clientSecret ? null : "CALENDAR_OAUTH_CLIENT_SECRET",
    refreshToken ? null : "CALENDAR_OAUTH_REFRESH_TOKEN",
  ].filter((m) => m !== null);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new CredentialsError(`missing OAuth credentials: ${missing.join(", ")}`);
  }
  const tokenUrl = env.CALENDAR_OAUTH_TOKEN_URL ?? file.token_url ?? GOOGLE_TOKEN_URL;
  assertSafeTokenUrl(tokenUrl);
  const cached =
    file.access_token && file.expires_at
      ? { accessToken: file.access_token, expiresAt: file.expires_at }
      : null;
  return {
    credentials: { clientId, clientSecret, refreshToken, tokenUrl },
    cached,
    filePath: filePath ?? null,
  };
};

/** Atomic 0600 write: a crash mid-write must not leave a truncated credential file. */
const persist = (path: string, credentials: OAuthCredentials, token: CachedToken): void => {
  const body = {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    token_url: credentials.tokenUrl,
    access_token: token.accessToken,
    expires_at: token.expiresAt,
  };
  const tmp = join(dirname(path), `.${process.pid}.oauth.tmp`);
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  renameSync(tmp, path);
};

interface TokenDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

/** What the transport needs: a header, and a way to say "that one was rejected". */
export interface AuthorizationSource {
  authorization(forceRefresh?: boolean): Promise<string>;
}

const exchange = async (
  credentials: OAuthCredentials,
  deps: TokenDeps,
): Promise<z.infer<typeof TokenResponse>> => {
  const res = await deps.fetch(credentials.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    }),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = ErrorResponse.safeParse(json);
    const error = code.success ? code.data.error : "unknown_error";
    throw new TokenRefreshError(
      `token endpoint refused the refresh (HTTP ${res.status}, ${error})`,
      error === "invalid_grant",
    );
  }
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success)
    throw new TokenRefreshError("token endpoint returned a malformed body", false);
  return parsed.data;
};

export const createTokenSource = (loaded: Loaded, deps: TokenDeps): AuthorizationSource => {
  let credentials = loaded.credentials;
  let token = loaded.cached;
  let inflight: Promise<CachedToken> | null = null;

  const refresh = async (): Promise<CachedToken> => {
    const issued = await exchange(credentials, deps);
    // Google may rotate the refresh token; keep the newest or the next run dies.
    credentials = {
      ...credentials,
      refreshToken: issued.refresh_token ?? credentials.refreshToken,
    };
    token = { accessToken: issued.access_token, expiresAt: deps.now() + issued.expires_in * 1000 };
    if (loaded.filePath !== null) persist(loaded.filePath, credentials, token);
    return token;
  };

  return {
    async authorization(forceRefresh = false) {
      const fresh = token !== null && token.expiresAt - EXPIRY_SKEW_MS > deps.now();
      if (fresh && !forceRefresh && token !== null) return `Bearer ${token.accessToken}`;
      // Single flight: concurrent callers share one refresh, not N.
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return `Bearer ${(await inflight).accessToken}`;
    },
  };
};
