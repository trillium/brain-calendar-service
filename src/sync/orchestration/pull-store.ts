// The Dolt side of the pull half: which events this calendar is bound to, what a
// pulled edit writes, and the conflict sink. A pulled edit is ONE SQL transaction
// and ONE Dolt commit covering calendar_period and calendar_binding together, so
// history never shows a period moved without the binding that records why.

import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { commitTables, nowSql } from "./apply-store.js";

const ER_DUP_ENTRY = 1062;

export interface PullBinding {
  readonly beadId: string;
  readonly externalUid: string;
  readonly sequence: number;
  readonly etag: string | null;
  readonly ownershipToken: string | null;
}

export const loadBindings = async (
  conn: Connection,
  calendarId: number,
): Promise<readonly PullBinding[]> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT bead_id, external_uid, external_sequence, last_synced_etag, ownership_token
       FROM calendar_binding WHERE calendar_id = ? ORDER BY id`,
    [calendarId],
  );
  return rows.map((r) => ({
    beadId: String(r.bead_id),
    externalUid: String(r.external_uid),
    sequence: Number(r.external_sequence),
    etag: (r.last_synced_etag as string | null) ?? null,
    ownershipToken: (r.ownership_token as string | null) ?? null,
  }));
};

const toSql = (utc: string): string => utc.slice(0, 19).replace("T", " ");

export interface PulledEdit {
  readonly periodId: number;
  readonly beadId: string;
  readonly calendarId: number;
  /** The times the plan saw locally; a row that moved since is not overwritten. */
  readonly previous: { readonly startUtc: string; readonly endUtc: string };
  readonly startUtc: string;
  readonly endUtc: string;
  readonly etag: string | null;
  /** The remote's `updated`, already a DATETIME string. */
  readonly dtstamp: string;
  readonly syncedAt: string;
}

/** Why nothing was written, or null when the edit landed. */
export const writePulledEdit = (conn: Connection, edit: PulledEdit): Promise<string | null> =>
  commitTables(
    conn,
    ["calendar_period", "calendar_binding"],
    `apply: pull ${edit.beadId}`,
    async () => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT DATE_FORMAT(period_start_utc, '%Y-%m-%dT%H:%i:%sZ') AS start_utc,
              DATE_FORMAT(period_end_utc, '%Y-%m-%dT%H:%i:%sZ') AS end_utc
         FROM calendar_period WHERE id = ? FOR UPDATE`,
        [edit.periodId],
      );
      const row = rows[0];
      if (row === undefined) return "period no longer exists; deletes are not applied";
      if (row.start_utc !== edit.previous.startUtc || row.end_utc !== edit.previous.endUtc) {
        return "period was edited locally after the plan was built; not overwritten";
      }
      const ts = nowSql();
      try {
        await conn.query(
          `UPDATE calendar_period SET period_start_utc = ?, period_end_utc = ?, updated_at = ?
          WHERE id = ?`,
          [toSql(edit.startUtc), toSql(edit.endUtc), ts, edit.periodId],
        );
      } catch (error) {
        if ((error as { errno?: number }).errno !== ER_DUP_ENTRY) throw error;
        return "another period of the same grain already starts at the pulled time";
      }
      await conn.query(
        `UPDATE calendar_binding
          SET external_sequence = external_sequence + 1, last_synced_commit_hash = ?,
              last_synced_etag = ?, last_synced_dtstamp = ?, updated_at = ?
        WHERE bead_id = ? AND calendar_id = ?`,
        [edit.syncedAt, edit.etag, edit.dtstamp, ts, edit.beadId, edit.calendarId],
      );
      return null;
    },
  );

interface ConflictRecord {
  readonly calendarId: number;
  readonly beadId: string;
  readonly externalUid: string;
  readonly reason: string;
  readonly local: unknown;
  readonly remote: unknown;
}

/** Key order is the store's to choose (Dolt normalises JSON), so compare with sorted keys. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

const sameJson = (stored: unknown, wanted: unknown): boolean =>
  canonicalJson(typeof stored === "string" ? JSON.parse(stored) : stored) === canonicalJson(wanted);

/**
 * Write a conflict to the quarantine sink and commit it. The same unresolved
 * conflict seen again next round is not written twice: nothing leaves this table
 * but a human's decision, so a duplicate row would never go away.
 */
export const recordConflict = (conn: Connection, c: ConflictRecord): Promise<boolean> =>
  commitTables(conn, ["calendar_conflict"], `quarantine: ${c.beadId}`, async () => {
    const [open] = await conn.query<RowDataPacket[]>(
      `SELECT local_payload, remote_payload FROM calendar_conflict
        WHERE calendar_id = ? AND external_uid = ? AND reason = ? AND resolved = 0`,
      [c.calendarId, c.externalUid, c.reason],
    );
    if (
      open.some((r) => sameJson(r.local_payload, c.local) && sameJson(r.remote_payload, c.remote))
    ) {
      return false;
    }
    const ts = nowSql();
    await conn.query(
      `INSERT INTO calendar_conflict
         (calendar_id, bead_id, external_uid, reason, local_payload, remote_payload,
          resolved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        c.calendarId,
        c.beadId,
        c.externalUid,
        c.reason,
        JSON.stringify(c.local),
        JSON.stringify(c.remote),
        ts,
        ts,
      ],
    );
    return true;
  });
