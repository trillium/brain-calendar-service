// Apply one pull: a remote change that won, written into the local store.
//
// A pull only ever touches Dolt, so there is no provider call and no provider
// policy to consult. What it must not do is invent a local record for an event
// the service never bound: an unbound remote event is reported and left alone.

import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import type { PlanPull } from "../orchestration/plan.js";
import { type ApplyContext, toDatetime } from "./context.js";
import type { ApplyOutcome } from "./types.js";

const RemoteTimes = z.object({
  startUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
  endUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
});

export const applyPull = async (ctx: ApplyContext, pull: PlanPull): Promise<ApplyOutcome> => {
  const key = pull.idempotencyKey ?? pull.externalUid;
  const times = RemoteTimes.safeParse(pull.payload);
  if (!times.success) {
    return { kind: "failed", key, error: "remote payload has no usable startUtc/endUtc" };
  }

  const [bindings] = await ctx.conn.query<RowDataPacket[]>(
    "SELECT bead_id FROM calendar_binding WHERE calendar_id = ? AND external_uid = ?",
    [ctx.calendarId, pull.externalUid],
  );
  if (bindings.length === 0) {
    return { kind: "skipped", key, reason: "remote event is not bound to any bead" };
  }
  const beadId = bindings[0].bead_id as string;
  const ts = ctx.now();

  await ctx.conn.query(
    `UPDATE calendar_period SET period_start_utc = ?, period_end_utc = ?, updated_at = ?
      WHERE linked_bead_id = ?`,
    [toDatetime(times.data.startUtc), toDatetime(times.data.endUtc), ts, beadId],
  );
  await ctx.conn.query(
    `UPDATE calendar_binding
        SET external_sequence = ?, last_synced_etag = ?, updated_at = ?
      WHERE bead_id = ? AND calendar_id = ?`,
    [pull.sequence ?? 0, pull.etag ?? null, ts, beadId, ctx.calendarId],
  );
  return { kind: "applied", key, op: "PULL", uid: pull.externalUid };
};
