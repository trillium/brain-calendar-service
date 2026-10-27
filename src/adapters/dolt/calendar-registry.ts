// The calendar registry: calendar_calendar(provider, remote_calendar_id).
//
// A Google calendar id is a string; the store keys everything on a BIGINT
// calendar_id. This table is the only place the two meet, so a remote id can
// never reach the store un-resolved and a numeric id can never reach a provider
// without naming the remote calendar it stands for.
//
// Registering writes nothing to any provider. It is a Dolt commit of one row.

import type { Connection, RowDataPacket } from "mysql2/promise";
import { calendarIdFromAlias } from "./calendar-id.js";

export interface RegisteredCalendar {
  readonly id: number;
  readonly provider: string;
  readonly remoteCalendarId: string;
  readonly displayName: string;
}

export class CalendarNotRegistered extends Error {
  constructor(reference: string) {
    super(
      `calendar "${reference}" is not registered; register it first with ` +
        "`pnpm run calendar:register --provider <p> --remote-id <id> --name <label>`",
    );
    this.name = "CalendarNotRegistered";
  }
}

const NUMERIC = /^(cal-)?[0-9]+$/;
const nowSql = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

const toCalendar = (row: RowDataPacket): RegisteredCalendar => ({
  id: Number(row.id),
  provider: String(row.provider),
  remoteCalendarId: String(row.remote_calendar_id),
  displayName: String(row.display_name),
});

/** The numeric forms the CLI and the MCP tools have always accepted: `3` and `cal-3`. */
export const isNumericReference = (reference: string): boolean => NUMERIC.test(reference);

const findRegistered = async (
  conn: Connection,
  provider: string,
  remoteCalendarId: string,
): Promise<RegisteredCalendar | null> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, provider, remote_calendar_id, display_name FROM calendar_calendar " +
      "WHERE provider = ? AND remote_calendar_id = ?",
    [provider, remoteCalendarId],
  );
  return rows[0] === undefined ? null : toCalendar(rows[0]);
};

/** Idempotent: registering the same (provider, remote id) again returns the existing row. */
export const registerCalendar = async (
  conn: Connection,
  input: { provider: string; remoteCalendarId: string; displayName: string },
): Promise<RegisteredCalendar> => {
  if (input.provider.trim() === "" || input.remoteCalendarId.trim() === "") {
    throw new Error("registering a calendar needs a provider and a remote calendar id");
  }
  const existing = await findRegistered(conn, input.provider, input.remoteCalendarId);
  if (existing !== null) return existing;
  const ts = nowSql();
  await conn.query(
    `INSERT INTO calendar_calendar
       (provider, remote_calendar_id, display_name, capabilities, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
    [input.provider, input.remoteCalendarId, input.displayName, ts, ts],
  );
  await conn.query("CALL DOLT_ADD('calendar_calendar')");
  await conn.query("CALL DOLT_COMMIT('--skip-empty', '-m', ?)", [
    `registry: register ${input.provider} calendar ${input.displayName}`,
  ]);
  const created = await findRegistered(conn, input.provider, input.remoteCalendarId);
  if (created === null) throw new Error("calendar registration did not persist");
  return created;
};

/**
 * Resolve a `--calendar` reference. `3` and `cal-3` name a store id; anything
 * else is a remote calendar id looked up under `provider`. Returns null for a
 * store id with no registry row, so a dry-run keeps working for a bare id while
 * a live apply (which needs the remote id) can refuse it.
 */
export const resolveCalendar = async (
  conn: Connection,
  reference: string,
  provider: string,
): Promise<{ id: number; registered: RegisteredCalendar | null }> => {
  if (isNumericReference(reference)) {
    const id = calendarIdFromAlias(reference);
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT id, provider, remote_calendar_id, display_name FROM calendar_calendar WHERE id = ?",
      [id],
    );
    return { id, registered: rows[0] === undefined ? null : toCalendar(rows[0]) };
  }
  const registered = await findRegistered(conn, provider, reference);
  if (registered === null) throw new CalendarNotRegistered(reference);
  return { id: registered.id, registered };
};
