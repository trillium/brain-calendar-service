// S1's exit test, against a REAL Dolt server.
//
// The plan is explicit that this stage's exit condition is deliberately not
// mockable: the point is that the schema is real, that Dolt accepts it, and that
// the shapes the sync engine depends on - notably a cursor per (source database,
// calendar) - actually hold data. A mocked store would prove none of that.
//
// Every test here is a round trip: insert, read, update, delete, read again. A
// test that would still pass if every function it calls returned nothing is not
// a test (plan 7.0 T10).

import type { RowDataPacket } from "mysql2";
import type { Connection, ResultSetHeader } from "mysql2/promise";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "./config.mjs";
import { TABLE_NAMES } from "./schema.mjs";

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

let conn: Connection;

beforeAll(async () => {
  conn = await createConnection({ ...config, multipleStatements: true });
});

afterAll(async () => {
  await conn?.end();
});

const exec = async (sql: string, params: unknown[] = []): Promise<ResultSetHeader> => {
  const result = await select<RowDataPacket>(sql, params);
  return result as unknown as ResultSetHeader;
};

/** SELECT helper. Row shape is checked by the assertion, not by a cast. */
const select = async <T extends RowDataPacket>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const [result] = await conn.query(sql, params);
  return result as T[];
};

const rowCount = async (table: string): Promise<number> => {
  const found = await select<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM \`${table}\``,
  );
  return Number(found[0].n);
};

describe("live schema matches the claimed schema", () => {
  it("has exactly the tables the repo claims, and no others", async () => {
    const rows = await select<RowDataPacket>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = ?",
      [config.database],
    );
    const present = rows.map((r) => r.table_name ?? r.TABLE_NAME).sort();
    expect(present).toEqual([...TABLE_NAMES].sort());
  });
});

