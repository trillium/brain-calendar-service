// One round of one calendar, pull then push, as a single call.
//
// sync:once is a thin wrapper over this so the tests drive exactly the code the
// CLI runs. The order is the point:
//
//   1. observe the provider (read only; a dry-run does this too)
//   2. plan from Dolt's history AND what was observed
//   3. apply: pulls into Dolt, pushes to the provider, cursor last
//
// If the provider cannot be read, step 3 is told so and applies nothing: pushing
// to a calendar whose current state is unknown is how duplicates are made.

import type { Connection } from "mysql2/promise";
import type { RegisteredCalendar } from "../../adapters/dolt/calendar-registry.js";
import type { CalendarProvider } from "../../adapters/provider.js";
import { type ApplyResult, applyPlan, pushPolicy } from "./apply.js";
import { StepFailure } from "./apply-steps.js";
import { buildSyncPlan, SOURCE_DATABASE, type SyncPlan } from "./plan.js";
import { observePull } from "./pull-observe.js";
import { NO_OBSERVATION, type PullObservation } from "./pull-types.js";

interface RoundInput {
  readonly conn: Connection;
  /** Null when the calendar is not registered: there is nothing to read or write. */
  readonly provider: CalendarProvider | null;
  readonly calendar: { readonly id: number; readonly registered: RegisteredCalendar | null };
  readonly dryRun: boolean;
  readonly providerCalls: () => readonly { method: string }[];
}

interface RoundOutcome {
  readonly plan: SyncPlan;
  /** Null for a dry-run, which applies nothing. */
  readonly applied: ApplyResult | null;
}

/** Every planned write carries its idempotency key, so a replay is safe. */
const withKeys = (plan: SyncPlan): SyncPlan => ({
  ...plan,
  push: plan.push.map((p, i) => ({ ...p, idempotencyKey: `${p.beadId}:${i}` })),
  pull: plan.pull.map((p, i) => ({ ...p, idempotencyKey: `${p.externalUid}:${i}` })),
});

const observe = async (
  input: RoundInput,
): Promise<{ pull: PullObservation; failure?: StepFailure }> => {
  const { provider, calendar, conn } = input;
  if (provider === null || calendar.registered === null) return { pull: NO_OBSERVATION };
  try {
    const pull = await observePull({
      conn,
      provider,
      calendar: { id: calendar.id, remoteCalendarId: calendar.registered.remoteCalendarId },
    });
    return { pull };
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    return { pull: NO_OBSERVATION, failure: error };
  }
};

export const runRound = async (input: RoundInput): Promise<RoundOutcome> => {
  const { conn, calendar, provider } = input;
  const { pull, failure } = await observe(input);
  // A dry-run that could not look at the provider has not shown what it would do.
  if (failure !== undefined && input.dryRun) throw failure;
  const plan = withKeys(
    await buildSyncPlan({
      conn,
      calendarId: String(calendar.id),
      provider: calendar.registered?.provider ?? "google",
      pull,
      providerCalls: input.providerCalls,
      dryRun: input.dryRun,
    }),
  );
  if (input.dryRun || provider === null || calendar.registered === null) {
    return { plan, applied: null };
  }
  const applied = await applyPlan({
    conn,
    provider,
    plan,
    policy: pushPolicy(calendar.registered.provider, calendar.registered.remoteCalendarId),
    calendar: { id: calendar.id, remoteCalendarId: calendar.registered.remoteCalendarId },
    sourceDatabase: SOURCE_DATABASE,
    readFailure: failure,
  });
  return { plan, applied };
};
