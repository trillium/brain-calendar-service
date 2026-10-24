// The MCP tools' store, backed by this service's own Dolt database.
//
// Periods live in calendar_period, links in calendar_binding, quarantine in
// calendar_conflict. A commitment is a day-grain period whose linked_bead_id is
// its name, which is how the tools have always addressed one (beadId is the
// summary). Every write is committed to Dolt history, because change detection
// diffs history from the sync cursor and an uncommitted write is invisible to it.

import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { createPool } from "mysql2/promise";
import {
  type LinkRequest,
  type PeriodRecord,
  type QuarantinedConflict,
  type Store,
  StoreConflict,
} from "../../mcp/store.js";
import { calendarIdFromAlias } from "./calendar-id.js";
import { config } from "./config.mjs";

const ER_DUP_ENTRY = 1062;

const toSql = (utc: string): string => utc.slice(0, 19).replace("T", " ");
const fromSql = (sql: string): string => `${sql.slice(0, 10)}T${sql.slice(11, 19)}Z`;
const nowSql = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

interface PeriodRow extends RowDataPacket {
  grain: PeriodRecord["grain"];
  period_start_utc: string;
  period_end_utc: string;
  linked_bead_id: string | null;
  attributes_json: unknown;
}

const summaryOf = (row: PeriodRow): string => {
  const attributes =
    typeof row.attributes_json === "string" ? JSON.parse(row.attributes_json) : row.attributes_json;
  const summary = (attributes as { summary?: unknown } | null)?.summary;
  return typeof summary === "string" ? summary : (row.linked_bead_id ?? "");
};

const toRecord = (row: PeriodRow): PeriodRecord => ({
  grain: row.grain,
  startUtc: fromSql(row.period_start_utc),
  endUtc: fromSql(row.period_end_utc),
  summary: summaryOf(row),
});

const isDuplicate = (error: unknown): boolean =>
  (error as { errno?: number }).errno === ER_DUP_ENTRY;

