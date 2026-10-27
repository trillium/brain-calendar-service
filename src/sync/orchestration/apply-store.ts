// The Dolt side of the apply step: reading what a push refers to, recording a
// binding, and moving the cursor. Every binding write is a SQL transaction
// followed by a Dolt commit of ONLY calendar_binding, because change detection
// diffs history and an uncommitted write is invisible to it.

import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import type { ProviderEvent } from "../../adapters/provider.js";
import { type PeriodRow, periodFromRow } from "./apply-draft.js";

export interface BindingRow {
  readonly id: number;
  readonly externalUid: string;
  readonly ownershipToken: string | null;
}

export const nowSql = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

/** An `updated` instant as a DATETIME, or now when it is absent or invalid. */
export const sqlStamp = (updated: string | undefined): string => {
  const parsed = updated === undefined ? Number.NaN : Date.parse(updated);
  return Number.isNaN(parsed)
    ? nowSql()
    : new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
};

const stampOf = (event: ProviderEvent): string => sqlStamp(event.updated);

// DATE_FORMAT in SQL, not the driver: without dateStrings mysql2 hands back a Date
// built in the process's local zone, which would shift every UTC instant.
export const loadPeriod = async (conn: Connection, id: number): Promise<PeriodRow | null> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id, linked_bead_id, attributes_json,
            DATE_FORMAT(period_start_utc, '%Y-%m-%dT%H:%i:%sZ') AS start_utc,
            DATE_FORMAT(period_end_utc, '%Y-%m-%dT%H:%i:%sZ') AS end_utc,
            DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_utc
       FROM calendar_period WHERE id = ?`,
    [id],
  );
  return rows[0] === undefined ? null : periodFromRow(rows[0]);
};

export const findBinding = async (
  conn: Connection,
  beadId: string,
  calendarId: number,
): Promise<BindingRow | null> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, external_uid, ownership_token FROM calendar_binding " +
      "WHERE bead_id = ? AND calendar_id = ?",
    [beadId, calendarId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: Number(row.id),
    externalUid: String(row.external_uid),
    ownershipToken: (row.ownership_token as string | null) ?? null,
  };
};

export const doltHead = async (conn: Connection): Promise<string> => {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT DOLT_HASHOF('HEAD') AS h");
  return String(rows[0]?.h);
};

export const logLength = async (conn: Connection): Promise<number> => {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM dolt_log");
  return Number(rows[0]?.n);
};

/** One SQL transaction for the writes, then one Dolt commit of exactly the tables named. */
export const commitTables = async <T>(
  conn: Connection,
  tables: readonly string[],
  message: string,
  work: () => Promise<T>,
): Promise<T> => {
  let result: T;
  await conn.beginTransaction();
  try {
    result = await work();
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
  for (const table of tables) await conn.query("CALL DOLT_ADD(?)", [table]);
  await conn.query("CALL DOLT_COMMIT('--skip-empty', '-m', ?)", [message]);
  return result;
};

const commitBinding = (conn: Connection, message: string, work: () => Promise<void>) =>
  commitTables(conn, ["calendar_binding"], message, work);

interface NewBinding {
  readonly beadId: string;
  readonly calendarId: number;
  readonly event: ProviderEvent;
  readonly token: string;
  readonly syncedAt: string;
}

export const insertBinding = (conn: Connection, binding: NewBinding): Promise<void> =>
  commitBinding(conn, `apply: bind ${binding.beadId}`, async () => {
    const ts = nowSql();
    await conn.query(
      `INSERT INTO calendar_binding
         (bead_id, calendar_id, external_uid, external_sequence, last_synced_commit_hash,
          last_synced_etag, last_synced_dtstamp, ownership_token, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [
        binding.beadId,
        binding.calendarId,
        binding.event.id,
        binding.syncedAt,
        binding.event.etag ?? null,
        stampOf(binding.event),
        binding.token,
        ts,
        ts,
      ],
    );
  });

export const touchBinding = (
  conn: Connection,
  binding: BindingRow,
  beadId: string,
  event: ProviderEvent,
  syncedAt: string,
): Promise<void> =>
  commitBinding(conn, `apply: update ${beadId}`, async () => {
    await conn.query(
      `UPDATE calendar_binding
          SET external_sequence = external_sequence + 1, last_synced_commit_hash = ?,
              last_synced_etag = ?, last_synced_dtstamp = ?, updated_at = ?
        WHERE id = ?`,
      [syncedAt, event.etag ?? null, stampOf(event), nowSql(), binding.id],
    );
  });

/** Returns whether a cursor row existed to move. */
export const moveCursor = async (
  conn: Connection,
  sourceDatabase: string,
  calendarId: number,
  commitHash: string,
): Promise<boolean> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id FROM calendar_sync_cursor WHERE source_database = ? AND calendar_id = ?",
    [sourceDatabase, calendarId],
  );
  if (rows.length === 0) return false;
  const ts = nowSql();
  await conn.query(
    `UPDATE calendar_sync_cursor
        SET last_synced_commit_hash = ?, last_round_at = ?, updated_at = ?
      WHERE source_database = ? AND calendar_id = ?`,
    [commitHash, ts, ts, sourceDatabase, calendarId],
  );
  return true;
};
