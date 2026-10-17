// L5 and L6: a test run must not dirty tracked files, and a scoped test command
// must run only its scope. Both are checked by running the real command.

import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROOT } from "../adapters/dolt/config.mjs";

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

const scoped = (...args: string[]) => {
  const run = spawnSync("node", ["scripts/vitest.mjs", ...args, "--reporter=json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const json = run.stdout.slice(run.stdout.indexOf("{"));
  return JSON.parse(json) as { numTotalTestSuites: number; testResults: { name: string }[] };
};

describe("scoped test command", () => {
  it("narrows to the requested path, with or without pnpm's separator", () => {
    for (const lead of [[], ["--"]]) {
      const out = scoped(...lead, "--run", "src/mcp/list-changes");
      expect(out.testResults).toHaveLength(1);
      expect(out.testResults[0].name).toMatch(/src\/mcp\/list-changes\.test\.ts$/);
    }
  }, 60_000);
});

describe("test run hygiene", () => {
  it("running the evidence-emitting suite leaves tracked files unchanged", () => {
    const before = git("status", "--porcelain");
    const out = scoped("--run", "src/domain/rfc5546/emit-artifact");
    expect(out.testResults).toHaveLength(1);
    expect(git("status", "--porcelain")).toBe(before);
  }, 60_000);
});
