// S8's tests. The tool surface is validated HERE as well as over the wire,
// because "the schema validates" and "the tool works" are different claims.
// Every test runs against a real Dolt database; there is no stand-in store.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDoltStore } from "../adapters/dolt/mcp-store.js";
import type { Store } from "./store.js";
import { createTestDatabase, openDirect, type TestDatabase } from "./test-db.js";
import { dispatch, moveCommitment, queryPeriod, TOOLS } from "./tools.js";

let db: TestDatabase;
let store: Store;

beforeAll(async () => {
  db = await createTestDatabase();
  store = createDoltStore(db.name);
});

afterAll(async () => {
  await store?.close();
  await db?.drop();
});

const reset = async () => {
  const conn = await openDirect(db.name);
  try {
    await conn.query("DELETE FROM calendar_period");
    await conn.query("DELETE FROM calendar_binding");
    await conn.query("DELETE FROM calendar_conflict");
  } finally {
    await conn.end();
  }
};

const standup = () =>
  dispatch(store, "propose_day", {
    zone: "UTC",
    date: "2026-04-01",
    items: [{ summary: "standup", startLocal: "2026-04-01T09:00:00", minutes: 15 }],
  });

const day = { grain: "day", startUtc: "2026-04-01T00:00:00", zone: "UTC" } as const;

beforeEach(reset);

describe("tool surface", () => {
  it("exposes exactly the tools the plan names", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "link_external",
      "list_changes",
      "list_quarantined",
      "move_commitment",
      "propose_day",
      "query_period",
      "unlink_external",
    ]);
  });

  it("rejects a malformed argument rather than coercing it", async () => {
    await expect(
      queryPeriod(store, { grain: "fortnight", startUtc: "2026-04-01T00:00:00", zone: "UTC" }),
    ).rejects.toThrow();
    await expect(queryPeriod(store, { grain: "day" })).rejects.toThrow();
  });

  it("refuses an unknown tool by name", async () => {
    await expect(dispatch(store, "delete_everything", {})).rejects.toThrow(/Unknown tool/);
  });

  it("calls every tool through dispatch with real, valid arguments", async () => {
    await standup();
    const valid: Record<string, unknown> = {
      query_period: day,
      propose_day: {
        zone: "UTC",
        date: "2026-04-02",
        items: [{ summary: "review", startLocal: "2026-04-02T09:00:00", minutes: 30 }],
      },
      move_commitment: { beadId: "standup", newStartUtc: "2026-04-01T11:00:00Z" },
      link_external: { beadId: "standup", calendarId: "cal-1", externalUid: "uid-1" },
      unlink_external: { beadId: "standup", calendarId: "cal-1" },
      list_changes: {},
      list_quarantined: {},
    };
    expect(Object.keys(valid).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const tool of TOOLS) {
      await expect(dispatch(store, tool.name, valid[tool.name]), tool.name).resolves.toBeDefined();
    }
  });
});

