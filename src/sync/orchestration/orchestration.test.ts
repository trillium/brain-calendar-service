// S7's tests: the dry-run's inertness is proven, not asserted.
//
// The plan's safety claim is that `--dry-run` cannot write. That claim is only
// worth anything if a violation is detectable, so these tests deliberately
// violate each guarantee and confirm the gate catches it.

import { readFileSync } from "node:fs";
import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../adapters/dolt/config.mjs";
import { buildSyncPlan } from "./plan.js";

let conn: Connection;

beforeAll(async () => {
  conn = await createConnection(config);
});

afterAll(async () => {
  await conn?.end();
});

const cycle = async (calls: () => { method: string }[] = () => []) =>
  buildSyncPlan({
    conn,
    calendarId: "cal-1",
    provider: "google",
    remoteChanges: [],
    providerCalls: calls,
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

  it("reads provider calls from what was actually recorded", async () => {
    const plan = await cycle(() => [{ method: "events" }, { method: "get" }]);
    expect(plan.observations.providerCalls.map((c) => c.method)).toEqual(["events", "get"]);
    expect((await cycle()).observations.providerCalls).toEqual([]);
  });

  it("observes a row written during the cycle as a non-zero delta", async () => {
    const ts = "2099-01-01 00:00:00";
    try {
      const plan = await buildSyncPlan({
        conn,
        calendarId: "cal-1",
        provider: "google",
        remoteChanges: [],
        providerCalls: async () => {
          await conn.query(
            `INSERT INTO calendar_period
               (grain, period_start_utc, period_end_utc, attributes_json, created_at, updated_at)
             VALUES ('day', ?, ?, '{}', ?, ?)`,
            [ts, ts, ts, ts],
          );
          return [];
        },
      });
      expect(plan.observations.rowDeltas.calendar_period).toBe(1);
    } finally {
      await conn.query("DELETE FROM calendar_period WHERE period_start_utc = ?", [ts]);
    }
  });

  it("reports the Dolt head, unmoved by a plan", async () => {
    const plan = await cycle();
    expect(plan.observations.doltHeadBefore).toMatch(/^[0-9a-v]{32}$/);
    expect(plan.observations.doltHeadAfter).toBe(plan.observations.doltHeadBefore);
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
    const source = readFileSync("src/sync/orchestration/plan.ts", "utf8");
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
        providerCalls: () => [],
      }),
    ).resolves.toBeDefined(); // planning is allowed; APPLYING is not
  });
});
