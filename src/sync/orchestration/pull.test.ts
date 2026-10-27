// cspell:ignore HASHOF unpushed
// Stage C: the pull half and the self-echo drop, against a real (disposable) Dolt
// database and the stateful fake gog. No real gog and no real calendar is reached.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { execRunner, recordingRunner } from "../../adapters/gog/runner.js";
import type { CalendarProvider } from "../../adapters/provider.js";
import type { Store } from "../../mcp/store.js";
import { createTestDatabase, type TestDatabase } from "../../mcp/test-db.js";
import { type ApplyResult, applyPlan, pushPolicy } from "./apply.js";
import { buildSyncPlan, SOURCE_DATABASE } from "./plan.js";
import { observePull } from "./pull-observe.js";
import { runRound } from "./round.js";
import { soakEntry } from "./soak.js";

const FAKE = resolve(import.meta.dirname, "../../../fixtures/gog/fake-gog.mjs");
const THROWAWAY = "bcs-throwaway@group.calendar.google.com";
const MASSAGE = "massage@group.calendar.google.com";
const EDITED = { from: "2026-04-01T15:00:00Z", to: "2026-04-01T16:00:00Z" };

let db: TestDatabase;
let conn: Connection;
let store: Store;
let dir: string;
let throwaway: RegisteredCalendar;

const state = () => {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch {
    return { calls: {}, calendars: {} };
  }
};
const remoteEvents = () =>
  Object.values(state().calendars[THROWAWAY] ?? {}) as {
    id: string;
    etag: string;
    summary: string;
    start: { dateTime: string };
  }[];
const argvLog = (): string[][] =>
  readFileSync(join(dir, "calls.log"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

const provider = (): CalendarProvider =>
  createGogProvider({ account: "t@example.invalid", bin: FAKE });

const one = async (sql: string, params: unknown[] = []): Promise<RowDataPacket> => {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  return rows[0] as RowDataPacket;
};
const headHash = async () => String((await one("SELECT DOLT_HASHOF('HEAD') AS h")).h);
const logLength = async () => Number((await one("SELECT COUNT(*) AS n FROM dolt_log")).n);
const cursor = async () =>
  String(
    (
      await one(
        "SELECT last_synced_commit_hash AS h FROM calendar_sync_cursor WHERE calendar_id = ?",
        [throwaway.id],
      )
    ).h,
  );
const period = (id = 1) =>
  one(
    `SELECT DATE_FORMAT(period_start_utc, '%Y-%m-%dT%H:%i:%sZ') AS start_utc,
            DATE_FORMAT(period_end_utc, '%Y-%m-%dT%H:%i:%sZ') AS end_utc
       FROM calendar_period WHERE id = ?`,
    [id],
  );
const binding = () => one("SELECT * FROM calendar_binding ORDER BY id LIMIT 1");
const conflicts = async () =>
  (await conn.query<RowDataPacket[]>("SELECT * FROM calendar_conflict"))[0];

const day = (n: number, summary: string) => ({
  grain: "day" as const,
  startUtc: `2026-04-0${n}T10:00:00Z`,
  endUtc: `2026-04-0${n}T11:00:00Z`,
  summary,
});

/** A third party editing an event on the provider: not this service, so not through the sync. */
const editRemotely = (eventId: string, draft: object) =>
  provider().updateEvent(pushPolicy("google", THROWAWAY), THROWAWAY, eventId, draft);

/** A third party deleting an event on the provider, straight from the fake's state. */
const deleteRemotely = (eventId: string) => {
  const next = state();
  delete next.calendars[THROWAWAY][eventId];
  writeFileSync(join(dir, "state.json"), JSON.stringify(next));
};

const failingOn = (fragment: string): Connection =>
  new Proxy(conn, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== "query") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string, ...rest: unknown[]) =>
        sql.includes(fragment)
          ? Promise.reject(new Error(`${fragment} lost`))
          : target.query(sql, ...(rest as []));
    },
  });

