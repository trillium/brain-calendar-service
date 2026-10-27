// The soak recorder and the report that reads what it writes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSoakRound } from "./soak.js";

const ROOT = resolve(import.meta.dirname, "../../..");
let dir: string;
const file = () => join(dir, "evidence", "soak", "report.json");

/** The report script reads a path relative to its working directory, as `pnpm run` runs it. */
const report = () =>
  spawnSync(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "scripts/sync-soak-report.mts")], {
    cwd: dir,
    encoding: "utf8",
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soak-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recordSoakRound", () => {
  it("creates the report and directory on the first round", () => {
    expect(existsSync(file())).toBe(false);
    const round = recordSoakRound(file(), { conflicts: 0, quarantined: 0, pushes: 2, pulls: 0 });
    expect(round).toEqual({ round: 1, conflicts: 0, quarantined: 0, pushes: 2, pulls: 0 });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({
      rounds: 1,
      conflictsPerRound: [0],
      quarantined: 0,
    });
  });

  it("appends each round and keeps the shape sync:soak-report reads", () => {
    recordSoakRound(file(), { conflicts: 0, quarantined: 0, pushes: 1, pulls: 0 });
    recordSoakRound(file(), { conflicts: 1, quarantined: 1, pushes: 0, pulls: 0 });
    recordSoakRound(file(), { conflicts: 0, quarantined: 1, pushes: 0, pulls: 1 });
    const saved = JSON.parse(readFileSync(file(), "utf8"));
    expect(saved).toMatchObject({ rounds: 3, conflictsPerRound: [0, 1, 0], quarantined: 1 });
    expect(saved.roundLog).toEqual([
      { round: 1, conflicts: 0, quarantined: 0, pushes: 1, pulls: 0 },
      { round: 2, conflicts: 1, quarantined: 1, pushes: 0, pulls: 0 },
      { round: 3, conflicts: 0, quarantined: 1, pushes: 0, pulls: 1 },
    ]);
  });

  it("refuses to overwrite a report it cannot read", () => {
    mkdirSync(join(dir, "evidence", "soak"), { recursive: true });
    writeFileSync(file(), '{"rounds":"three"}');
    expect(() =>
      recordSoakRound(file(), { conflicts: 0, quarantined: 0, pushes: 0, pulls: 0 }),
    ).toThrow();
    expect(readFileSync(file(), "utf8")).toBe('{"rounds":"three"}');
  });
});

describe("sync:soak-report", () => {
  it("fails honestly when no round was ever recorded", () => {
    const result = report();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no soak report exists/);
  });

  it("passes on evidence the recorder wrote", () => {
    recordSoakRound(file(), { conflicts: 0, quarantined: 0, pushes: 1, pulls: 0 });
    recordSoakRound(file(), { conflicts: 0, quarantined: 0, pushes: 0, pulls: 1 });
    const result = report();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/rounds: 2/);
    expect(result.stdout).toMatch(/sync:soak-report PASSED/);
  });
});
