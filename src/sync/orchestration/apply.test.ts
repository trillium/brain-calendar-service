// Stage B: the push apply path, against a real (disposable) Dolt database and the
// stateful fake gog. No real gog and no real calendar is ever reached.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RowDataPacket } from "mysql2";
import { type Connection, createConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RegisteredCalendar,
  registerCalendar,
} from "../../adapters/dolt/calendar-registry.js";
import { config } from "../../adapters/dolt/config.mjs";
import { createDoltStore } from "../../adapters/dolt/mcp-store.js";
import { createGogProvider } from "../../adapters/gog/provider.js";
import type { CalendarProvider } from "../../adapters/provider.js";
import type { Store } from "../../mcp/store.js";
import { createTestDatabase, type TestDatabase } from "../../mcp/test-db.js";
import { PolicyViolation } from "../loop/policy.js";
import { type ApplyResult, applyPlan, pushPolicy } from "./apply.js";
import { MARKER_KEY, OWNER_KEY } from "./apply-draft.js";
import { buildSyncPlan, SOURCE_DATABASE } from "./plan.js";

const FAKE = resolve(import.meta.dirname, "../../../fixtures/gog/fake-gog.mjs");
const THROWAWAY = "bcs-throwaway@group.calendar.google.com";
const MASSAGE = "massage@group.calendar.google.com";

let db: TestDatabase;
let conn: Connection;
let store: Store;
let dir: string;
let throwaway: RegisteredCalendar;
let massage: RegisteredCalendar;

const state = () => {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch {
    return { calls: {}, calendars: {} };
  }
};
const argvLog = (): string[][] =>
  readFileSync(join(dir, "calls.log"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
const remoteEvents = (calendar: string) =>
  Object.values(state().calendars[calendar] ?? {}) as {
    id: string;
    summary: string;
    start: { dateTime: string };
    extendedProperties: { private: Record<string, string> };
  }[];

const provider = (): CalendarProvider =>
  createGogProvider({ account: "t@example.invalid", bin: FAKE });

const headHash = async (): Promise<string> => {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT DOLT_HASHOF('HEAD') AS h");
  return String(rows[0]?.h);
};
const cursor = async (): Promise<string> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT last_synced_commit_hash AS h FROM calendar_sync_cursor WHERE calendar_id = ?",
    [throwaway.id],
  );
  return String(rows[0]?.h);
};

const day = (n: number, summary: string) => ({
  grain: "day" as const,
  startUtc: `2026-04-0${n}T10:00:00Z`,
  endUtc: `2026-04-0${n}T11:00:00Z`,
  summary,
});

/** One round: plan, then apply to the throwaway calendar. */
const round = async (
  over: {
    provider?: CalendarProvider;
    policy?: ReturnType<typeof pushPolicy>;
    conn?: Connection;
  } = {},
) => {
  const plan = await buildSyncPlan({
    conn,
    calendarId: String(throwaway.id),
    provider: "google",
    remoteChanges: [],
    providerCalls: () => [],
    dryRun: false,
  });
  const result = await applyPlan({
    conn: over.conn ?? conn,
    provider: over.provider ?? provider(),
    plan,
    policy: over.policy ?? pushPolicy("google", THROWAWAY),
    calendar: { id: throwaway.id, remoteCalendarId: THROWAWAY },
    sourceDatabase: SOURCE_DATABASE,
  });
  return { plan, result };
};