const round = (over: { conn?: Connection; provider?: CalendarProvider; dryRun?: boolean } = {}) =>
  runRound({
    conn: over.conn ?? conn,
    provider: over.provider ?? provider(),
    calendar: { id: throwaway.id, registered: throwaway },
    dryRun: over.dryRun ?? false,
    providerCalls: () => [],
  });

const applied = (outcome: Awaited<ReturnType<typeof round>>): ApplyResult => {
  if (outcome.applied === null) throw new Error("expected a live round");
  return outcome.applied;
};

const failedOf = (result: ApplyResult) => {
  if (result.state !== "failed") throw new Error("expected a failed round");
  return result;
};

/** A standup pushed to the throwaway calendar, then edited on the provider. */
const pushedThenEdited = async (): Promise<string> => {
  await store.addPeriods([day(1, "standup")]);
  expect(applied(await round())).toMatchObject({ state: "ok", created: 1 });
  const uid = remoteEvents()[0]?.id as string;
  await editRemotely(uid, EDITED);
  return uid;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pull-"));
  process.env.FAKE_GOG_STATE = join(dir, "state.json");
  process.env.FAKE_GOG_LOG = join(dir, "calls.log");
  process.env.FAKE_GOG_FAIL_NTH = "";
  process.env.FAKE_GOG_FAIL = "";
  db = await createTestDatabase();
  conn = await createConnection({ ...config, database: db.name });
  await conn.query("CALL DOLT_ADD('-A')");
  await conn.query("CALL DOLT_COMMIT('-m', 'schema')");
  store = createDoltStore(db.name);
  throwaway = await registerCalendar(conn, {
    provider: "google",
    remoteCalendarId: THROWAWAY,
    displayName: "throwaway",
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

describe("a remote edit is pulled into Dolt", () => {
  it("lands as one commit, then the following rounds write and pull nothing", async () => {
    const uid = await pushedThenEdited();
    const logBefore = await logLength();

    const second = await round();
    expect(second.plan.pull).toHaveLength(1);
    expect(second.plan.pull[0]).toMatchObject({
      externalUid: uid,
      startUtc: EDITED.from,
      endUtc: EDITED.to,
    });
    expect(applied(second)).toMatchObject({ state: "ok", pulled: 1, created: 0, updated: 0 });
    expect(await period()).toMatchObject({ start_utc: EDITED.from, end_utc: EDITED.to });
    expect(await logLength()).toBe(logBefore + 1);
    for (const table of ["calendar_period", "calendar_binding"]) {
      const diff = await one(
        `SELECT COUNT(*) AS n FROM DOLT_DIFF('HEAD~1', 'HEAD', '${table}') AS d`,
      );
      expect(Number(diff.n)).toBe(1);
    }
    expect(await binding()).toMatchObject({
      last_synced_etag: remoteEvents()[0]?.etag,
      external_sequence: 1,
    });
    expect(await cursor()).toBe(await headHash());
    expect(soakEntry(second.plan, applied(second))).toEqual({
      conflicts: 0,
      quarantined: 0,
      pushes: 0,
      pulls: 1,
    });

    // Convergence: the pulled commit is not pushed back, and nothing else moves.
    const settled = await logLength();
    for (let i = 0; i < 3; i += 1) {
      const next = await round();
      expect(next.plan.push).toHaveLength(0);
      expect(next.plan.pull).toHaveLength(0);
      expect(applied(next)).toMatchObject({ state: "ok", pulled: 0, created: 0, updated: 0 });
      expect(await logLength()).toBe(settled);
      expect(await cursor()).toBe(await headHash());
    }
    expect(state().calls.create).toBe(1);
    expect(state().calls.update).toBe(1);
    expect(argvLog().flat()).not.toContain(MASSAGE);
  });

  it("does not push a pulled edit back when the cursor could not move past it", async () => {
    await store.addPeriods([day(1, "standup"), day(2, "review")]);
    await round();
    const idOf = (summary: string) =>
      remoteEvents().find((e) => e.summary === summary)?.id as string;
    await editRemotely(idOf("standup"), EDITED);
    // An edit the service cannot map (all-day) holds the cursor, so the next round
    // still sees the pulled period in its diff from the old cursor.
    await editRemotely(idOf("review"), { allDay: true, from: "2026-04-02", to: "2026-04-03" });

    const held = await round();
    expect(applied(held)).toMatchObject({ state: "incomplete", pulled: 1 });
    const updatesBefore = state().calls.update;
    const again = await round();
    expect(again.plan.push).toHaveLength(0);
    expect(applied(again)).toMatchObject({ state: "incomplete", pulled: 0, updated: 0 });
    expect(state().calls.update).toBe(updatesBefore);
  });
});

describe("the provider handing back our own write is dropped", () => {
  it("pulls nothing after a push, and nothing for a touch that changed no time", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    const uid = remoteEvents()[0]?.id as string;
    const logBefore = await logLength();

    const echo = await round();
    expect(echo.plan.pull).toHaveLength(0);
    expect(echo.plan.foreign).toHaveLength(0);

    await editRemotely(uid, { summary: "standup (renamed on the provider)" });
    const touched = await round();
    expect(touched.plan.pull).toHaveLength(0);
    expect(applied(touched)).toMatchObject({ state: "ok", pulled: 0, updated: 0, refreshed: 1 });
    expect(await logLength()).toBe(logBefore + 1);
    expect((await binding()).last_synced_etag).toBe(remoteEvents()[0]?.etag);

    const settled = await round();
    expect(applied(settled)).toMatchObject({ state: "ok", pulled: 0, updated: 0, refreshed: 0 });
    expect(await logLength()).toBe(logBefore + 1);
  });

  it("treats an unpushed local edit as a push, not as the provider's edit", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    await store.movePeriod("standup", "2026-04-01T12:00:00Z");

    const next = await round();
    expect(next.plan.pull).toHaveLength(0);
    expect(next.plan.push.map((p) => p.beadId)).toContain("row:calendar_period:1");
    expect(applied(next)).toMatchObject({ state: "ok", pulled: 0, updated: 1 });
    expect(remoteEvents()[0]?.start.dateTime).toBe("2026-04-01T12:00:00Z");
    expect((await round()).plan.pull).toHaveLength(0);
  });
});

describe("an edit on both sides in one round", () => {
  it("is quarantined, recorded once, applied nowhere, and keeps the cursor", async () => {
    const uid = await pushedThenEdited();
    await store.movePeriod("standup", "2026-04-01T12:00:00Z");
    const before = await cursor();
    const updates = state().calls.update;

    const first = await round();
    expect(first.plan.conflicts).toBe(1);
    expect(first.plan.pull).toHaveLength(0);
    expect(failedOf(applied(first))).toMatchObject({ kind: "quarantined", pulled: 0, updated: 0 });
    expect(soakEntry(first.plan, applied(first))).toMatchObject({ conflicts: 1, quarantined: 1 });
    expect(await period()).toMatchObject({ start_utc: "2026-04-01T12:00:00Z" });
    expect(state().calls.update).toBe(updates);
    expect(await cursor()).toBe(before);

    const held = await conflicts();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ reason: "concurrent_edit", external_uid: uid, resolved: 0 });
    expect(held[0]?.local_payload.payload.startUtc).toBe("2026-04-01T12:00:00Z");
    expect(held[0]?.remote_payload.payload.startUtc).toBe(EDITED.from);
    expect(await store.quarantined()).toHaveLength(1);

    const second = await round();
    expect(failedOf(applied(second)).kind).toBe("quarantined");
    expect(await conflicts()).toHaveLength(1);
    expect(await cursor()).toBe(before);
  });
});

