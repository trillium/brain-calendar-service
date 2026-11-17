import { describe, expect, it } from "vitest";
import { gogPreflight } from "./preflight.js";
import { GogError, type GogRunner } from "./runner.js";

const calls: (readonly string[])[] = [];
const scripted =
  (version: string, listing: () => string): GogRunner =>
  async (args) => {
    calls.push(args);
    return { stdout: args.includes("--version") ? version : listing(), stderr: "" };
  };

describe("gogPreflight", () => {
  it("is ready when gog lists calendars, and asks gog to block writes while doing so", async () => {
    calls.length = 0;
    const result = await gogPreflight(
      scripted("v0.48.0", () => '{"calendars":[{"id":"a"},{"id":"b"}]}'),
      "me@example.com",
    );
    expect(result).toEqual({ state: "ready", version: "v0.48.0", calendars: 2 });
    expect(calls[1]).toEqual([
      "-a",
      "me@example.com",
      "--json",
      "--readonly",
      "calendar",
      "calendars",
    ]);
  });

  it("accepts a bare array too", async () => {
    const result = await gogPreflight(
      scripted("v1", () => '[{"id":"a"}]'),
      "me@example.com",
    );
    expect(result).toMatchObject({ state: "ready", calendars: 1 });
  });

  it("names the fix when gog has no token", async () => {
    const runner: GogRunner = async (args) => {
      if (args.includes("--version")) return { stdout: "v0.48.0", stderr: "" };
      throw new GogError("gog failed", 1, "No tokens stored\n");
    };
    const result = await gogPreflight(runner, "me@example.com");
    expect(result.state).toBe("not-authenticated");
    expect(result).toMatchObject({ message: expect.stringContaining("gog auth add") });
  });

  it("names the credentials import when gog has no OAuth client, the state this host is in", async () => {
    const runner: GogRunner = async (args) => {
      if (args.includes("--version")) return { stdout: "v0.48.0", stderr: "" };
      throw new GogError(
        "gog failed (10)",
        10,
        "OAuth client credentials missing (OAuth client ID JSON).\nThen run: gog auth credentials <credentials.json>",
      );
    };
    const result = await gogPreflight(runner, "me@example.com");
    expect(result.state).toBe("missing-client");
    expect(result).toMatchObject({ message: expect.stringContaining("gog auth credentials") });
  });

  it("recognizes a missing binary whether it surfaces as a GogError or a plain error", async () => {
    const wrapped: GogRunner = async () => {
      throw new GogError("gog --version failed (ENOENT): ", null, "");
    };
    expect((await gogPreflight(wrapped, "me@example.com")).state).toBe("missing-binary");
  });

  it("says so when the gog binary is missing", async () => {
    const runner: GogRunner = async () => {
      throw new Error("spawn gog ENOENT");
    };
    expect((await gogPreflight(runner, "me@example.com")).state).toBe("missing-binary");
  });

  it("does not call a garbled answer ready", async () => {
    const result = await gogPreflight(
      scripted("v1", () => "not json"),
      "me@example.com",
    );
    expect(result.state).toBe("unreadable");
  });

  it("reports any other gog failure as failed, not as an authentication problem", async () => {
    const runner: GogRunner = async () => {
      throw new GogError("gog calendar failed (1): quota exceeded", 1, "quota exceeded");
    };
    expect((await gogPreflight(runner, "me@example.com")).state).toBe("failed");
  });
});
