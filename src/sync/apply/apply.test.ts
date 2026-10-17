// L3's tests: the apply step, against a REAL disposable Dolt and a FAKE provider.
//
// The provider is an in-memory fake on purpose. Nothing here contacts a calendar,
// and nothing here says anything about how a real provider behaves - that is
// UNVERIFIED. What is proven is the apply step's own contract: it writes through
// the interface, honours the SyncPolicy, never deletes, holds the cursor back
// when it cannot finish, and converges when it can.
//
// Each run builds its own database on the disposable server (port 3399) and
// drops it afterwards, so it neither depends on nor disturbs the shared store.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2";
import { type Connection, createConnection } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config, ROOT } from "../../adapters/dolt/config.mjs";
import { allow, type SyncPolicy } from "../loop/policy.js";
import { buildSyncPlan, type SyncPlan } from "../orchestration/plan.js";
import { applyPlan } from "./apply.js";
import type { ApplyContext } from "./context.js";
import type { CalendarProvider, EventPayload } from "./provider.js";

const DB = `apply_test_${process.pid}`;
const CAL = "1";

class FakeProvider implements CalendarProvider {
  readonly events = new Map<string, { payload: EventPayload; etag: number }>();
  readonly calls: string[] = [];
  failWith: Error | null = null;

  async insert(_cal: string, uid: string, payload: EventPayload) {
    this.calls.push(`insert ${uid}`);
    if (this.failWith) throw this.failWith;
    const existing = this.events.get(uid);
    if (existing) return { externalUid: uid, etag: `e${existing.etag}`, created: false };
    this.events.set(uid, { payload, etag: 1 });
    return { externalUid: uid, etag: "e1", created: true };
  }

  async update(_cal: string, uid: string, payload: EventPayload, ifMatch: string | null) {
    this.calls.push(`update ${uid}`);
    if (this.failWith) throw this.failWith;
    const current = this.events.get(uid);
    if (!current) throw new Error(`no such event ${uid}`);
    if (ifMatch !== `e${current.etag}`) throw new Error("etag mismatch");
    this.events.set(uid, { payload, etag: current.etag + 1 });
    return { externalUid: uid, etag: `e${current.etag + 1}` };
  }
}

let admin: Connection;
let conn: Connection;
let provider: FakeProvider;
let tokens = 0;

const ctx = (policy?: SyncPolicy): ApplyContext => ({
  conn,
  provider,
  policy:
    policy ??
    allow("google", [
      [CAL, "INSERT"],
      [CAL, "UPDATE"],
    ]),
  calendarId: CAL,
  now: () => "2026-10-17 12:00:00",
  mintToken: () => `token-${++tokens}`,
});

const head = async (): Promise<string> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1",
  );
  return rows[0].commit_hash as string;
};

const commit = async (message: string): Promise<void> => {
  await conn.query("CALL DOLT_ADD('.')");
  await conn.query("CALL DOLT_COMMIT('--allow-empty', '-m', ?)", [message]);
};

const cursor = async (): Promise<string | null> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT last_synced_commit_hash AS h FROM calendar_sync_cursor WHERE calendar_id = ?",
    [CAL],
  );
  return (rows[0]?.h as string | undefined) ?? null;
};

const plan = (): Promise<SyncPlan> =>
  buildSyncPlan({
    conn,
    calendarId: CAL,
    provider: "google",
    remoteChanges: [],
    providerCalls: [],
    gitHead: () => null,
    dryRun: false,
  }).then((p) => ({
    ...p,
    push: p.push.map((x, i) => ({ ...x, idempotencyKey: `${x.beadId}:${i}` })),
  }));

const seedPeriod = async (bead: string, start: string, end: string, summary = "Standup") => {
  await conn.query(
    `INSERT INTO calendar_period
       (grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json, created_at, updated_at)
     VALUES ('day', ?, ?, ?, ?, '2026-10-17 00:00:00', '2026-10-17 00:00:00')`,
    [start, end, bead, JSON.stringify({ summary })],
  );
};

const count = async (table: string, where = "1=1"): Promise<number> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
  );
  return Number(rows[0].n);
};

beforeAll(async () => {
  admin = await createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });
  await admin.query(`CREATE DATABASE \`${DB}\``);
  conn = await createConnection({ ...config, database: DB, multipleStatements: true });
  const migration = readFileSync(
    join(ROOT, "migrations", "1_calendar_service_initial_schema.sql"),
    "utf8",
  );
  await conn.query(migration);
  await commit("schema");
});

