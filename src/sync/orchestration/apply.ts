// Apply the push half of a plan to one provider calendar.
//
// What this step may do is deliberately narrow: INSERT and UPDATE on the one
// calendar the SyncPolicy names, nothing else. There is no delete here, and a
// planned push for a period that no longer exists is reported as skipped rather
// than turned into one. A round with any such skip is incomplete: the skips are
// returned and the cursor stays, so the next round sees them again.
//
// The pull half runs first and touches only Dolt: each planned pull is one commit
// moving a calendar_period row to what the provider holds. A pull that cannot be
// applied (the period moved locally in the meantime, say) is a skip like any other.
// An in-sync event whose etag moved has that etag recorded on its binding, so the
// binding keeps naming the provider copy the service last agreed with.
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
import { applyPull, applyRefresh } from "./apply-pull.js";
import {
  applyOne,
  type Context,
  type FailureKind,
  messageOf,
  StepFailure,
  viaStore,
} from "./apply-steps.js";
import { doltHead, logLength, moveCursor } from "./apply-store.js";
import type { SyncPlan } from "./plan.js";
import { recordConflict } from "./pull-store.js";
import type { Skipped } from "./pull-types.js";

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
  /** Set when the provider could not be read: the round applies nothing and says why. */
  readonly readFailure?: StepFailure;
}

interface Counts {
  pulled: number;
  refreshed: number;
  created: number;
  updated: number;
  adopted: number;
  unchanged: number;
  skipped: Skipped[];
}

export type ApplyResult =
  | (Counts & {
      readonly state: "ok";
      readonly cursorBefore: string | null;
      readonly cursorAfter: string;
    })
  | (Counts & {
      /** Every push that could be applied was; `skipped` lists the ones that could not. */
      readonly state: "incomplete";
      /** Always the cursor the round started with: the skips are diffed again next round. */
      readonly cursorBefore: string | null;
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

const refusal = (plan: SyncPlan, readFailure?: StepFailure): StepFailure | null => {
  if (readFailure !== undefined) return readFailure;
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

/** A failure tagged with the item being applied when it happened. */
class AtItem extends Error {
  constructor(
    readonly at: string,
    readonly original: unknown,
  ) {
    super("step failed");
  }
}

const inItem = async <T>(at: string, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw new AtItem(at, error);
  }
};

/** Returns how many Dolt commits this step made, so the cursor can tell they were ours. */
const applyAll = async (ctx: Context, counts: Counts): Promise<number> => {
  let commits = 0;
  for (const pull of ctx.plan.pull) {
    const outcome = await inItem(pull.beadId, () => applyPull(ctx, pull));
    if (typeof outcome !== "string") counts.skipped.push(outcome);
    else {
      counts.pulled += 1;
      commits += 1;
    }
  }
  for (const refresh of ctx.plan.refresh) {
    await inItem(refresh.beadId, () => applyRefresh(ctx, refresh));
    counts.refreshed += 1;
    commits += 1;
  }
  for (const push of ctx.plan.push) {
    const outcome = await inItem(push.beadId, () => applyOne(ctx, push));
    if (typeof outcome !== "string") counts.skipped.push(outcome);
    else {
      counts[outcome] += 1;
      if (outcome !== "unchanged") commits += 1;
    }
  }
  return commits;
};

/** Quarantine writes the conflict down; it never resolves it, and it is the only sink. */
const holdConflicts = async (input: ApplyInput): Promise<void> => {
  for (const held of input.plan.quarantined) {
    if (held.conflict === undefined) continue;
    await viaStore(() =>
      recordConflict(input.conn, {
        calendarId: input.calendar.id,
        beadId: held.beadId ?? "",
        externalUid: held.externalUid ?? "",
        reason: held.conflict?.code ?? "",
        local: held.conflict?.local,
        remote: held.conflict?.remote,
      }),
    );
  }
};

export const applyPlan = async (input: ApplyInput): Promise<ApplyResult> => {
  const counts: Counts = {
    pulled: 0,
    refreshed: 0,
    created: 0,
    updated: 0,
    adopted: 0,
    unchanged: 0,
    skipped: [...input.plan.pullSkipped],
  };
  const refused = refusal(input.plan, input.readFailure);
  if (refused !== null) {
    try {
      await holdConflicts(input);
    } catch (error) {
      return failed(counts, input.plan, error, null);
    }
    return failed(counts, input.plan, refused, null);
  }
  const ctx: Context = input;
  let logAtStart: number;
  let commits: number;
  try {
    logAtStart = await viaStore(() => logLength(input.conn));
    commits = await applyAll(ctx, counts);
  } catch (error) {
    return error instanceof AtItem
      ? failed(counts, input.plan, error.original, error.at)
      : failed(counts, input.plan, error, null);
  }
  if (counts.skipped.length > 0) {
    return { ...counts, state: "incomplete", cursorBefore: input.plan.cursorBefore };
  }
  try {
    const target = await cursorTarget(ctx, logAtStart, commits);
    const moved = await viaStore(() =>
      moveCursor(input.conn, input.sourceDatabase, input.calendar.id, target),
    );
    if (!moved) throw new StepFailure("cursor", "no calendar_sync_cursor row to advance");
    return { ...counts, state: "ok", cursorBefore: input.plan.cursorBefore, cursorAfter: target };
  } catch (error) {
    return failed(counts, input.plan, error, null);
  }
};
