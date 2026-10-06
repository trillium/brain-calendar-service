// The rollback drill.
//
// A rollback that is never exercised is a belief, not a capability. This performs
// a real rollback against a DISPOSABLE store - not a mock, not a dry-run - and
// prints measured RTO and RPO together with WHAT DOMINATED them, because a bare
// number cannot tell a fast rollback from a mismeasured one (plan 7.0 T2b).

interface Checkpoint {
  readonly commitHash: string;
  readonly at: number;
  readonly rows: number;
}

interface RollbackResult {
  readonly ok: boolean;
  readonly from: string;
  readonly to: string;
  readonly rtoMs: number;
  /** Rows written between the checkpoint and the failure: what a rollback loses. */
  readonly rpoRows: number;
  readonly rpoMs: number;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  readonly dominatedBy: { kind: "time" | "rows"; phase: string; share: number };
  readonly residual: string[];
}

/**
 * Measure the rollback rather than assert it.
 *
 * `restore` is injected so the drill can run against a real store in the harness
 * and against a scripted store in the unit test - but the MEASUREMENT is the
 * same code either way, which is the point: the numbers are never asserted, only
 * computed.
 *
 * The post-rollback row count comes BACK from restore rather than going in as a
 * parameter, because the caller cannot know it until the rollback has happened.
 * Passing it in is how a drill ends up comparing a hardcoded 10 to itself and
 * reporting a green rollback for a rollback that never happened.
 */
export const measureRollback = (input: {
  checkpoint: Checkpoint;
  failedAt: Checkpoint;
  rowsBefore: number;
  restore: (to: string) => Promise<{
    ms: number;
    phaseMs: Record<string, number>;
    rowsAfter: number;
  }>;
}): Promise<RollbackResult> => {
  const restoreStart = Date.now();
  return input.restore(input.checkpoint.commitHash).then((restored) => {
    const rtoMs = Date.now() - restoreStart;
    const rpoMs = input.failedAt.at - input.checkpoint.at;
    // RPO is what the FAILURE would cost: rows written between the last good
    // checkpoint and the failure. rowsAfter is the post-rollback verification, a
    // different number entirely.
    const rpoRows = Math.max(0, input.failedAt.rows - input.checkpoint.rows);
    const rowsAfter = restored.rowsAfter;
    const residual: string[] = [];
    if (rowsAfter !== input.checkpoint.rows) {
      residual.push(
        `store did not return to its pre-migration state: ${input.rowsBefore} -> ${rowsAfter}, expected ${input.checkpoint.rows}`,
      );
    }
    const total = Object.values(restored.phaseMs).reduce((a, b) => a + b, 0) || 1;
    const [phase, ms] = Object.entries(restored.phaseMs).sort((a, b) => b[1] - a[1])[0] ?? [
      "unknown",
      0,
    ];
    return {
      ok: residual.length === 0,
      from: input.failedAt.commitHash,
      to: input.checkpoint.commitHash,
      rtoMs,
      rpoRows,
      rpoMs,
      rowsBefore: input.rowsBefore,
      rowsAfter,
      dominatedBy: { kind: "time", phase, share: ms / total },
      residual,
    };
  });
};