describe("periods", () => {
  it("makes a proposed day visible through a later read", async () => {
    expect(await queryPeriod(store, day)).toMatchObject({ periods: [] });
    await standup();
    const out = await queryPeriod(store, day);
    expect(out.periods).toEqual([
      {
        grain: "day",
        startUtc: "2026-04-01T09:00:00Z",
        endUtc: "2026-04-01T09:15:00Z",
        summary: "standup",
      },
    ]);
  });

  it("resolves local times through the zone, not as UTC", async () => {
    await dispatch(store, "propose_day", {
      zone: "America/New_York",
      date: "2026-04-01",
      items: [{ summary: "ny", startLocal: "2026-04-01T09:00:00", minutes: 30 }],
    });
    expect(await dispatch(store, "list_changes", { beadId: "ny" })).toMatchObject([
      { startUtc: "2026-04-01T13:00:00Z" },
    ]);
  });

  it("widens the query window with the grain", async () => {
    await standup();
    await dispatch(store, "propose_day", {
      zone: "UTC",
      date: "2026-04-05",
      items: [{ summary: "later", startLocal: "2026-04-05T09:00:00", minutes: 30 }],
    });
    const count = async (grain: "day" | "week" | "month") =>
      (await queryPeriod(store, { ...day, grain })).periods.length;
    expect([await count("day"), await count("week"), await count("month")]).toEqual([1, 2, 2]);
  });

  it("moves a commitment, keeping its length, and a later read sees it", async () => {
    await standup();
    const moved = await dispatch(store, "move_commitment", {
      beadId: "standup",
      newStartUtc: "2026-04-01T11:00:00Z",
    });
    expect(moved).toMatchObject({ moved: true, startUtc: "2026-04-01T11:00:00Z" });
    expect(await dispatch(store, "list_changes", { beadId: "standup" })).toEqual([
      { beadId: "standup", startUtc: "2026-04-01T11:00:00Z", endUtc: "2026-04-01T11:15:00Z" },
    ]);
  });

  it("reports a move that names nothing rather than inventing a record", async () => {
    expect(
      await moveCommitment(store, { beadId: "ghost", newStartUtc: "2026-04-01T11:00:00Z" }),
    ).toMatchObject({ moved: false });
    expect(await store.listPeriods()).toHaveLength(0);
  });

  it("refuses a move onto another commitment's slot instead of overwriting it", async () => {
    await standup();
    await dispatch(store, "propose_day", {
      zone: "UTC",
      date: "2026-04-01",
      items: [{ summary: "review", startLocal: "2026-04-01T10:00:00", minutes: 30 }],
    });
    const out = await dispatch(store, "move_commitment", {
      beadId: "review",
      newStartUtc: "2026-04-01T09:00:00Z",
    });
    expect(out).toMatchObject({ moved: false });
    expect(await store.listPeriods()).toHaveLength(2);
  });

  it("returns a typed refusal when two items start at the same time", async () => {
    const out = await dispatch(store, "propose_day", {
      zone: "UTC",
      date: "2026-04-01",
      items: [
        { summary: "a", startLocal: "2026-04-01T09:00:00", minutes: 30 },
        { summary: "b", startLocal: "2026-04-01T09:00:00", minutes: 30 },
      ],
    });
    expect(out).toMatchObject({ proposed: false });
    expect(await store.listPeriods()).toHaveLength(0);
  });

  it("proposes the same day twice without duplicating it", async () => {
    await standup();
    await standup();
    expect(await store.listPeriods("standup")).toHaveLength(1);
  });

  it("proposes all-or-nothing when one item clashes", async () => {
    await standup();
    const clash = await dispatch(store, "propose_day", {
      zone: "UTC",
      date: "2026-04-01",
      items: [
        { summary: "fresh", startLocal: "2026-04-01T13:00:00", minutes: 30 },
        { summary: "intruder", startLocal: "2026-04-01T09:00:00", minutes: 30 },
      ],
    });
    expect(clash).toMatchObject({
      proposed: false,
      reason: expect.stringContaining("refusing to overwrite"),
    });
    expect(await store.listPeriods("fresh")).toHaveLength(0);
  });

  it("lists changes, optionally filtered by bead", async () => {
    await standup();
    expect(await dispatch(store, "list_changes", {})).toHaveLength(1);
    expect(await dispatch(store, "list_changes", { beadId: "standup" })).toHaveLength(1);
    expect(await dispatch(store, "list_changes", { beadId: "ghost" })).toHaveLength(0);
    await expect(dispatch(store, "list_changes", { beadId: "" })).rejects.toThrow();
  });
});