describe("calendar_calendar", () => {
  it("round-trips one connected external calendar", async () => {
    const before = await rowCount("calendar_calendar");
    const id = (
      await exec(
        `INSERT INTO calendar_calendar
           (provider, remote_calendar_id, display_name, capabilities, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["google", "primary@example.com", "Work", JSON.stringify({ write: true }), now(), now()],
      )
    ).insertId;

    const rows = await select<RowDataPacket>("SELECT * FROM calendar_calendar WHERE id = ?", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].display_name).toBe("Work");

    await exec("UPDATE calendar_calendar SET display_name = ? WHERE id = ?", ["Renamed", id]);
    const updated = await select<RowDataPacket>(
      "SELECT display_name FROM calendar_calendar WHERE id = ?",
      [id],
    );
    expect(updated[0].display_name).toBe("Renamed");

    await exec("DELETE FROM calendar_calendar WHERE id = ?", [id]);
    expect(await rowCount("calendar_calendar")).toBe(before);
  });

  it("refuses two calendars with the same provider and remote id", async () => {
    const ts = now();
    const first = await exec(
      `INSERT INTO calendar_calendar
         (provider, remote_calendar_id, display_name, capabilities, created_at, updated_at)
       VALUES ('google', 'dup@example.com', 'A', ?, ?, ?)`,
      ["{}", ts, ts],
    );
    await expect(
      exec(
        `INSERT INTO calendar_calendar
           (provider, remote_calendar_id, display_name, capabilities, created_at, updated_at)
         VALUES ('google', 'dup@example.com', 'B', ?, ?, ?)`,
        ["{}", ts, ts],
      ),
    ).rejects.toThrow();
    await exec("DELETE FROM calendar_calendar WHERE id = ?", [first.insertId]);
  });
});

describe("calendar_binding", () => {
  it("round-trips a temporal record's link to an external event", async () => {
    const ts = now();
    const cal = (
      await exec(
        `INSERT INTO calendar_calendar
           (provider, remote_calendar_id, display_name, capabilities, created_at, updated_at)
         VALUES ('google', 'bind@example.com', 'B', ?, ?, ?)`,
        ["{}", ts, ts],
      )
    ).insertId;
    const before = await rowCount("calendar_binding");

    const id = (
      await exec(
        `INSERT INTO calendar_binding
           (bead_id, calendar_id, external_uid, external_sequence, ownership_token,
            last_synced_commit_hash, last_synced_etag, last_synced_dtstamp,
            created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        ["brain-abc123", cal, "uid-1@example.com", "tok_1", "a".repeat(40), "etag-1", ts, ts, ts],
      )
    ).insertId;

    const rows = await select<RowDataPacket>("SELECT * FROM calendar_binding WHERE id = ?", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bead_id).toBe("brain-abc123");
    expect(rows[0].ownership_token).toBe("tok_1");

    await exec("UPDATE calendar_binding SET external_sequence = ? WHERE id = ?", [3, id]);
    const updated = await select<RowDataPacket>(
      "SELECT external_sequence FROM calendar_binding WHERE id = ?",
      [id],
    );
    expect(Number(updated[0].external_sequence)).toBe(3);

    await exec("DELETE FROM calendar_binding WHERE id = ?", [id]);
    expect(await rowCount("calendar_binding")).toBe(before);
    await exec("DELETE FROM calendar_calendar WHERE id = ?", [cal]);
  });

  it("holds a binding with NO ownership token, which is how an unowned event is represented", async () => {
    const ts = now();
    const cal = (
      await exec(
        `INSERT INTO calendar_calendar
           (provider, remote_calendar_id, display_name, capabilities, created_at, updated_at)
         VALUES ('google', 'unowned@example.com', 'U', ?, ?, ?)`,
        ["{}", ts, ts],
      )
    ).insertId;
    const before = await rowCount("calendar_binding");
    const id = (
      await exec(
        `INSERT INTO calendar_binding
           (bead_id, calendar_id, external_uid, ownership_token, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
        ["brain-unowned", cal, "uid-unowned@example.com", ts, ts],
      )
    ).insertId;
    const rows = await select<RowDataPacket>(
      "SELECT ownership_token FROM calendar_binding WHERE id = ?",
      [id],
    );
    expect(rows[0].ownership_token).toBeNull();
    await exec("DELETE FROM calendar_binding WHERE id = ?", [id]);
    expect(await rowCount("calendar_binding")).toBe(before);
    await exec("DELETE FROM calendar_calendar WHERE id = ?", [cal]);
  });
});

describe("calendar_exception", () => {
  it("round-trips a per-occurrence override and refuses a duplicate occurrence", async () => {
    const ts = now();
    const before = await rowCount("calendar_exception");
    const id = (
      await exec(
        `INSERT INTO calendar_exception
           (bead_id, recurrence_id_utc, external_uid, patch_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "brain-rec1",
          "2026-11-04 17:00:00",
          "uid-rec1@example.com",
          JSON.stringify({ summary: "Moved", start: "2026-11-04T19:00:00Z" }),
          ts,
          ts,
        ],
      )
    ).insertId;
    await expect(
      exec(
        `INSERT INTO calendar_exception
           (bead_id, recurrence_id_utc, external_uid, patch_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["brain-rec1", "2026-11-04 17:00:00", "uid-rec1@example.com", "{}", ts, ts],
      ),
    ).rejects.toThrow();
    await exec("DELETE FROM calendar_exception WHERE id = ?", [id]);
    expect(await rowCount("calendar_exception")).toBe(before);
  });
});

describe("calendar_sync_cursor — two databases, two cursors", () => {
  it("keeps one cursor per (source database, calendar) pair for the same calendar", async () => {
    const ts = now();
    const cal = (
      await exec(
        `INSERT INTO calendar_calendar
           (provider, remote_calendar_id, display_name, capabilities, created_at, updated_at)
         VALUES ('google', 'cursor@example.com', 'C', ?, ?, ?)`,
        ["{}", ts, ts],
      )
    ).insertId;
    const before = await rowCount("calendar_sync_cursor");

    // A Dolt commit hash is only meaningful inside the database that produced
    // it. The Beads database and this store are different databases with
    // different histories, so one calendar needs a cursor in each.
    const beadsCursor = (
      await exec(
        `INSERT INTO calendar_sync_cursor
           (source_database, calendar_id, last_synced_commit_hash, last_round_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["beads", cal, "b".repeat(40), ts, ts, ts],
      )
    ).insertId;
    const serviceCursor = (
      await exec(
        `INSERT INTO calendar_sync_cursor
           (source_database, calendar_id, last_synced_commit_hash, last_round_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["brain_calendar_service", cal, "c".repeat(40), ts, ts, ts],
      )
    ).insertId;

    const rows = await select<RowDataPacket>(
      "SELECT source_database, last_synced_commit_hash FROM calendar_sync_cursor WHERE calendar_id = ?",
      [cal],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source_database).sort()).toEqual(["beads", "brain_calendar_service"]);

    // A cursor row with a NULL hash is a full-resync request, not a silent
    // empty diff. Prove the store can represent that state at all.
    await exec("UPDATE calendar_sync_cursor SET last_synced_commit_hash = NULL WHERE id = ?", [
      beadsCursor,
    ]);
    const nulled = await select<RowDataPacket>(
      "SELECT last_synced_commit_hash FROM calendar_sync_cursor WHERE id = ?",
      [beadsCursor],
    );
    expect(nulled[0].last_synced_commit_hash).toBeNull();

    await exec("DELETE FROM calendar_sync_cursor WHERE id IN (?, ?)", [beadsCursor, serviceCursor]);
    expect(await rowCount("calendar_sync_cursor")).toBe(before);
    await exec("DELETE FROM calendar_calendar WHERE id = ?", [cal]);
  });
});

describe("calendar_conflict", () => {
  it("round-trips a quarantined conflict and defaults it to unresolved with no decision", async () => {
    const before = await rowCount("calendar_conflict");
    const id = (
      await exec(
        `INSERT INTO calendar_conflict
           (calendar_id, bead_id, external_uid, reason, local_payload, remote_payload,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "brain-conf1",
          "uid-conf1@example.com",
          "incomparable_payloads",
          JSON.stringify({ summary: "Local" }),
          JSON.stringify({ summary: "Remote" }),
          now(),
          now(),
        ],
      )
    ).insertId;
    const rows = await select<RowDataPacket>("SELECT * FROM calendar_conflict WHERE id = ?", [id]);
    expect(Number(rows[0].resolved)).toBe(0);
    expect(rows[0].decision_id).toBeNull();

    await exec("DELETE FROM calendar_conflict WHERE id = ?", [id]);
    expect(await rowCount("calendar_conflict")).toBe(before);
  });
});

describe("calendar_period", () => {
  it("round-trips a day, a week and a month as three distinct records", async () => {
    const ts = now();
    const before = await rowCount("calendar_period");
    const grains = ["day", "week", "month"];
    const ids = [];
    for (const grain of grains) {
      ids.push(
        (
          await exec(
            `INSERT INTO calendar_period
               (grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [grain, "2026-11-01 00:00:00", "2026-11-02 00:00:00", "brain-period1", "{}", ts, ts],
          )
        ).insertId,
      );
    }
    const rows = await select<RowDataPacket>(
      "SELECT grain FROM calendar_period WHERE linked_bead_id = ?",
      ["brain-period1"],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.grain).sort()).toEqual(["day", "month", "week"]);

    await exec("DELETE FROM calendar_period WHERE id IN (?, ?, ?)", ids);
    expect(await rowCount("calendar_period")).toBe(before);
  });

  it("refuses two periods of the same grain starting at the same instant", async () => {
    const ts = now();
    const first = await exec(
      `INSERT INTO calendar_period
         (grain, period_start_utc, period_end_utc, attributes_json, created_at, updated_at)
       VALUES ('day', '2027-01-01 00:00:00', '2027-01-02 00:00:00', '{}', ?, ?)`,
      [ts, ts],
    );
    await expect(
      exec(
        `INSERT INTO calendar_period
           (grain, period_start_utc, period_end_utc, attributes_json, created_at, updated_at)
         VALUES ('day', '2027-01-01 00:00:00', '2027-01-02 00:00:00', '{}', ?, ?)`,
        [ts, ts],
      ),
    ).rejects.toThrow();
    await exec("DELETE FROM calendar_period WHERE id = ?", [first.insertId]);
  });
});
