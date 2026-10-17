// L4's tests. Every credential here is an obvious placeholder invented for the
// test, and the token endpoint is a local fake on a loopback port. Nothing in
// this file can reach a real account, and real-account behaviour is UNVERIFIED.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialsError, createTokenSource, loadCredentials, TokenRefreshError } from "./auth.js";
import { fetchTransport } from "./transport.js";

const REPO = "/nonexistent/repo-root";

interface FakeEndpoint {
  url: string;
  grants: URLSearchParams[];
  /** Next response; defaults to a fresh token. */
  respond: (n: number) => { status: number; body: unknown };
  close: () => Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
};

const fakeTokenEndpoint = async (): Promise<FakeEndpoint> => {
  const fake: FakeEndpoint = {
    url: "",
    grants: [],
    respond: (n) => ({
      status: 200,
      body: { access_token: `access-${n}`, expires_in: 3600 },
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      fake.grants.push(new URLSearchParams(body));
      const out = fake.respond(fake.grants.length);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  fake.url = await listen(server);
  return fake;
};

const ENV = {
  CALENDAR_OAUTH_CLIENT_ID: "test-client-id",
  CALENDAR_OAUTH_CLIENT_SECRET: "test-client-secret",
  CALENDAR_OAUTH_REFRESH_TOKEN: "test-refresh-token",
};

let endpoint: FakeEndpoint;
let dir: string;
let clock: number;
const deps = () => ({ fetch, now: () => clock });

beforeEach(async () => {
  endpoint = await fakeTokenEndpoint();
  dir = mkdtempSync(join(tmpdir(), "oauth-test-"));
  clock = 1_000_000;
});

afterEach(async () => {
  await endpoint.close();
});

const source = (env: Record<string, string | undefined>) =>
  createTokenSource(
    loadCredentials({ env: { ...env, CALENDAR_OAUTH_TOKEN_URL: endpoint.url }, repoRoot: REPO }),
    deps(),
  );

describe("loading credentials", () => {
  it("reads id, secret and refresh token from the environment", () => {
    const loaded = loadCredentials({ env: { ...ENV }, repoRoot: REPO });
    expect(loaded.credentials.clientId).toBe("test-client-id");
    expect(loaded.filePath).toBeNull();
  });

  it("names what is missing and never echoes a value", () => {
    const run = () =>
      loadCredentials({
        env: { CALENDAR_OAUTH_CLIENT_ID: "test-client-id" },
        repoRoot: REPO,
      });
    expect(run).toThrow(/CALENDAR_OAUTH_CLIENT_SECRET, CALENDAR_OAUTH_REFRESH_TOKEN/);
    expect(run).not.toThrow(/test-client-id/);
  });

  it("reads a 0600 file outside the repo", () => {
    const path = join(dir, "oauth.json");
    writeFileSync(
      path,
      JSON.stringify({ client_id: "f-id", client_secret: "f-secret", refresh_token: "f-refresh" }),
      { mode: 0o600 },
    );
    const loaded = loadCredentials({ env: { CALENDAR_OAUTH_FILE: path }, repoRoot: REPO });
    expect(loaded.credentials.refreshToken).toBe("f-refresh");
    expect(loaded.filePath).toBe(path);
  });

  it("refuses a group- or world-readable file", () => {
    const path = join(dir, "loose.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    expect(() => loadCredentials({ env: { CALENDAR_OAUTH_FILE: path }, repoRoot: REPO })).toThrow(
      /mode 0600/,
    );
  });

  it("refuses a file inside the repository", () => {
    const path = join(dir, "inside.json");
    writeFileSync(path, "{}", { mode: 0o600 });
    expect(() => loadCredentials({ env: { CALENDAR_OAUTH_FILE: path }, repoRoot: dir })).toThrow(
      /outside the repository/,
    );
  });

  it("refuses a token endpoint that is plain http to a remote host", () => {
    expect(() =>
      loadCredentials({
        env: { ...ENV, CALENDAR_OAUTH_TOKEN_URL: "http://example.invalid/token" },
        repoRoot: REPO,
      }),
    ).toThrow(CredentialsError);
  });

  it("defaults to Google's https token endpoint", () => {
    const loaded = loadCredentials({ env: { ...ENV }, repoRoot: REPO });
    expect(loaded.credentials.tokenUrl).toBe("https://oauth2.googleapis.com/token");
  });
});

describe("refreshing and caching", () => {
  it("exchanges the refresh token and returns a Bearer header", async () => {
    const auth = source(ENV);
    expect(await auth.authorization()).toBe("Bearer access-1");
    const grant = endpoint.grants[0];
    expect(grant.get("grant_type")).toBe("refresh_token");
    expect(grant.get("refresh_token")).toBe("test-refresh-token");
    expect(grant.get("client_id")).toBe("test-client-id");
  });

  it("reuses a fresh token and refreshes one near expiry", async () => {
    const auth = source(ENV);
    await auth.authorization();
    await auth.authorization();
    expect(endpoint.grants).toHaveLength(1);
    clock += 3600_000 - 30_000; // inside the 60 s skew
    expect(await auth.authorization()).toBe("Bearer access-2");
  });

  it("shares one refresh between concurrent callers", async () => {
    const auth = source(ENV);
    const headers = await Promise.all([auth.authorization(), auth.authorization()]);
    expect(headers).toEqual(["Bearer access-1", "Bearer access-1"]);
    expect(endpoint.grants).toHaveLength(1);
  });

  it("forces a refresh on request even when the token looks fresh", async () => {
    const auth = source(ENV);
    await auth.authorization();
    expect(await auth.authorization(true)).toBe("Bearer access-2");
  });

  it("flags a revoked refresh token as needing a human", async () => {
    endpoint.respond = () => ({ status: 400, body: { error: "invalid_grant" } });
    const err = await source(ENV)
      .authorization()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect((err as TokenRefreshError).reconsentRequired).toBe(true);
    expect((err as Error).message).not.toMatch(/test-client-secret|test-refresh-token/);
  });

  it("treats a malformed token response as a failure, not a token", async () => {
    endpoint.respond = () => ({ status: 200, body: { nope: true } });
    await expect(source(ENV).authorization()).rejects.toThrow(/malformed/);
  });
});

describe("storage", () => {
  it("persists the refreshed token and a rotated refresh token at 0600", async () => {
    const path = join(dir, "oauth.json");
    writeFileSync(
      path,
      JSON.stringify({ client_id: "i", client_secret: "s", refresh_token: "r1" }),
      {
        mode: 0o600,
      },
    );
    endpoint.respond = () => ({
      status: 200,
      body: { access_token: "A1", expires_in: 3600, refresh_token: "r2" },
    });
    const loaded = loadCredentials({
      env: { CALENDAR_OAUTH_FILE: path, CALENDAR_OAUTH_TOKEN_URL: endpoint.url },
      repoRoot: REPO,
    });
    await createTokenSource(loaded, deps()).authorization();
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).toMatchObject({ access_token: "A1", refresh_token: "r2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("resumes from a stored unexpired token without calling the endpoint", async () => {
    const path = join(dir, "oauth.json");
    writeFileSync(
      path,
      JSON.stringify({
        client_id: "i",
        client_secret: "s",
        refresh_token: "r",
        access_token: "STORED",
        expires_at: clock + 3600_000,
      }),
      { mode: 0o600 },
    );
    const loaded = loadCredentials({
      env: { CALENDAR_OAUTH_FILE: path, CALENDAR_OAUTH_TOKEN_URL: endpoint.url },
      repoRoot: REPO,
    });
    expect(await createTokenSource(loaded, deps()).authorization()).toBe("Bearer STORED");
    expect(endpoint.grants).toHaveLength(0);
  });
});

describe("the transport passes the Authorization header", () => {
  const resourceServer = async (accept: (header: string | undefined) => boolean) => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(accept(req.headers.authorization) ? 207 : 401);
      res.end("x");
    });
    const url = await listen(server);
    return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
  };

  it("sends the Bearer token on a request", async () => {
    const resource = await resourceServer((h) => h === "Bearer access-1");
    const transport = fetchTransport(resource.url, {}, source(ENV));
    const res = await transport.request("PROPFIND", "/cal");
    await resource.close();
    expect(res.status).toBe(207);
    expect(resource.seen).toEqual(["Bearer access-1"]);
  });

  it("on a 401 refreshes once and retries with the new token", async () => {
    const resource = await resourceServer((h) => h === "Bearer access-2");
    const transport = fetchTransport(resource.url, {}, source(ENV));
    const res = await transport.request("PUT", "/cal/e.ics", "BEGIN:VCALENDAR");
    await resource.close();
    expect(res.status).toBe(207);
    expect(resource.seen).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("gives up after one retry rather than looping on a dead credential", async () => {
    const resource = await resourceServer(() => false);
    const transport = fetchTransport(resource.url, {}, source(ENV));
    const res = await transport.request("GET", "/cal");
    await resource.close();
    expect(res.status).toBe(401);
    expect(resource.seen).toHaveLength(2);
  });

  it("does not retry a 403, which is the sync-token signal", async () => {
    const seen: number[] = [];
    const server = createServer((_req, res) => {
      seen.push(1);
      res.writeHead(403);
      res.end("x");
    });
    const url = await listen(server);
    const res = await fetchTransport(url, {}, source(ENV)).request("REPORT", "/cal");
    await new Promise<void>((r) => server.close(() => r()));
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("without an auth source sends no Authorization header (unchanged behaviour)", async () => {
    const resource = await resourceServer(() => true);
    await fetchTransport(resource.url).request("GET", "/cal");
    await resource.close();
    expect(resource.seen).toEqual([undefined]);
  });
});