describe("links", () => {
  const link = { beadId: "standup", calendarId: "cal-1", externalUid: "uid-1" };

  it("persists a link and unlinks it, reporting whether one existed", async () => {
    expect(await dispatch(store, "link_external", link)).toMatchObject({ linked: true });
    const conn = await openDirect(db.name);
    try {
      const [rows] = await conn.query(
        "SELECT bead_id, calendar_id, external_uid FROM calendar_binding",
      );
      expect(rows).toEqual([{ bead_id: "standup", calendar_id: 1, external_uid: "uid-1" }]);
    } finally {
      await conn.end();
    }
    expect(await dispatch(store, "unlink_external", link)).toMatchObject({ unlinked: true });
    expect(await dispatch(store, "unlink_external", link)).toMatchObject({ unlinked: false });
  });

  it("treats re-linking the same uid as a no-op and a different uid as a refusal", async () => {
    await dispatch(store, "link_external", link);
    expect(await dispatch(store, "link_external", link)).toMatchObject({ linked: true });
    expect(await dispatch(store, "link_external", { ...link, externalUid: "uid-2" })).toMatchObject(
      { linked: false, reason: expect.stringContaining("unlink first") },
    );
  });

  it("refuses a uid already bound to another record", async () => {
    await dispatch(store, "link_external", link);
    expect(await dispatch(store, "link_external", { ...link, beadId: "other" })).toMatchObject({
      linked: false,
    });
  });

  it("rejects a calendar id that is not numeric", async () => {
    await expect(dispatch(store, "link_external", { ...link, calendarId: "work" })).rejects.toThrow(
      /calendarId must be/,
    );
  });
});

describe("quarantine", () => {
  it("declares that quarantine has no automatic exit, and lists only unresolved rows", async () => {
    const conn = await openDirect(db.name);
    try {
      await conn.query(
        `INSERT INTO calendar_conflict (calendar_id, bead_id, external_uid, reason, resolved, created_at, updated_at)
         VALUES (1, 'b-1', 'u-1', 'undecidable_edit', 0, NOW(), NOW()),
                (1, 'b-2', 'u-2', 'old', 1, NOW(), NOW())`,
      );
    } finally {
      await conn.end();
    }
    expect(await dispatch(store, "list_quarantined", {})).toMatchObject({
      automaticResolution: false,
      conflicts: [{ beadId: "b-1", externalUid: "u-1", reason: "undecidable_edit" }],
    });
  });
});

describe("input bounds match the store's column widths", () => {
  const long = (n: number) => "x".repeat(n);

  it("refuses an over-long summary or bead id with a validation error, writing nothing", async () => {
    await expect(
      dispatch(store, "propose_day", {
        zone: "UTC",
        date: "2026-04-01",
        items: [{ summary: long(65), startLocal: "2026-04-01T09:00:00", minutes: 15 }],
      }),
    ).rejects.toThrow();
    await expect(
      dispatch(store, "move_commitment", {
        beadId: long(65),
        newStartUtc: "2026-04-01T11:00:00Z",
      }),
    ).rejects.toThrow();
    await expect(dispatch(store, "list_changes", { beadId: long(65) })).rejects.toThrow();
    expect(await store.listPeriods()).toHaveLength(0);
  });

  it("accepts values exactly at the limit", async () => {
    await dispatch(store, "propose_day", {
      zone: "UTC",
      date: "2026-04-01",
      items: [{ summary: long(64), startLocal: "2026-04-01T09:00:00", minutes: 15 }],
    });
    expect(await store.listPeriods(long(64))).toHaveLength(1);
    expect(
      await dispatch(store, "link_external", {
        beadId: long(64),
        calendarId: "cal-1",
        externalUid: long(512),
      }),
    ).toMatchObject({ linked: true });
  });

  it("refuses an over-long link bead id, calendar id or external uid", async () => {
    const ok = { beadId: "b", calendarId: "cal-1", externalUid: "u" };
    for (const bad of [
      { ...ok, beadId: long(65) },
      { ...ok, calendarId: long(25) },
      { ...ok, calendarId: "primary" },
      { ...ok, calendarId: "cal-abc" },
      { ...ok, calendarId: "cal-0" },
      { ...ok, calendarId: "cal-99999999999999999999" },
      { ...ok, externalUid: long(513) },
    ]) {
      await expect(dispatch(store, "link_external", bad)).rejects.toThrow();
    }
    // unlink takes no external uid, so only the bead and calendar bounds apply to it.
    for (const bad of [
      { beadId: long(65), calendarId: "cal-1" },
      { beadId: "b", calendarId: long(25) },
      { beadId: "b", calendarId: "primary" },
    ]) {
      await expect(dispatch(store, "unlink_external", bad)).rejects.toThrow();
    }
  });
});
