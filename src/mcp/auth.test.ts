import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthConfigError, bearerMatches, loadAuthToken } from "./auth.js";

const TOKEN = "a".repeat(64);

describe("bearerMatches", () => {
  it("accepts exactly the configured token", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("treats the scheme case-insensitively, as RFC 7235 does", () => {
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["the bare token", TOKEN],
    ["another scheme", `Basic ${TOKEN}`],
    ["a wrong token of the same length", `Bearer ${"b".repeat(64)}`],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, 63)}`],
    ["the token plus a suffix", `Bearer ${TOKEN}x`],
    ["a token with trailing words", `Bearer ${TOKEN} extra`],
    ["an empty token", "Bearer "],
  ])("rejects %s", (_name, header) => {
    expect(bearerMatches(header, TOKEN)).toBe(false);
  });
});

describe("loadAuthToken", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "mcp-auth-"));
  const tokenFile = (content: string, mode: number) => {
    const file = join(scratch(), "token");
    writeFileSync(file, content);
    chmodSync(file, mode);
    return file;
  };

  it("fails closed when nothing is configured", () => {
    expect(() => loadAuthToken({})).toThrow(AuthConfigError);
    expect(() => loadAuthToken({})).toThrow(/no MCP auth token/);
  });

  it("reads MCP_AUTH_TOKEN and trims it", () => {
    expect(loadAuthToken({ MCP_AUTH_TOKEN: `${TOKEN}\n` })).toBe(TOKEN);
  });

  it("reads a 0600 file", () => {
    expect(loadAuthToken({ MCP_AUTH_TOKEN_FILE: tokenFile(`${TOKEN}\n`, 0o600) })).toBe(TOKEN);
  });

  it("refuses a token file other users can read", () => {
    const file = tokenFile(TOKEN, 0o644);
    expect(() => loadAuthToken({ MCP_AUTH_TOKEN_FILE: file })).toThrow(/chmod 600/);
  });

  it("refuses a short token, so a placeholder cannot protect anything", () => {
    expect(() => loadAuthToken({ MCP_AUTH_TOKEN: "hunter2" })).toThrow(/shorter than 32/);
  });

  it("refuses a token with embedded whitespace", () => {
    expect(() => loadAuthToken({ MCP_AUTH_TOKEN: `${"a".repeat(20)} ${"a".repeat(20)}` })).toThrow(
      /whitespace/,
    );
  });

  it("refuses an ambiguous pair rather than picking one silently", () => {
    const file = tokenFile(TOKEN, 0o600);
    expect(() => loadAuthToken({ MCP_AUTH_TOKEN: TOKEN, MCP_AUTH_TOKEN_FILE: file })).toThrow(
      /not both/,
    );
  });

  it("never echoes the token in an error", () => {
    try {
      loadAuthToken({ MCP_AUTH_TOKEN: "short-secret" });
    } catch (error) {
      expect(String(error)).not.toContain("short-secret");
    }
  });
});