describe("a remote edit to a period already pushed, while the cursor is held", () => {
  const idOf = (summary: string) => remoteEvents().find((e) => e.summary === summary)?.id as string;

  it("is pulled, not quarantined, after a round whose next create failed", async () => {
    await store.addPeriods([day(1, "standup"), day(2, "review")]);
    process.env.FAKE_GOG_FAIL_NTH = "create:2";
    expect(failedOf(applied(await round()))).toMatchObject({ kind: "provider", created: 1 });
    process.env.FAKE_GOG_FAIL_NTH = "";
    await editRemotely(idOf("standup"), EDITED);

    const next = await round();
    expect(next.plan.conflicts).toBe(0);
    expect(next.plan.pull).toHaveLength(1);
    expect(next.plan.push.map((p) => p.beadId)).not.toContain("row:calendar_period:1");
    expect(applied(next)).toMatchObject({ state: "ok", pulled: 1, created: 1, updated: 0 });
    expect(await period(1)).toMatchObject({ start_utc: EDITED.from, end_utc: EDITED.to });
    expect(await conflicts()).toHaveLength(0);
  });

  it("is pulled, not quarantined, after a local edit that moved no time", async () => {
    const uid = await pushedThenEdited();
    await conn.query(
      `UPDATE calendar_period SET attributes_json = ?, linked_bead_id = ?, updated_at = ?
        WHERE id = 1`,
      [
        JSON.stringify({ summary: "standup (renamed)" }),
        "standup (renamed)",
        "2026-05-01 00:00:00",
      ],
    );
    await conn.query("CALL DOLT_COMMIT('-am', 'rename standup')");

    const next = await round();
    expect(next.plan.conflicts).toBe(0);
    expect(next.plan.pull).toEqual([expect.objectContaining({ externalUid: uid })]);
    expect(applied(next)).toMatchObject({ state: "ok", pulled: 1, updated: 0 });
    expect(await period(1)).toMatchObject({ start_utc: EDITED.from, end_utc: EDITED.to });
    expect(await conflicts()).toHaveLength(0);
  });

  it("is pulled, not quarantined, while a deleted event keeps every round incomplete", async () => {
    await store.addPeriods([day(1, "standup"), day(2, "review")]);
    await round();
    deleteRemotely(idOf("review"));
    await store.movePeriod("standup", "2026-04-01T12:00:00Z");
    expect(applied(await round())).toMatchObject({ state: "incomplete", updated: 1 });
    await editRemotely(idOf("standup"), EDITED);

    const next = await round();
    expect(next.plan.conflicts).toBe(0);
    expect(applied(next)).toMatchObject({ state: "incomplete", pulled: 1, updated: 0 });
    expect(await period(1)).toMatchObject({ start_utc: EDITED.from, end_utc: EDITED.to });
    expect(await conflicts()).toHaveLength(0);
  });
});

