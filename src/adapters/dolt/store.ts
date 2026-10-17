// The Dolt-backed store behind the MCP tools.
//
// calendar_period holds one row per commitment: the commitment's name is the
// bead id (linked_bead_id) and also rides in attributes_json so a row read back
// is self-describing. (grain, period_start_utc) is unique, so proposing the same
// slot twice replaces it instead of duplicating it.

import type { RowDataPacket } from "mysql2";
import { createConnection } from "mysql2/promise";
import type { ConflictRecord, PeriodRecord, Store } from "../../mcp/tools.js";
import { config } from "./config.mjs";

type Connection = Awaited<ReturnType<typeof createConnection>>;

const toDb = (utc: string) => utc.slice(0, 19).replace("T", " ");
const fromDb = (value: Date | string) =>
  `${(value instanceof Date ? value.toISOString() : String(value).replace(" ", "T")).slice(0, 19)}Z`;

const nowDb = () => toDb(new Date().toISOString());

interface PeriodRow extends RowDataPacket {
  grain: string;
  period_start_utc: Date | string;
  period_end_utc: Date | string;
  linked_bead_id: string | null;
}

interface ConflictRow extends RowDataPacket {
  bead_id: string | null;
  external_uid: string | null;
  reason: string;
}

const periodOf = (row: PeriodRow): PeriodRecord => ({
  grain: row.grain,
  startUtc: fromDb(row.period_start_utc),
  endUtc: fromDb(row.period_end_utc),
  summary: row.linked_bead_id ?? "",
});

/** True when the environment names a database, so the tools must not fall back silently. */
export const databaseConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  ["CALENDAR_DB_HOST", "CALENDAR_DB_PORT", "CALENDAR_DB_NAME"].some((k) => env[k] !== undefined);

export const openDoltStore = async (
  overrides: Partial<typeof config> = {},
): Promise<Store & { close(): Promise<void> }> => {
  // dateStrings keeps DATETIME as the stored text, so no timezone shift applies.
  const conn: Connection = await createConnection({ ...config, ...overrides, dateStrings: true });
  const query = async <T extends RowDataPacket>(sql: string, params: unknown[] = []) =>
    (await conn.query(sql, params))[0] as T[];
  const selectPeriods = (where: string, params: unknown[]) =>
    query<PeriodRow>(
      `SELECT grain, period_start_utc, period_end_utc, linked_bead_id FROM calendar_period
       ${where} ORDER BY period_start_utc, id`,
      params,
    ).then((rows) => rows.map(periodOf));

  return {
    periodsOnDate: (date) => selectPeriods("WHERE DATE(period_start_utc) = ?", [date]),
    allPeriods: () => selectPeriods("", []),
    addPeriods: async (periods) => {
      for (const p of periods) {
        await conn.query(
          `INSERT INTO calendar_period
             (grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE period_end_utc = VALUES(period_end_utc),
             linked_bead_id = VALUES(linked_bead_id),
             attributes_json = VALUES(attributes_json), updated_at = VALUES(updated_at)`,
          [
            p.grain,
            toDb(p.startUtc),
            toDb(p.endUtc),
            p.summary,
            JSON.stringify({ summary: p.summary }),
            nowDb(),
            nowDb(),
          ],
        );
      }
    },
    moveStart: async (summary, startUtc) => {
      const [found] = await query<PeriodRow>(
        `SELECT grain, period_start_utc, period_end_utc, linked_bead_id FROM calendar_period
         WHERE linked_bead_id = ? ORDER BY id LIMIT 1`,
        [summary],
      );
      if (!found) return false;
      const length =
        Date.parse(fromDb(found.period_end_utc)) - Date.parse(fromDb(found.period_start_utc));
      const end = new Date(Date.parse(startUtc) + length).toISOString();
      await conn.query(
        `UPDATE calendar_period SET period_start_utc = ?, period_end_utc = ?, updated_at = ?
         WHERE linked_bead_id = ? AND grain = ? AND period_start_utc = ?`,
        [toDb(startUtc), toDb(end), nowDb(), summary, found.grain, found.period_start_utc],
      );
      return true;
    },
    unresolvedConflicts: async () =>
      (
        await query<ConflictRow>(
          "SELECT bead_id, external_uid, reason FROM calendar_conflict WHERE resolved = 0 ORDER BY id",
        )
      ).map(
        (r): ConflictRecord => ({
          beadId: r.bead_id,
          externalUid: r.external_uid,
          reason: r.reason,
        }),
      ),
    close: () => conn.end(),
  };
};
