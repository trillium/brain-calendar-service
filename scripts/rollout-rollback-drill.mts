#!/usr/bin/env tsx

// rollout:rollback-drill
//
// A real rollback against a DISPOSABLE Dolt store - real rows, a real commit
// history, a real DOLT_RESET - and it prints the breakdown of where the time
// went, because a bare RTO cannot tell a fast rollback from a mismeasured one.
//
// It refuses to run against a dirty working set. Rolling back discards every
// uncommitted change in the store, and those may belong to another suite.

import { headCommit } from "../src/sync/changedetection/plan.ts";
import {
  clearDrillRows,
  dirtyTables,
  openStore,
  periodCount,
  refuseOnDirty,
  restoreTo,
  writeMigrationRows,
} from "../src/sync/rollout/drill-store.ts";
import { measureRollback } from "../src/sync/rollout/rollback.ts";

/** The commit the drill rolls back to, read through the same reader change detection uses. */
const currentHead = async (conn: Parameters<typeof headCommit>[0]): Promise<string> => {
  const hash = await headCommit(conn);
  if (hash === null) throw new Error("the store has no commits; run db:migrate before the drill");
  return hash;
};

const conn = await openStore();
let wroteDrillRows = false;
try {
  const refusal = refuseOnDirty(await dirtyTables(conn));
  if (refusal !== null) {
    console.error(`rollout:rollback-drill REFUSED: ${refusal}`);
    process.exitCode = 1;
  } else {
    const commitHash = await currentHead(conn);
    const checkpoint = { commitHash, at: Date.now(), rows: await periodCount(conn) };

    const writeStart = Date.now();
    await writeMigrationRows(conn);
    wroteDrillRows = true;
    const writeMs = Date.now() - writeStart;
    const failedAt = {
      commitHash: "half-applied-migration",
      at: Date.now(),
      rows: await periodCount(conn),
    };
    const rowsBefore = failedAt.rows;

    const result = await measureRollback({
      checkpoint,
      failedAt,
      rowsBefore,
      restore: async () => {
        const phases: Record<string, number> = {};
        let mark = Date.now();
        const head = await currentHead(conn);
        phases.detect = Date.now() - mark;
        mark = Date.now();
        await restoreTo(conn, head);
        phases.checkout = Date.now() - mark;
        mark = Date.now();
        const rowsAfter = await periodCount(conn);
        await dirtyTables(conn);
        phases.verify = Date.now() - mark;
        return { ms: Object.values(phases).reduce((a, b) => a + b, 0), phaseMs: phases, rowsAfter };
      },
    });

    // Counted inside restore and handed back to measureRollback, so a broken
    // rollback fails this command instead of being reported as one.
    const rowsAfter = result.rowsAfter;

    console.log("rollout:rollback-drill");
    console.log(`  checkpoint       ${checkpoint.commitHash} (${checkpoint.rows} rows)`);
    console.log(`  half-applied     ${rowsBefore} rows in ${writeMs} ms`);
    console.log(`  rollback to      ${result.to}`);
    console.log(`  RTO (measured)   ${result.rtoMs} ms`);
    console.log(`  RPO              ${failedAt.rows - checkpoint.rows} rows`);
    console.log("");
    console.log("WHAT DOMINATED");
    console.log(
      `  ${result.dominatedBy.phase} at ${(result.dominatedBy.share * 100).toFixed(1)}% of the measured time`,
    );

    const regressions = result.residual.concat(
      rowsAfter === checkpoint.rows
        ? []
        : [`rows after rollback ${rowsAfter}, expected ${checkpoint.rows}`],
      rowsBefore === checkpoint.rows + 12
        ? []
        : [`the half-applied migration wrote ${rowsBefore - checkpoint.rows} rows, expected 12`],
    );

    if (regressions.length > 0) {
      console.error("\nrollout:rollback-drill FAILED:");
      for (const regression of regressions) console.error(`  - ${regression}`);
      process.exitCode = 1;
    } else {
      console.log(
        `\nrollout:rollback-drill PASSED: the store returned to ${rowsAfter} rows, its pre-migration count`,
      );
    }
  }
} finally {
  // Without the close the open connection keeps the event loop alive and the
  // command never exits - the script prints its verdict and then hangs forever.
  // Cleanup is conditional on the drill having written: on a refusal there are
  // no drill rows to remove, and an unconditional delete here would destroy the
  // very rows the refusal exists to protect.
  if (wroteDrillRows) await clearDrillRows(conn);
  await conn.end();
}