export const createDoltStore = (database: string = config.database): Store => {
  const pool: Pool = createPool({ ...config, database, connectionLimit: 4, dateStrings: true });
  // One writer at a time: a write is a SQL transaction followed by a Dolt commit,
  // and two interleaved would commit each other's staged rows.
  let writes: Promise<unknown> = Promise.resolve();

  /** Run `body` in a SQL transaction, then commit what it staged to Dolt history. */
  const write = <T>(message: string, work: (conn: PoolConnection) => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        let result: T;
        try {
          result = await work(conn);
          await conn.commit();
        } catch (error) {
          await conn.rollback();
          throw error;
        }
        await conn.query("CALL DOLT_ADD('calendar_period', 'calendar_binding')");
        await conn.query("CALL DOLT_COMMIT('--skip-empty', '-m', ?)", [message]);
        return result;
      } finally {
        conn.release();
      }
    };
    const next = writes.then(run, run);
    writes = next.catch(() => undefined);
    return next;
  };

  return {
    periodsBetween: async (fromUtc: string, toUtc: string): Promise<PeriodRecord[]> => {
      const [rows] = await pool.query<PeriodRow[]>(
        `SELECT grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json
         FROM calendar_period
        WHERE period_start_utc >= ? AND period_start_utc < ?
        ORDER BY period_start_utc, id`,
        [toSql(fromUtc), toSql(toUtc)],
      );
      return rows.map(toRecord);
    },

    listPeriods: async (beadId?: string): Promise<PeriodRecord[]> => {
      const [rows] = await pool.query<PeriodRow[]>(
        `SELECT grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json
         FROM calendar_period
        WHERE (? IS NULL OR linked_bead_id = ?)
        ORDER BY period_start_utc, id`,
        [beadId ?? null, beadId ?? null],
      );
      return rows.map(toRecord);
    },

    addPeriods: (periods: readonly PeriodRecord[]): Promise<void> => {
      return write(`mcp: propose ${periods.length} period(s)`, async (conn) => {
        for (const p of periods) {
          const [existing] = await conn.query<PeriodRow[]>(
            `SELECT grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json
             FROM calendar_period WHERE grain = ? AND period_start_utc = ? FOR UPDATE`,
            [p.grain, toSql(p.startUtc)],
          );
          const clash = existing[0];
          if (clash !== undefined) {
            if (clash.linked_bead_id === p.summary) continue;
            throw new StoreConflict(
              `${p.grain} period at ${p.startUtc} already holds "${clash.linked_bead_id}"; ` +
                `refusing to overwrite it with "${p.summary}"`,
            );
          }
          await conn.query(
            `INSERT INTO calendar_period
             (grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              p.grain,
              toSql(p.startUtc),
              toSql(p.endUtc),
              p.summary,
              JSON.stringify({ summary: p.summary }),
              nowSql(),
              nowSql(),
            ],
          );
        }
        return undefined;
      });
    },

    movePeriod: (beadId: string, newStartUtc: string): Promise<PeriodRecord | null> => {
      return write(`mcp: move ${beadId}`, async (conn) => {
        const [found] = await conn.query<(PeriodRow & { id: number })[]>(
          `SELECT id, grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json
           FROM calendar_period WHERE linked_bead_id = ?
          ORDER BY period_start_utc, id LIMIT 1 FOR UPDATE`,
          [beadId],
        );
        const row = found[0];
        if (row === undefined) return null;
        const length =
          Date.parse(fromSql(row.period_end_utc)) - Date.parse(fromSql(row.period_start_utc));
        const newEnd = new Date(Date.parse(newStartUtc) + length).toISOString();
        try {
          await conn.query(
            `UPDATE calendar_period
              SET period_start_utc = ?, period_end_utc = ?, updated_at = ? WHERE id = ?`,
            [toSql(newStartUtc), toSql(newEnd), nowSql(), row.id],
          );
        } catch (error) {
          if (!isDuplicate(error)) throw error;
          throw new StoreConflict(`another ${row.grain} period already starts at ${newStartUtc}`);
        }
        return {
          ...toRecord(row),
          startUtc: fromSql(toSql(newStartUtc)),
          endUtc: fromSql(toSql(newEnd)),
        };
      });
    },

    link: (request: LinkRequest): Promise<void> => {
      const calendarId = calendarIdFromAlias(request.calendarId);
      return write(`mcp: link ${request.beadId}`, async (conn) => {
        const [existing] = await conn.query<RowDataPacket[]>(
          "SELECT external_uid FROM calendar_binding WHERE bead_id = ? AND calendar_id = ? FOR UPDATE",
          [request.beadId, calendarId],
        );
        const current = existing[0]?.external_uid as string | undefined;
        if (current === request.externalUid) return;
        if (current !== undefined) {
          throw new StoreConflict(
            `${request.beadId} is already linked to ${current} on ${request.calendarId}; unlink first`,
          );
        }
        try {
          await conn.query(
            `INSERT INTO calendar_binding
             (bead_id, calendar_id, external_uid, external_sequence, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
            [request.beadId, calendarId, request.externalUid, nowSql(), nowSql()],
          );
        } catch (error) {
          if (!isDuplicate(error)) throw error;
          throw new StoreConflict(
            `${request.externalUid} is already linked to another record on ${request.calendarId}`,
          );
        }
      });
    },

    unlink: (beadId: string, calendarId: string): Promise<boolean> => {
      const id = calendarIdFromAlias(calendarId);
      return write(`mcp: unlink ${beadId}`, async (conn) => {
        const [result] = await conn.query<ResultSetHeader>(
          "DELETE FROM calendar_binding WHERE bead_id = ? AND calendar_id = ?",
          [beadId, id],
        );
        return result.affectedRows > 0;
      });
    },

    quarantined: async (): Promise<QuarantinedConflict[]> => {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT bead_id, external_uid, reason FROM calendar_conflict WHERE resolved = 0 ORDER BY id",
      );
      return rows.map((r) => ({
        beadId: (r.bead_id as string | null) ?? null,
        externalUid: (r.external_uid as string | null) ?? null,
        reason: r.reason as string,
      }));
    },

    close: async (): Promise<void> => {
      await writes.catch(() => undefined);
      await pool.end();
    },
  };
};