describe("an event already in sync whose etag moved", () => {
  const pushedTo = async (start: string, end: string) => {
    const next = await round();
    expect(next.plan.conflicts).toBe(0);
    expect(applied(next)).toMatchObject({ state: "ok", updated: 1 });
    expect(remoteEvents()[0]?.start.dateTime).toBe(start);
    expect(await period()).toMatchObject({ start_utc: start, end_utc: end });
  };

  it("records the etag when the binding write after a landed update failed", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    await store.movePeriod("standup", "2026-04-01T12:00:00Z");
    const crashed = await round({ conn: failingOn("UPDATE calendar_binding") });
    expect(failedOf(applied(crashed))).toMatchObject({ kind: "store" });
    expect(remoteEvents()[0]?.start.dateTime).toBe("2026-04-01T12:00:00Z");
    expect((await binding()).last_synced_etag).not.toBe(remoteEvents()[0]?.etag);

    const healed = await round();
    expect(healed.plan.push).toHaveLength(0);
    expect(applied(healed)).toMatchObject({ state: "ok", refreshed: 1, updated: 0 });
    expect((await binding()).last_synced_etag).toBe(remoteEvents()[0]?.etag);

    await store.movePeriod("standup", "2026-04-01T14:00:00Z");
    await pushedTo("2026-04-01T14:00:00Z", "2026-04-01T15:00:00Z");
  });

  it("records the etag when both sides moved it to the same time", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    await store.movePeriod("standup", "2026-04-01T12:00:00Z");
    await editRemotely(remoteEvents()[0]?.id as string, {
      from: "2026-04-01T12:00:00Z",
      to: "2026-04-01T13:00:00Z",
    });

    const same = await round();
    expect(same.plan.push).toHaveLength(0);
    expect(same.plan.pull).toHaveLength(0);
    expect(applied(same)).toMatchObject({ state: "ok", refreshed: 1, updated: 0 });
    expect((await binding()).last_synced_etag).toBe(remoteEvents()[0]?.etag);

    await store.movePeriod("standup", "2026-04-01T14:00:00Z");
    await pushedTo("2026-04-01T14:00:00Z", "2026-04-01T15:00:00Z");
  });
});

