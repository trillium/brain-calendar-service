// Vitest globalSetup: leave the disposable Dolt working set as the suite found it.
//
// Some suites insert and delete rows (and burn auto-increment values), which Dolt
// reports as uncommitted changes. That made `rollout:rollback-drill` refuse to run
// after the suite. When the working set was clean on entry, the suite owns every
// change in it, so teardown discards them. A set that was already dirty on entry
// may hold someone else's work and is never touched.

import { createConnection } from "mysql2/promise";
import { config } from "../src/adapters/dolt/config.mjs";

const dirtyCount = async (conn: Awaited<ReturnType<typeof createConnection>>): Promise<number> => {
  const [rows] = await conn.query("SELECT COUNT(*) AS n FROM dolt_status");
  return Number((rows as { n: number }[])[0]?.n ?? 0);
};

let ownsWorkingSet = false;

export async function setup(): Promise<void> {
  const conn = await createConnection(config).catch(() => null);
  if (conn === null) return;
  try {
    ownsWorkingSet = (await dirtyCount(conn)) === 0;
  } finally {
    await conn.end();
  }
}

export async function teardown(): Promise<void> {
  if (!ownsWorkingSet) return;
  const conn = await createConnection(config);
  try {
    await conn.query("CALL DOLT_RESET('--hard')");
  } finally {
    await conn.end();
  }
}
