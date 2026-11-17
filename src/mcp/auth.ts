// Bearer-token check for the HTTP MCP surface.
//
// The stdio entry needs no token: the client that spawned it already owns the
// process. A listening socket is different - anything that can reach the port can
// call propose_day and move_commitment - so the HTTP surface refuses to start
// without a token, and refuses every request that does not carry it.
//
// The token is never logged and never compared with `===`: both sides are hashed
// to a fixed width first so timingSafeEqual sees equal lengths, which also keeps
// the token's length from leaking through response time.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** 32 characters is 128 bits for hex, the shape `openssl rand -hex 32` produces. */
const MIN_TOKEN_LENGTH = 32;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** True only when `header` is `Bearer <expected>`. Scheme match is case-insensitive (RFC 7235). */
export const bearerMatches = (header: string | undefined, expected: string): boolean => {
  if (header === undefined) return false;
  const match = /^Bearer +(\S+)$/i.exec(header);
  if (match === null) return false;
  return timingSafeEqual(digest(match[1] ?? ""), digest(expected));
};

const validate = (token: string, source: string): string => {
  const trimmed = token.trim();
  if (trimmed.length < MIN_TOKEN_LENGTH) {
    throw new AuthConfigError(
      `${source} is shorter than ${MIN_TOKEN_LENGTH} characters; generate one with: openssl rand -hex 32`,
    );
  }
  if (/\s/.test(trimmed)) throw new AuthConfigError(`${source} must not contain whitespace`);
  return trimmed;
};

/**
 * The token comes from MCP_AUTH_TOKEN_FILE (preferred: a 0600 file keeps it out of
 * the process table and the launchd plist) or MCP_AUTH_TOKEN. Naming both is an
 * error rather than a silent precedence rule.
 */
export const loadAuthToken = (env: NodeJS.ProcessEnv): string => {
  const file = env.MCP_AUTH_TOKEN_FILE;
  const inline = env.MCP_AUTH_TOKEN;
  if (file && inline) {
    throw new AuthConfigError("set MCP_AUTH_TOKEN_FILE or MCP_AUTH_TOKEN, not both");
  }
  if (file) {
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) {
      throw new AuthConfigError(`${file} is readable by group or others; chmod 600 it`);
    }
    return validate(readFileSync(file, "utf8"), "MCP_AUTH_TOKEN_FILE");
  }
  if (inline) return validate(inline, "MCP_AUTH_TOKEN");
  throw new AuthConfigError(
    "no MCP auth token: set MCP_AUTH_TOKEN_FILE (a 0600 file) or MCP_AUTH_TOKEN",
  );
};