afterAll(async () => {
  await conn?.end();
  await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin?.end();
});

beforeEach(async () => {
  provider = new FakeProvider();
  for (const t of [
    "calendar_period",
    "calendar_binding",
    "calendar_conflict",
    "calendar_sync_cursor",
  ]) {
    await conn.query(`DELETE FROM ${t}`);
  }
  await commit("reset");
  await conn.query(
    `INSERT INTO calendar_sync_cursor
       (source_database, calendar_id, last_synced_commit_hash, last_round_at, created_at, updated_at)
     VALUES ('brain_calendar_service', ?, ?, '2026-10-17 00:00:00', '2026-10-17 00:00:00', '2026-10-17 00:00:00')`,
    [CAL, await head()],
  );
});

describe("push: INSERT then UPDATE through the provider", () => {
  it("inserts a new event, binds it with an ownership token, and advances the cursor", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    const p = await plan();
    expect(p.push).toHaveLength(1);

    const result = await applyPlan(ctx(), p);

    expect(result.outcomes).toMatchObject([{ kind: "applied", op: "INSERT" }]);
    expect(provider.events.get("bead-1@brain-calendar-service")?.payload).toEqual({
      summary: "Standup",
      startUtc: "2026-04-01T09:00:00Z",
      endUtc: "2026-04-01T09:15:00Z",
    });
    expect(await count("calendar_binding", "ownership_token = 'token-1'")).toBe(1);
    expect(await cursor()).toBe(result.committedHash);
    expect(result.cursorAdvancedTo).toBe(result.committedHash);
  });

  it("converges: planning again after a clean apply finds nothing to do", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    await applyPlan(ctx(), await plan());
    const again = await plan();
    expect(again.push).toHaveLength(0);
    const result = await applyPlan(ctx(), again);
    expect(result.outcomes).toHaveLength(0);
    expect(provider.calls).toHaveLength(1);
  });

  it("updates, not duplicates, when the bead is already bound", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    await applyPlan(ctx(), await plan());

    await conn.query("UPDATE calendar_period SET period_end_utc = '2026-04-01 09:45:00'");
    await commit("lengthen");
    const result = await applyPlan(ctx(), await plan());

    expect(result.outcomes).toMatchObject([{ kind: "applied", op: "UPDATE" }]);
    expect(provider.events.size).toBe(1);
    expect(provider.events.get("bead-1@brain-calendar-service")?.payload.endUtc).toBe(
      "2026-04-01T09:45:00Z",
    );
    expect(await count("calendar_binding", "external_sequence = 1")).toBe(1);
  });

  it("is idempotent when a crashed run is replayed against the same plan", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    const p = await plan();
    // The provider took the INSERT, then the process died before the binding landed.
    await provider.insert(CAL, "bead-1@brain-calendar-service", {
      summary: "Standup",
      startUtc: "2026-04-01T09:00:00Z",
      endUtc: "2026-04-01T09:15:00Z",
    });
    await applyPlan(ctx(), p);
    expect(provider.events.size).toBe(1);
    expect(await count("calendar_binding")).toBe(1);
  });
});

