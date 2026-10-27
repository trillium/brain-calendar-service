// One pull, applied: a remote edit written into calendar_period.
//
// Nothing goes to the provider. The edit lands as ONE Dolt commit that moves the
// period and rewrites the binding's last_synced_* columns in the same transaction,
// so the etag recorded is the etag of the edit just taken in. That is what makes
// the next round see the provider's copy as unchanged (our own echo) instead of
// as a fresh edit to pull again.

import type { Context } from "./apply-steps.js";
import { viaStore } from "./apply-steps.js";
import { doltHead, sqlStamp } from "./apply-store.js";
import { type PulledEdit, refreshBinding, writePulledEdit } from "./pull-store.js";
import type { BindingRefresh, PlanPull, Skipped } from "./pull-types.js";

export const applyPull = async (ctx: Context, pull: PlanPull): Promise<"pulled" | Skipped> => {
  const reason = await viaStore(async () => {
    const edit: PulledEdit = {
      periodId: pull.periodId,
      beadId: pull.beadId,
      calendarId: ctx.calendar.id,
      previous: pull.previous,
      startUtc: pull.startUtc,
      endUtc: pull.endUtc,
      etag: pull.etag,
      dtstamp: sqlStamp(pull.updated ?? undefined),
      syncedAt: await doltHead(ctx.conn),
    };
    return writePulledEdit(ctx.conn, edit);
  });
  return reason === null ? "pulled" : { beadId: pull.beadId, reason };
};

export const applyRefresh = (ctx: Context, refresh: BindingRefresh): Promise<void> =>
  viaStore(async () =>
    refreshBinding(ctx.conn, {
      beadId: refresh.beadId,
      calendarId: ctx.calendar.id,
      etag: refresh.etag,
      dtstamp: sqlStamp(refresh.updated ?? undefined),
      syncedAt: await doltHead(ctx.conn),
    }),
  );
