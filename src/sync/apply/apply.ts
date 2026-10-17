// The apply step: take a plan and make it true, then advance the cursor.
//
// Ordering is the safety property:
//   1. every push and pull is applied independently and ends in a typed outcome;
//   2. local writes are committed to Dolt;
//   3. ONLY IF nothing failed or was refused, the cursor moves to that commit.
//
// If the cursor moved past a failed or refused entry, that entry would never be
// planned again, which is how a sync silently loses a change. Holding it back
// costs only a re-plan, and re-applying is safe because INSERT is keyed on a uid
// and a binding that already exists turns an INSERT into an UPDATE.

import { PolicyViolation } from "../loop/policy.js";
import type { SyncPlan } from "../orchestration/plan.js";
import type { ApplyContext } from "./context.js";
import { applyPull } from "./pull.js";
import { applyPush } from "./push.js";
import type { ApplyOutcome, ApplyResult } from "./types.js";

const settle = async (run: () => Promise<ApplyOutcome>, key: string): Promise<ApplyOutcome> => {
  try {
    return await run();
  } catch (error) {
    // Typed, not swallowed: a policy refusal and an error are different states.
    if (error instanceof PolicyViolation) return { kind: "refused", key, reason: error.message };
    return { kind: "failed", key, error: error instanceof Error ? error.message : String(error) };
  }
};

/** The tables apply may write. Staged by name, never `.`, so it cannot sweep up anyone else's work. */
const OWNED_TABLES = ["calendar_period", "calendar_binding", "calendar_conflict"] as const;

/**
 * Local edits that are not committed are invisible to change detection, which
 * diffs commits. If apply committed them it would advance the cursor past a
 * change nobody ever pushed. So it refuses to start instead.
 */
const dirtyTables = async (ctx: ApplyContext): Promise<string[]> => {
  const [rows] = await ctx.conn.query("SELECT table_name FROM dolt_status");
  const dirty = new Set((rows as { table_name: string }[]).map((r) => r.table_name));
  return OWNED_TABLES.filter((t) => dirty.has(t));
};

const commitLocal = async (ctx: ApplyContext, message: string): Promise<string | null> => {
  for (const table of OWNED_TABLES) await ctx.conn.query("CALL DOLT_ADD(?)", [table]);
  // --allow-empty: an all-skipped plan still gets a commit, so "applied nothing"
  // is a recorded round rather than an error.
  await ctx.conn.query("CALL DOLT_COMMIT('--allow-empty', '-m', ?)", [message]);
  const [head] = await ctx.conn.query(
    "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1",
  );
  return (head as { commit_hash: string }[])[0]?.commit_hash ?? null;
};

const advanceCursor = async (ctx: ApplyContext, hash: string): Promise<void> => {
  const ts = ctx.now();
  await ctx.conn.query(
    `UPDATE calendar_sync_cursor SET last_synced_commit_hash = ?, last_round_at = ?, updated_at = ?
      WHERE source_database = ? AND calendar_id = ?`,
    [hash, ts, ts, "brain_calendar_service", ctx.calendarId],
  );
};

export const applyPlan = async (ctx: ApplyContext, plan: SyncPlan): Promise<ApplyResult> => {
  if (plan.push.length + plan.pull.length === 0) {
    return { outcomes: [], committedHash: null, cursorAdvancedTo: null };
  }
  const dirty = await dirtyTables(ctx);
  if (dirty.length > 0) {
    const error = `uncommitted changes in ${dirty.join(", ")}; commit them so they can be planned`;
    return {
      outcomes: [{ kind: "failed", key: "preflight", error }],
      committedHash: null,
      cursorAdvancedTo: null,
    };
  }
  const outcomes: ApplyOutcome[] = [];
  for (const push of plan.push) {
    outcomes.push(await settle(() => applyPush(ctx, push), push.beadId));
  }
  for (const pull of plan.pull) {
    outcomes.push(await settle(() => applyPull(ctx, pull), pull.externalUid));
  }

  const clean = outcomes.every((o) => o.kind === "applied" || o.kind === "skipped");
  // Quarantine rows from a refused delete are local writes too; commit them
  // either way so the human gate item is durable, but only advance when clean.
  const committedHash = await commitLocal(ctx, `sync:once calendar ${ctx.calendarId}`);
  if (!clean || committedHash === null) {
    return { outcomes, committedHash, cursorAdvancedTo: null };
  }
  await advanceCursor(ctx, committedHash);
  return { outcomes, committedHash, cursorAdvancedTo: committedHash };
};