const failedOf = (result: ApplyResult) => {
  if (result.state !== "failed") throw new Error("expected a failed round");
  return result;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "apply-"));
  process.env.FAKE_GOG_STATE = join(dir, "state.json");
  process.env.FAKE_GOG_LOG = join(dir, "calls.log");
  process.env.FAKE_GOG_FAIL_NTH = "";
  process.env.FAKE_GOG_FAIL = "";
  db = await createTestDatabase();
  // No dateStrings, as in sync:once: DATETIME columns arrive as local-zone Dates.
  conn = await createConnection({ ...config, database: db.name });
  await conn.query("CALL DOLT_ADD('-A')");
  await conn.query("CALL DOLT_COMMIT('-m', 'schema')");
  store = createDoltStore(db.name);
  throwaway = await registerCalendar(conn, {
    provider: "google",
    remoteCalendarId: THROWAWAY,
    displayName: "throwaway",
  });
  massage = await registerCalendar(conn, {
    provider: "google",
    remoteCalendarId: MASSAGE,
    displayName: "massage",
  });
  const ts = "2026-04-01 00:00:00";
  await conn.query(
    `INSERT INTO calendar_sync_cursor
       (source_database, calendar_id, last_synced_commit_hash, last_round_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [SOURCE_DATABASE, throwaway.id, await headHash(), ts, ts, ts],
  );
});

afterEach(async () => {
  await store.close();
  await conn.end();
  await db.drop();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ["FAKE_GOG_STATE", "FAKE_GOG_LOG", "FAKE_GOG_FAIL_NTH", "FAKE_GOG_FAIL"]) {
    process.env[k] = "";
  }
});

describe("create", () => {
  it("creates once, records a binding with a minted token, and a re-run creates nothing", async () => {
    await store.addPeriods([day(1, "standup"), day(2, "review")]);
    const first = await round();
    expect(first.plan.push).toHaveLength(2);
    expect(first.result).toMatchObject({ state: "ok", created: 2, updated: 0, adopted: 0 });
    expect(state().calls.create).toBe(2);
    expect(
      remoteEvents(THROWAWAY)
        .map((e) => e.summary)
        .sort(),
    ).toEqual(["review", "standup"]);

    const [bindings] = await conn.query<RowDataPacket[]>(
      "SELECT * FROM calendar_binding ORDER BY bead_id",
    );
    expect(bindings).toHaveLength(2);
    for (const b of bindings) {
      expect(b.calendar_id).toBe(throwaway.id);
      expect(b.ownership_token).toMatch(/^[0-9a-f]{48}$/);
      expect(b.last_synced_commit_hash).toMatch(/^[0-9a-v]{32}$/);
      expect(remoteEvents(THROWAWAY).map((e) => e.id)).toContain(b.external_uid);
    }
    expect(new Set(bindings.map((b) => b.ownership_token)).size).toBe(2);

    const second = await round();
    expect(second.plan.push).toHaveLength(0);
    expect(second.result).toMatchObject({ state: "ok", created: 0, updated: 0, adopted: 0 });
    expect(state().calls.create).toBe(2);
    expect(remoteEvents(THROWAWAY).find((e) => e.summary === "standup")?.start.dateTime).toBe(
      "2026-04-01T10:00:00Z",
    );
    expect(remoteEvents(THROWAWAY)).toHaveLength(2);
  });

  it("puts the idempotency marker and the same token on the remote event", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    const [event] = remoteEvents(THROWAWAY);
    const [binding] = (await conn.query<RowDataPacket[]>("SELECT * FROM calendar_binding"))[0];
    expect(event?.extendedProperties.private[MARKER_KEY]).toMatch(/:period:\d+$/);
    expect(event?.extendedProperties.private[OWNER_KEY]).toBe(binding?.ownership_token);
  });

  it("commits the binding to Dolt history so it is diffable", async () => {
    await store.addPeriods([day(1, "standup")]);
    const before = await headHash();
    await round();
    expect(await headHash()).not.toBe(before);
    const [diff] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM DOLT_DIFF(?, 'HEAD', 'calendar_binding') AS d",
      [before],
    );
    expect(Number(diff[0]?.n)).toBe(1);
    const [status] = await conn.query<RowDataPacket[]>(
      "SELECT table_name FROM dolt_status WHERE table_name = 'calendar_binding'",
    );
    expect(status).toHaveLength(0);
  });

  it("adopts a marked event whose listing omits the marker and whose start has an offset", async () => {
    await store.addPeriods([day(1, "standup")]);
    const [row] = (await conn.query<RowDataPacket[]>("SELECT id FROM calendar_period"))[0];
    await provider().createEvent(pushPolicy("google", THROWAWAY), THROWAWAY, {
      summary: "standup",
      from: "2026-04-01T03:00:00-07:00",
      to: "2026-04-01T04:00:00-07:00",
      privateProperties: {
        [MARKER_KEY]: `${SOURCE_DATABASE}:period:${row?.id}`,
        [OWNER_KEY]: "b".repeat(48),
      },
    });
    const real = provider();
    const lossy: CalendarProvider = {
      ...real,
      listEvents: async (calendarId, window) =>
        (await real.listEvents(calendarId, window)).map((e) => ({ ...e, privateProperties: {} })),
    };
    const { result } = await round({ provider: lossy });
    expect(result).toMatchObject({ state: "ok", created: 0, adopted: 1 });
    expect(state().calls.create).toBe(1);
    expect(remoteEvents(THROWAWAY)).toHaveLength(1);
    const [bindings] = await conn.query<RowDataPacket[]>("SELECT * FROM calendar_binding");
    expect(bindings[0]?.ownership_token).toBe("b".repeat(48));
  });

  it("adopts, not duplicates, a create whose binding failed even after the period moved", async () => {
    await store.addPeriods([day(1, "standup")]);
    const noBindings = new Proxy(conn, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "query") return typeof value === "function" ? value.bind(target) : value;
        return (sql: string, ...rest: unknown[]) =>
          sql.includes("INSERT INTO calendar_binding")
            ? Promise.reject(new Error("binding write lost"))
            : target.query(sql, ...(rest as []));
      },
    });
    const before = await cursor();
    const first = await round({ conn: noBindings });
    expect(failedOf(first.result)).toMatchObject({ kind: "store", created: 0 });
    expect(state().calls.create).toBe(1);
    expect(await cursor()).toBe(before);

    await store.movePeriod("standup", "2026-04-01T15:00:00Z");
    const { result } = await round();
    expect(result).toMatchObject({ state: "ok", created: 0, adopted: 1 });
    expect(state().calls.create).toBe(1);
    expect(remoteEvents(THROWAWAY)).toHaveLength(1);
    expect(remoteEvents(THROWAWAY)[0]?.start.dateTime).toBe("2026-04-01T15:00:00Z");
    const [bindings] = await conn.query<RowDataPacket[]>("SELECT * FROM calendar_binding");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.external_uid).toBe(remoteEvents(THROWAWAY)[0]?.id);
  });

  it("adopts an event that was created but never bound, instead of duplicating it", async () => {
    await store.addPeriods([day(1, "standup")]);
    const [row] = (await conn.query<RowDataPacket[]>("SELECT id FROM calendar_period"))[0];
    // The crash window: the create landed, the binding write did not.
    await provider().createEvent(pushPolicy("google", THROWAWAY), THROWAWAY, {
      summary: "standup",
      from: "2026-04-01T10:00:00Z",
      to: "2026-04-01T11:00:00Z",
      privateProperties: {
        [MARKER_KEY]: `${SOURCE_DATABASE}:period:${row?.id}`,
        [OWNER_KEY]: "a".repeat(48),
      },
    });
    const { result } = await round();
    expect(result).toMatchObject({ state: "ok", created: 0, adopted: 1 });
    expect(state().calls.create).toBe(1);
    expect(remoteEvents(THROWAWAY)).toHaveLength(1);
    const [bindings] = await conn.query<RowDataPacket[]>("SELECT * FROM calendar_binding");
    expect(bindings[0]?.ownership_token).toBe("a".repeat(48));
  });
});

describe("update", () => {
  it("updates the existing event for an edited period", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    const uid = remoteEvents(THROWAWAY)[0]?.id;
    await store.movePeriod("standup", "2026-04-01T15:00:00Z");

    const { plan, result } = await round();
    expect(plan.push).toHaveLength(1);
    expect(result).toMatchObject({ state: "ok", created: 0, updated: 1 });
    expect(state().calls.create).toBe(1);
    expect(remoteEvents(THROWAWAY)).toHaveLength(1);
    expect(remoteEvents(THROWAWAY)[0]).toMatchObject({
      id: uid,
      start: { dateTime: "2026-04-01T15:00:00Z" },
    });
    const [bindings] = await conn.query<RowDataPacket[]>("SELECT * FROM calendar_binding");
    expect(bindings[0]?.external_sequence).toBe(1);
    expect(bindings[0]?.external_uid).toBe(uid);

    expect((await round()).result).toMatchObject({ state: "ok", created: 0, updated: 0 });
  });

  it("reports a deleted period as not applied, keeps the cursor, and never sends a delete", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    await conn.query("DELETE FROM calendar_period");
    await conn.query("CALL DOLT_ADD('calendar_period')");
    await conn.query("CALL DOLT_COMMIT('-m', 'drop period')");
    const before = await cursor();
    const { plan, result } = await round();
    expect(result).toMatchObject({ state: "incomplete", created: 0, updated: 0 });
    expect(result.skipped).toEqual([
      { beadId: plan.push[0]?.beadId, reason: expect.stringMatching(/deletes are not applied/) },
    ]);
    expect(await cursor()).toBe(before);
    expect(argvLog().some((a) => a.includes("delete"))).toBe(false);
    expect(remoteEvents(THROWAWAY)).toHaveLength(1);

    const again = await round();
    expect(again.result.state).toBe("incomplete");
    expect(again.result.skipped).toHaveLength(1);
    expect(await cursor()).toBe(before);
  });
});

describe("the write path is deny-by-default", () => {
  it("cannot write to any calendar outside the policy, and delete is not representable", async () => {
    const policy = pushPolicy("google", THROWAWAY);
    const draft = { summary: "x", from: "2026-04-01T10:00:00Z", to: "2026-04-01T11:00:00Z" };
    await expect(provider().createEvent(policy, MASSAGE, draft)).rejects.toThrow(PolicyViolation);
    await expect(provider().updateEvent(policy, MASSAGE, "e1", draft)).rejects.toThrow(
      PolicyViolation,
    );
    await expect(provider().createEvent(policy, "primary", draft)).rejects.toThrow(PolicyViolation);
    await expect(provider().deleteEvent(policy, null, THROWAWAY, "e1")).rejects.toThrow(
      PolicyViolation,
    );
    expect(() => readFileSync(join(dir, "calls.log"))).toThrow();
  });

  it("returns a typed policy failure, writes nothing, and keeps the cursor", async () => {
    await store.addPeriods([day(1, "standup")]);
    const before = await cursor();
    const { result } = await round({ policy: pushPolicy("google", MASSAGE) });
    expect(failedOf(result)).toMatchObject({ kind: "policy", created: 0 });
    expect(state().calls.create).toBeUndefined();
    expect(await cursor()).toBe(before);
    expect(argvLog().flat()).not.toContain(MASSAGE);
    const [bindings] = await conn.query<RowDataPacket[]>("SELECT * FROM calendar_binding");
    expect(bindings).toHaveLength(0);
    expect(massage.id).not.toBe(throwaway.id);
  });
});

describe("the cursor", () => {
  it("advances to Dolt HEAD after a fully successful round", async () => {
    await store.addPeriods([day(1, "standup")]);
    const { result } = await round();
    expect(result).toMatchObject({ state: "ok", cursorAfter: await headHash() });
    expect(await cursor()).toBe(await headHash());
  });

  it("still advances when a re-run finds every push already applied", async () => {
    await store.addPeriods([day(1, "standup")]);
    const before = await cursor();
    await round();
    await conn.query("UPDATE calendar_sync_cursor SET last_synced_commit_hash = ?", [before]);
    const { plan, result } = await round();
    expect(plan.push.map((p) => p.beadId)).toContainEqual(
      expect.stringMatching(/^row:calendar_binding:/),
    );
    expect(result).toMatchObject({ state: "ok", created: 0, skipped: [] });
    expect(state().calls.create).toBe(1);
    expect(remoteEvents(THROWAWAY)).toHaveLength(1);
    expect(await cursor()).toBe(await headHash());
  });

  it("returns a typed store failure when Dolt fails before any push", async () => {
    await store.addPeriods([day(1, "standup")]);
    const { plan } = await round({ policy: pushPolicy("google", MASSAGE) });
    const broken = {
      query: async () => {
        throw new Error("dolt is down");
      },
    } as unknown as Connection;
    const result = await applyPlan({
      conn: broken,
      provider: provider(),
      plan,
      policy: pushPolicy("google", THROWAWAY),
      calendar: { id: throwaway.id, remoteCalendarId: THROWAWAY },
      sourceDatabase: SOURCE_DATABASE,
    });
    expect(failedOf(result)).toMatchObject({ kind: "store", at: null });
    expect(failedOf(result).message).toMatch(/dolt is down/);
    expect(state().calls.create).toBeUndefined();
  });

  it("stays put on a provider error, returns a typed failure, and a re-run completes", async () => {
    await store.addPeriods([day(1, "standup"), day(2, "review")]);
    const before = await cursor();
    process.env.FAKE_GOG_FAIL_NTH = "create:2";
    const { result } = await round();
    const failure = failedOf(result);
    expect(failure).toMatchObject({ kind: "provider", created: 1, cursorBefore: before });
    expect(failure.message).toMatch(/injected failure/);
    expect(failure.at).toMatch(/^row:calendar_period:\d+$/);
    expect(await cursor()).toBe(before);
    expect((await conn.query<RowDataPacket[]>("SELECT * FROM calendar_binding"))[0]).toHaveLength(
      1,
    );

    process.env.FAKE_GOG_FAIL_NTH = "";
    const retry = await round();
    expect(retry.result).toMatchObject({ state: "ok", created: 1 });
    expect(state().calls.create).toBe(3);
    expect(remoteEvents(THROWAWAY)).toHaveLength(2);
    expect(await cursor()).toBe(await headHash());
  });

  it("does not skip a change someone else committed in the middle of the round", async () => {
    await store.addPeriods([day(1, "standup")]);
    const real = provider();
    const racing: CalendarProvider = {
      ...real,
      createEvent: async (policy, calendarId, draft) => {
        await store.addPeriods([day(3, "late arrival")]);
        return real.createEvent(policy, calendarId, draft);
      },
    };
    const { plan, result } = await round({ provider: racing });
    expect(plan.push).toHaveLength(1);
    expect(result).toMatchObject({ state: "ok", cursorAfter: plan.observations.doltHeadBefore });
    const next = await round();
    expect(next.result).toMatchObject({ state: "ok", created: 1 });
    expect(
      remoteEvents(THROWAWAY)
        .map((e) => e.summary)
        .sort(),
    ).toEqual(["late arrival", "standup"]);
  });

  it("refuses a plan that asked for a full resync and moves nothing", async () => {
    await store.addPeriods([day(1, "standup")]);
    await conn.query("UPDATE calendar_sync_cursor SET last_synced_commit_hash = NULL");
    const { plan, result } = await round();
    expect(plan.conflictsQuarantined).toBeGreaterThan(0);
    expect(failedOf(result)).toMatchObject({ kind: "quarantined", created: 0 });
    expect(state().calls.create).toBeUndefined();
  });
});