describe("events that are not ours", () => {
  it("are reported, never imported, and never written to", async () => {
    await store.addPeriods([day(1, "standup")]);
    await round();
    const foreign = await provider().createEvent(pushPolicy("google", THROWAWAY), THROWAWAY, {
      summary: "dentist",
      from: "2026-04-05T09:00:00Z",
      to: "2026-04-05T10:00:00Z",
    });
    await store.link({
      beadId: "linked-bead",
      calendarId: `cal-${throwaway.id}`,
      externalUid: "x",
    });
    const logBefore = await logLength();
    const updates = state().calls.update;

    const next = await round();
    expect(next.plan.foreign).toEqual([
      expect.objectContaining({ externalUid: foreign.id, summary: "dentist" }),
    ]);
    expect(next.plan.pull).toHaveLength(0);
    expect(applied(next)).toMatchObject({ state: "ok", pulled: 0, created: 0 });
    expect(Number((await one("SELECT COUNT(*) AS n FROM calendar_period")).n)).toBe(1);
    expect(await logLength()).toBe(logBefore);
    expect(state().calls.update).toBe(updates);

    // Even edited on the provider, it stays out of Dolt.
    await editRemotely(foreign.id, EDITED);
    const edited = await round();
    expect(edited.plan.foreign).toHaveLength(1);
    expect(edited.plan.pull).toHaveLength(0);
    expect(await logLength()).toBe(logBefore);
  });

  it("includes an event bound without an ownership token", async () => {
    const stray = await provider().createEvent(pushPolicy("google", THROWAWAY), THROWAWAY, {
      summary: "linked by hand",
      from: "2026-04-05T09:00:00Z",
      to: "2026-04-05T10:00:00Z",
    });
    await store.link({
      beadId: "linked-bead",
      calendarId: `cal-${throwaway.id}`,
      externalUid: stray.id,
    });
    const next = await round();
    expect(next.plan.foreign).toEqual([
      expect.objectContaining({
        externalUid: stray.id,
        reason: expect.stringMatching(/ownership token/),
      }),
    ]);
    expect(next.plan.pull).toHaveLength(0);
    expect(next.plan.pullSkipped).toHaveLength(0);
  });
});

describe("a pull that cannot be applied keeps the cursor", () => {
  it("reports an edit it cannot map to a period (all-day)", async () => {
    const uid = await pushedThenEdited();
    await editRemotely(uid, { allDay: true, from: "2026-04-01", to: "2026-04-02" });
    const before = await cursor();

    const next = await round();
    expect(next.plan.pullSkipped).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/all-day/) }),
    ]);
    expect(applied(next)).toMatchObject({ state: "incomplete", pulled: 0 });
    expect(applied(next).skipped).toHaveLength(1);
    expect(await cursor()).toBe(before);
    expect(await period()).toMatchObject({ start_utc: "2026-04-01T10:00:00Z" });
    expect(applied(await round()).state).toBe("incomplete");
  });

  it("reports an edit that would collide with another period", async () => {
    await store.addPeriods([day(1, "standup"), day(2, "review")]);
    await round();
    const standup = remoteEvents().find((e) => e.summary === "standup")?.id as string;
    await editRemotely(standup, { from: "2026-04-02T10:00:00Z", to: "2026-04-02T11:00:00Z" });
    const before = await cursor();

    const next = await round();
    expect(next.plan.pull).toHaveLength(1);
    expect(applied(next)).toMatchObject({ state: "incomplete", pulled: 0 });
    expect(applied(next).skipped[0]?.reason).toMatch(/already starts at the pulled time/);
    expect(await cursor()).toBe(before);
    expect(await period(1)).toMatchObject({ start_utc: "2026-04-01T10:00:00Z" });
  });

  it("does not overwrite a period edited locally after the plan was built", async () => {
    await pushedThenEdited();
    const observed = await observePull({
      conn,
      provider: provider(),
      calendar: { id: throwaway.id, remoteCalendarId: THROWAWAY },
    });
    const plan = await buildSyncPlan({
      conn,
      calendarId: String(throwaway.id),
      provider: "google",
      pull: observed,
      providerCalls: () => [],
      dryRun: false,
    });
    expect(plan.pull).toHaveLength(1);
    await store.movePeriod("standup", "2026-04-01T12:00:00Z");
    const before = await cursor();

    const result = await applyPlan({
      conn,
      provider: provider(),
      plan,
      policy: pushPolicy("google", THROWAWAY),
      calendar: { id: throwaway.id, remoteCalendarId: THROWAWAY },
      sourceDatabase: SOURCE_DATABASE,
    });
    expect(result).toMatchObject({ state: "incomplete", pulled: 0 });
    expect(result.skipped[0]?.reason).toMatch(/edited locally after the plan/);
    expect(await period()).toMatchObject({ start_utc: "2026-04-01T12:00:00Z" });
    expect(await cursor()).toBe(before);
  });
});

