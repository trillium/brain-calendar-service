// Apply the push half of a plan to one provider calendar.
//
// What this step may do is deliberately narrow: INSERT and UPDATE on the one
// calendar the SyncPolicy names, nothing else. There is no delete here, and a
// planned push for a period that no longer exists is reported as skipped rather
// than turned into one.
//
// Order of effects for a create, and why:
//
//   1. look for an event already carrying this period's marker (adopt, never duplicate)
//   2. provider.createEvent, with the marker and a freshly minted ownership token
//   3. in one Dolt transaction, write calendar_binding and commit it
//
// If 2 lands and 3 does not, the next round finds the marker in step 1 and
// completes the binding. The cursor moves only after every push succeeded, and
// any error is returned as a typed failure with the cursor left where it was.

import type { Connection } from "mysql2/promise";
import type { CalendarProvider } from "../../adapters/provider.js";
import { allow, type SyncPolicy } from "../loop/policy.js";
import {
  applyOne,
  type Context,
  type FailureKind,
  messageOf,
  type Skipped,
  StepFailure,
  viaStore,
} from "./apply-steps.js";
import { doltHead, logLength, moveCursor } from "./apply-store.js";
import type { SyncPlan } from "./plan.js";

/** The only policy a push may run under: INSERT and UPDATE on one calendar. */
export const pushPolicy = (provider: string, remoteCalendarId: string): SyncPolicy =>
  allow(provider, [
    [remoteCalendarId, "INSERT"],
    [remoteCalendarId, "UPDATE"],
  ]);

interface ApplyInput {
  readonly conn: Connection;
  readonly provider: CalendarProvider;
  readonly plan: SyncPlan;
  readonly policy: SyncPolicy;
  readonly calendar: { readonly id: number; readonly remoteCalendarId: string };
  readonly sourceDatabase: string;
}

interface Counts {
  created: number;
  updated: number;
  adopted: number;
  skipped: Skipped[];
}

export type ApplyResult =
  | (Counts & {
      readonly state: "ok";
      readonly cursorBefore: string | null;
      readonly cursorAfter: string;
    })
  | (Counts & {
      readonly state: "failed";
      readonly kind: FailureKind;
      readonly message: string;
      /** The push being applied when it failed; null for a failure outside the loop. */
      readonly at: string | null;
      /** Always the cursor the round started with: a failed round never moves it. */
      readonly cursorBefore: string | null;
    });

/**
 * Where the cursor may move to. HEAD, when every commit since the plan was ours;
 * otherwise the head the plan was built at, so a change someone else committed
 * mid-round is diffed next time rather than skipped.
 */
const cursorTarget = async (
  ctx: Context,
  logAtStart: number,
  ownCommits: number,
): Promise<string> => {
  const head = await viaStore(() => doltHead(ctx.conn));
  const planned = ctx.plan.observations.doltHeadBefore;
  const quiet = (await viaStore(() => logLength(ctx.conn))) === logAtStart + ownCommits;
  return quiet || planned === null ? head : planned;
};

const failed = (
  counts: Counts,
  plan: SyncPlan,
  error: unknown,
  at: string | null,
): ApplyResult => ({
  ...counts,
  state: "failed",
  kind: error instanceof StepFailure ? error.kind : "store",
  message: error instanceof StepFailure ? error.message : messageOf(error),
  at,
  cursorBefore: plan.cursorBefore,
});

const refusal = (plan: SyncPlan): StepFailure | null => {
  if (plan.conflictsQuarantined > 0) {
    return new StepFailure(
      "quarantined",
      `plan quarantined ${plan.conflictsQuarantined} item(s); nothing is applied and the cursor stays`,
    );
  }
  if (plan.cursorBefore === null) {
    return new StepFailure("cursor", "plan has no cursor to advance from; refusing to apply");
  }
  return null;
};

export const applyPlan = async (input: ApplyInput): Promise<ApplyResult> => {
  const counts: Counts = { created: 0, updated: 0, adopted: 0, skipped: [] };
  const refused = refusal(input.plan);
  if (refused !== null) return failed(counts, input.plan, refused, null);
  const ctx: Context = { ...input, listed: null };
  const logAtStart = await logLength(input.conn);
  let ownCommits = 0;
  for (const push of input.plan.push) {
    try {
      const outcome = await applyOne(ctx, push);
      if (typeof outcome === "string") {
        counts[outcome] += 1;
        ownCommits += 1;
      } else counts.skipped.push(outcome);
    } catch (error) {
      return failed(counts, input.plan, error, push.beadId);
    }
  }
  try {
    const target = await cursorTarget(ctx, logAtStart, ownCommits);
    const moved = await viaStore(() =>
      moveCursor(input.conn, input.sourceDatabase, input.calendar.id, target),
    );
    if (!moved) throw new StepFailure("cursor", "no calendar_sync_cursor row to advance");
    return { ...counts, state: "ok", cursorBefore: input.plan.cursorBefore, cursorAfter: target };
  } catch (error) {
    return failed(counts, input.plan, error, null);
  }
};
