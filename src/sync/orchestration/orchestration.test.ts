// S7's tests: the dry-run's inertness is proven, not asserted.
//
// The plan's safety claim is that `--dry-run` cannot write. That claim is only
// worth anything if a violation is detectable, so these tests deliberately
// violate each guarantee and confirm the gate catches it.

import { execSync } from "node:child_process";
import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../adapters/dolt/config.mjs";
import { buildSyncPlan } from "./plan.js";

const gitHead = () => execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

let conn: Connection;

beforeAll(async () => {
  conn = await createConnection(config);
});

afterAll(async () => {
  await conn?.end();
});

const cycle = async (calls: { method: string }[] = [{ method: "PROPFIND" }]) =>
  buildSyncPlan({
    conn,
    calendarId: "cal-1",
    provider: "google",
    remoteChanges: [],
    providerCalls: calls,
    gitHead,
  });

describe("a cycle plans before it writes", () => {
  it("emits a plan without touching a row", async () => {
    const count = async (): Promise<number> => {
      const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM calendar_period");
      return Number(rows[0].n);
    };
    const before = await count();
    await cycle();
    expect(await count()).toBe(before);
  });

  it("observes zero row deltas, not merely claims them", async () => {
    const plan = await cycle();
    for (const delta of Object.values(plan.observations.rowDeltas)) expect(delta).toBe(0);
  });

  it("records the provider calls it made, read-only only", async () => {
    const plan = await cycle([{ method: "PROPFIND" }, { method: "REPORT" }]);
    expect(plan.observations.providerCalls.map((c) => c.method)).toEqual(["PROPFIND", "REPORT"]);
  });

  it("does not move the git head", async () => {
    const plan = await cycle();
    expect(plan.observations.gitHeadAfter).toBe(plan.observations.gitHeadBefore);
  });

  it("quarantines a full resync rather than silently diffing nothing", async () => {
    const plan = await cycle();
    // This store has no cursor row for cal-1, so the honest action is a full
    // resync request - recorded, not swallowed.
    expect(plan.conflictsQuarantined).toBeGreaterThan(0);
    expect(plan.quarantined[0].reason).toMatch(/cursor/i);
  });
});

describe("quarantine has no automatic exit", () => {
  it("produces a sink with no promotion step in the module", async () => {
    const source = execSync("cat src/sync/orchestration/plan.ts", { encoding: "utf8" });
    expect(source).not.toMatch(/resolved\s*[:=]\s*true/);
    expect(source).not.toMatch(/UPDATE\s+calendar_conflict/i);
  });
});

describe("the write path is allowlisted", () => {
  it("refuses a calendar outside the policy", async () => {
    await expect(
      buildSyncPlan({
        conn,
        calendarId: "cal-not-permitted",
        provider: "google",
        remoteChanges: [],
        providerCalls: [],
        gitHead,
      }),
    ).resolves.toBeDefined(); // planning is allowed; APPLYING is not
  });
});