describe("failure paths keep the cursor", () => {
  it("applies nothing, not even a push, when the provider cannot be read", async () => {
    await pushedThenEdited();
    await store.addPeriods([day(2, "review")]);
    const before = await cursor();
    const writes = state().calls.create + state().calls.update;
    process.env.FAKE_GOG_FAIL_NTH = `events:${state().calls.events + 1}`;

    const down = await round();
    expect(failedOf(applied(down))).toMatchObject({ kind: "provider", pulled: 0, created: 0 });
    expect(failedOf(applied(down)).message).toMatch(/injected failure/);
    expect(state().calls.create + state().calls.update).toBe(writes);
    expect(await period()).toMatchObject({ start_utc: "2026-04-01T10:00:00Z" });
    expect(await cursor()).toBe(before);

    process.env.FAKE_GOG_FAIL_NTH = "";
    expect(applied(await round())).toMatchObject({ state: "ok", pulled: 1, created: 1 });
    expect(await cursor()).toBe(await headHash());
  });

  it("rolls the whole pull back when Dolt fails, and a retry applies it", async () => {
    await pushedThenEdited();
    const before = await cursor();
    const etag = (await binding()).last_synced_etag;
    const broken = await round({ conn: failingOn("UPDATE calendar_period") });
    expect(failedOf(applied(broken))).toMatchObject({ kind: "store", pulled: 0 });
    expect(failedOf(applied(broken)).at).toBe("row:calendar_period:1");
    expect(await period()).toMatchObject({ start_utc: "2026-04-01T10:00:00Z" });
    expect((await binding()).last_synced_etag).toBe(etag);
    expect(await cursor()).toBe(before);

    expect(applied(await round())).toMatchObject({ state: "ok", pulled: 1 });
    expect(await period()).toMatchObject({ start_utc: EDITED.from });
  });
});

describe("a dry-run reads the provider and writes nothing", () => {
  it("shows the pull it would make, with only read calls on record", async () => {
    await pushedThenEdited();
    const recorder = recordingRunner(execRunner(FAKE));
    const head = await headHash();
    const before = await cursor();

    const dry = await runRound({
      conn,
      provider: createGogProvider({ account: "t@example.invalid", runner: recorder.runner }),
      calendar: { id: throwaway.id, registered: throwaway },
      dryRun: true,
      providerCalls: () => recorder.calls,
    });
    expect(dry.applied).toBeNull();
    expect(dry.plan.dryRun).toBe(true);
    expect(dry.plan.pull).toHaveLength(1);
    expect(dry.plan.observations.providerCalls.map((c) => c.method)).toEqual(["events"]);
    expect(await headHash()).toBe(head);
    expect(await cursor()).toBe(before);
    expect(await period()).toMatchObject({ start_utc: "2026-04-01T10:00:00Z" });
  });

  it("fails loudly rather than planning blind when the provider cannot be read", async () => {
    await pushedThenEdited();
    process.env.FAKE_GOG_FAIL = "1";
    await expect(round({ dryRun: true })).rejects.toThrow(/no stored token/);
  });
});
