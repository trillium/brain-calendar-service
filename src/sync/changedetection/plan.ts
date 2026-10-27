// Change detection over Dolt history and diff.
//
// RFC 5546 semantics live HERE, in application code, and never in Dolt. Dolt's
// merge is cell-wise with a single strategy and custom merge functions do not
// exist, so teaching Dolt "highest SEQUENCE wins" is not an option - and it
// would be the wrong option anyway, because a cell-wise merge can produce a row
// that no RFC 5546 reading endorses (two different fields each "won" by a
// different writer).
//
// The query used is the table function form:
//
//   SELECT * FROM DOLT_DIFF(<fromCommit>, 'HEAD', <table>)
//
// because `dolt_commit_diff_<table>` refuses to answer unless given both ends
// explicitly, and `DOLT_DIFF()` is a table function that must appear in FROM.

import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";

type DetectionState =
  | { readonly state: "ok"; readonly changedIds: readonly number[] }
  | { readonly state: "full_resync_required"; readonly reason: string };

type DiffRow = RowDataPacket;

// The columns whose change means something for the calendar, per table. Bookkeeping
// columns (created_at, updated_at, last_synced_commit_hash) are left out on purpose:
// recording a sync is not an edit. A table not listed here is a period-shaped table.
const PERIOD_COLUMNS = ["period_start_utc", "period_end_utc"] as const;
const WATCHED_COLUMNS: Record<string, readonly string[]> = {
  calendar_period: PERIOD_COLUMNS,
  calendar_binding: [
    "bead_id",
    "calendar_id",
    "external_uid",
    "external_sequence",
    "last_synced_etag",
    "last_synced_dtstamp",
    "ownership_token",
  ],
};

/**
 * Which rows changed between `fromCommit` and HEAD, and whether any of those
 * changes are actually temporal.
 *
 * A row whose ONLY change is to a column that is not watched for its table produces zero calendar
 * writes: renaming a period or re-linking it to a different bead does not move
 * anything on anybody's calendar, and treating it as a change is how a sync
 * engine starts writing events nobody edited.
 */
export const detectChanges = async (
  conn: Connection,
  table: string,
  fromCommit: string | null,
): Promise<DetectionState> => {
  if (fromCommit === null) {
    return { state: "full_resync_required", reason: "no cursor recorded yet" };
  }

  const [known] = await conn.query<RowDataPacket[]>(
    "SELECT commit_hash FROM dolt_log WHERE commit_hash = ? LIMIT 1",
    [fromCommit],
  );
  if (known.length === 0) {
    // The typed state the plan asks for: loud, correct, and a DIFFERENT action
    // (a full resync) rather than a quiet wrong one (an empty diff that reads as
    // "nothing changed" and silently stops syncing forever).
    return {
      state: "full_resync_required",
      reason: `cursor commit ${fromCommit} is absent from dolt_log (Dolt reset, GC, or a different database)`,
    };
  }

  const [rows] = await conn.query<DiffRow[]>("SELECT * FROM DOLT_DIFF(?, 'HEAD', ?) AS d", [
    fromCommit,
    table,
  ]);

  const changedIds = new Set<number>();
  for (const row of rows) {
    const id = row.to_id ?? row.from_id;
    if (id === null || id === undefined) continue;
    const moved = (WATCHED_COLUMNS[table] ?? PERIOD_COLUMNS).some(
      (col) => String(row[`to_${col}`] ?? "") !== String(row[`from_${col}`] ?? ""),
    );
    if (moved) changedIds.add(Number(id));
  }

  return { state: "ok", changedIds: [...changedIds].sort((a, b) => a - b) };
};

/** The commit hash to record after a successful round. */
export const headCommit = async (conn: Connection): Promise<string | null> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1",
  );
  return rows[0]?.commit_hash ?? null;
};
