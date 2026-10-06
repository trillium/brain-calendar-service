// Real Dolt access for the rollback drill.
//
// The drill's whole claim is that rollback works. A drill that measures a mock
// proves nothing about Dolt's history semantics, which are the part most likely
// to differ from what the plan assumed. So this module talks to the disposable
// store for real, and the script keeps only the orchestration and the printing.
//
// Every write it makes is fenced to its own future-dated fixture rows, so a
// drill that fails halfway cannot leave the store looking migrated.

import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { createConnection } from "mysql2/promise";
import { config } from "../../adapters/dolt/config.mjs";

/** The drill owns every period row from this date onward, and deletes nothing else. */
const DRILL_FROM_UTC = "2031-01-01 00:00:00";

const DRILL_ROWS = 12;

/**
 * Uncommitted rows belong to whoever wrote them.
 *
 * A rollback discards every uncommitted change in the store, including rows
 * another suite wrote a second earlier. Refusing on a dirty store is the
 * difference between a drill that proves rollback works and one that silently
 * destroys another suite's setup and then reports a green rollback.
 *
 * The check is on uncommitted ROWS, not on `dolt_status`. Dolt records an
 * advanced AUTO_INCREMENT counter as a working-set schema change, so a suite
 * that merely inserts and deletes a row leaves `dolt_status` permanently
 * "modified" and a status-based check would refuse to drill forever.
 */
export const refuseOnDirty = (dirtyTables: readonly string[]): string | null =>
  dirtyTables.length === 0
    ? null
    : `uncommitted rows in ${dirtyTables.join(", ")} - refusing to discard another writer's rows. Commit or reset them, then re-run.`;

export const openStore = (): Promise<Connection> => createConnection(config);

const firstRow = async (conn: Connection, sql: string): Promise<RowDataPacket> => {
  const [rows] = await conn.query<RowDataPacket[]>(sql);
  const row = rows[0];
  if (row === undefined) throw new Error(`no rows returned by: ${sql}`);
  return row;
};

/**
 * Tables holding uncommitted rows in the working set; empty means safe to roll back.
 *
 * This reads the `dolt_diff` summary filtered to the working set, which is the
 * net difference between HEAD and what is uncommitted right now. The per-table
 * row diffs are NOT a substitute: Dolt keeps an entry for a row that was
 * inserted and deleted inside the working set, so a test suite that round-trips
 * a row leaves the row diffs permanently non-empty while the store is in fact
 * identical to HEAD.
 *
 * The table list comes from `information_schema`; Dolt's `dolt_diff_*` system
 * tables are not listed there.
 */
export const dirtyTables = async (conn: Connection): Promise<string[]> => {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT table_name FROM dolt_diff WHERE commit_hash = 'WORKING' AND data_change > 0",
  );
  return rows.map((row) => String(row.table_name));
};

export const periodCount = async (conn: Connection): Promise<number> =>
  Number((await firstRow(conn, "SELECT COUNT(*) AS n FROM calendar_period")).n);

/**
 * Stand in for the half-applied migration: real rows, in the real table, left
 * uncommitted on purpose. Uncommitted is the point - it is the state a crashed
 * migration leaves behind, and the only thing a rollback can recover from.
 */
export const writeMigrationRows = async (conn: Connection, rows = DRILL_ROWS): Promise<void> => {
  for (let n = 0; n < rows; n += 1) {
    const day = String(n + 1).padStart(2, "0");
    await conn.query(
      "INSERT INTO calendar_period (grain, period_start_utc, period_end_utc, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())",
      [
        "day",
        `2031-01-${day} 00:00:00`,
        `2031-01-${day} 23:59:59`,
        JSON.stringify({ rollout_drill: "write", n }),
      ],
    );
  }
};

/** The rollback itself: return the working set to a named commit. */
export const restoreTo = async (conn: Connection, commitHash: string): Promise<void> => {
  await conn.query("CALL DOLT_RESET('--hard', ?)", [commitHash]);
};

/** Undo the fixture writes the Dolt way rather than deleting them by hand. */
export const clearDrillRows = async (conn: Connection): Promise<void> => {
  await conn.query("DELETE FROM calendar_period WHERE period_start_utc >= ?", [DRILL_FROM_UTC]);
};
