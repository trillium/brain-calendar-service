// One push, applied: the create / adopt / update decision for a single period.
// Every failure leaves here as a StepFailure carrying its kind, so the caller can
// return it as a typed result instead of an exception.

import { randomBytes } from "node:crypto";
import type { Connection } from "mysql2/promise";
import type { CalendarProvider } from "../../adapters/provider.js";
import { PolicyViolation, type SyncPolicy } from "../loop/policy.js";
import {
  draftFor,
  findMarked,
  MARKER_KEY,
  markerValue,
  OWNER_KEY,
  type PeriodRow,
  periodIdOf,
} from "./apply-draft.js";
import {
  type BindingRow,
  doltHead,
  findBinding,
  insertBinding,
  loadPeriod,
  touchBinding,
} from "./apply-store.js";
import type { PlanPush, SyncPlan } from "./plan.js";
import type { Skipped } from "./pull-types.js";

export type FailureKind = "policy" | "provider" | "store" | "cursor" | "quarantined";

/** A failure already classified by the step that raised it. */
export class StepFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

const BINDING_ROW = /^row:calendar_binding:\d+$/;
const mintToken = (): string => randomBytes(24).toString("hex");
export const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Run a provider call; anything it throws becomes a typed failure, never an exception. */
export const viaProvider = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw new StepFailure(
      error instanceof PolicyViolation ? "policy" : "provider",
      messageOf(error),
    );
  }
};

export const viaStore = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw new StepFailure("store", messageOf(error));
  }
};

export interface Context {
  readonly conn: Connection;
  readonly provider: CalendarProvider;
  readonly plan: SyncPlan;
  readonly policy: SyncPolicy;
  readonly calendar: { readonly id: number; readonly remoteCalendarId: string };
  readonly sourceDatabase: string;
}

/** `unchanged` is a push that needs no write: a binding row is this step's own bookkeeping. */
type Outcome = "created" | "updated" | "adopted" | "unchanged";

const update = async (
  ctx: Context,
  beadId: string,
  period: PeriodRow,
  binding: BindingRow,
): Promise<void> => {
  const event = await viaProvider(() =>
    ctx.provider.updateEvent(
      ctx.policy,
      ctx.calendar.remoteCalendarId,
      binding.externalUid,
      draftFor(period),
    ),
  );
  await viaStore(async () =>
    touchBinding(ctx.conn, binding, beadId, event, await doltHead(ctx.conn)),
  );
};

const create = async (ctx: Context, beadId: string, period: PeriodRow): Promise<Outcome> => {
  const remote = ctx.calendar.remoteCalendarId;
  const draft = draftFor(period);
  const marker = markerValue(ctx.sourceDatabase, period.id);
  const found = await viaProvider(() => findMarked(ctx.provider, remote, marker));
  const token = found?.privateProperties[OWNER_KEY] ?? mintToken();
  const event =
    found === null
      ? await viaProvider(() =>
          ctx.provider.createEvent(ctx.policy, remote, {
            ...draft,
            privateProperties: { [MARKER_KEY]: marker, [OWNER_KEY]: token },
          }),
        )
      : await viaProvider(() => ctx.provider.updateEvent(ctx.policy, remote, found.id, draft));
  await viaStore(async () =>
    insertBinding(ctx.conn, {
      beadId,
      calendarId: ctx.calendar.id,
      event,
      token,
      syncedAt: await doltHead(ctx.conn),
    }),
  );
  return found === null ? "created" : "adopted";
};

export const applyOne = async (ctx: Context, push: PlanPush): Promise<Outcome | Skipped> => {
  if (BINDING_ROW.test(push.beadId)) return "unchanged";
  const periodId = periodIdOf(push.beadId);
  if (periodId === null) return { beadId: push.beadId, reason: "not a calendar_period row" };
  const period = await viaStore(() => loadPeriod(ctx.conn, periodId));
  if (period === null) {
    return { beadId: push.beadId, reason: "period no longer exists; deletes are not applied" };
  }
  const binding = await viaStore(() => findBinding(ctx.conn, push.beadId, ctx.calendar.id));
  if (binding === null) return create(ctx, push.beadId, period);
  if (binding.ownershipToken === null) {
    return { beadId: push.beadId, reason: "binding has no ownership token; not created here" };
  }
  await update(ctx, push.beadId, period, binding);
  return "updated";
};