describe("the SyncPolicy allowlist holds", () => {
  it("refuses an INSERT the policy does not permit, and never calls the provider", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    const before = await cursor();
    const result = await applyPlan(ctx(allow("google", [[CAL, "UPDATE"]])), await plan());
    expect(result.outcomes).toMatchObject([{ kind: "refused" }]);
    expect(provider.calls).toHaveLength(0);
    expect(await cursor()).toBe(before);
    expect(result.cursorAdvancedTo).toBeNull();
  });

  it("refuses an UPDATE the policy does not permit, and never calls the provider", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    await applyPlan(ctx(), await plan());
    provider.calls.length = 0;
    await conn.query("UPDATE calendar_period SET period_end_utc = '2026-04-01 09:45:00'");
    await commit("lengthen");

    const result = await applyPlan(ctx(allow("google", [[CAL, "INSERT"]])), await plan());

    expect(result.outcomes).toMatchObject([{ kind: "refused" }]);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses a calendar that is not in the allowlist at all", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    const result = await applyPlan(ctx(allow("google", [["99", "INSERT"]])), await plan());
    expect(result.outcomes).toMatchObject([{ kind: "refused" }]);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("destructive deletes stay behind the human gate", () => {
  const seedAndBind = async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    await applyPlan(ctx(), await plan());
    provider.calls.length = 0;
  };

  it("quarantines a local deletion instead of deleting, even if the policy permits DELETE", async () => {
    await seedAndBind();
    await conn.query("DELETE FROM calendar_period");
    await commit("delete period");
    const permissive = allow("google", [
      [CAL, "INSERT"],
      [CAL, "UPDATE"],
      [CAL, "DELETE"],
    ]);
    const before = await cursor();

    const result = await applyPlan(ctx(permissive), await plan());

    expect(result.outcomes).toMatchObject([{ kind: "refused" }]);
    expect(provider.calls).toHaveLength(0);
    expect(provider.events.size).toBe(1);
    expect(
      await count("calendar_conflict", "reason = 'local_delete_needs_human' AND resolved = 0"),
    ).toBe(1);
    expect(await cursor()).toBe(before);
  });

  it("does not stack a second quarantine row when the same deletion is re-planned", async () => {
    await seedAndBind();
    await conn.query("DELETE FROM calendar_period");
    await commit("delete period");
    await applyPlan(ctx(), await plan());
    await applyPlan(ctx(), await plan());
    expect(await count("calendar_conflict")).toBe(1);
  });

  it("exposes no delete on the provider interface", () => {
    expect(Object.getOwnPropertyNames(FakeProvider.prototype)).not.toContain("delete");
    const source = readFileSync(join(ROOT, "src/sync/apply/provider.ts"), "utf8");
    expect(source).not.toMatch(/^\s+(delete|remove)\(/m);
  });
});

describe("failure holds the cursor back", () => {
  it("reports a provider error as failed, leaves the cursor, and recovers on retry", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    const before = await cursor();
    provider.failWith = new Error("provider down");

    const failed = await applyPlan(ctx(), await plan());
    expect(failed.outcomes).toMatchObject([{ kind: "failed", error: "provider down" }]);
    expect(await cursor()).toBe(before);
    expect(await count("calendar_binding")).toBe(0);

    provider.failWith = null;
    const retried = await applyPlan(ctx(), await plan());
    expect(retried.outcomes).toMatchObject([{ kind: "applied", op: "INSERT" }]);
    expect(provider.events.size).toBe(1);
    expect(await cursor()).toBe(retried.committedHash);
  });

  it("refuses to start over uncommitted local edits rather than committing them without pushing", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    const p = await plan();
    await seedPeriod("bead-2", "2026-04-02 09:00:00", "2026-04-02 09:15:00"); // never committed
    const result = await applyPlan(ctx(), p);
    expect(result.outcomes).toMatchObject([{ kind: "failed", key: "preflight" }]);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("pull: a winning remote change lands locally", () => {
  const pullPlan = (uid: string): SyncPlan => ({
    calendarId: CAL,
    dryRun: false,
    cursorBefore: null,
    cursorAfter: null,
    push: [],
    pull: [
      {
        beadId: "",
        externalUid: uid,
        reason: "higher_sequence",
        idempotencyKey: `${uid}:0`,
        payload: { startUtc: "2026-04-01T10:00:00Z", endUtc: "2026-04-01T10:30:00Z" },
        etag: "remote-etag",
        sequence: 3,
      },
    ],
    quarantined: [],
    conflictsQuarantined: 0,
    observations: { rowDeltas: {}, providerCalls: [], gitHeadBefore: null, gitHeadAfter: null },
  });

  it("writes the remote times and sequence onto the bound bead, with no provider call", async () => {
    await seedPeriod("bead-1", "2026-04-01 09:00:00", "2026-04-01 09:15:00");
    await commit("add period");
    await applyPlan(ctx(), await plan());
    provider.calls.length = 0;

    const result = await applyPlan(ctx(), pullPlan("bead-1@brain-calendar-service"));

    expect(result.outcomes).toMatchObject([{ kind: "applied", op: "PULL" }]);
    expect(provider.calls).toHaveLength(0);
    expect(await count("calendar_period", "period_start_utc = '2026-04-01 10:00:00'")).toBe(1);
    expect(
      await count("calendar_binding", "external_sequence = 3 AND last_synced_etag = 'remote-etag'"),
    ).toBe(1);
    expect((await plan()).push).toHaveLength(0); // its own write is not re-pushed
  });

  it("does not invent a record for an event no bead is bound to", async () => {
    const result = await applyPlan(ctx(), pullPlan("stranger@elsewhere"));
    expect(result.outcomes).toMatchObject([{ kind: "skipped" }]);
    expect(await count("calendar_period")).toBe(0);
  });
});
