// Apply one push: a local temporal change, written outward to the provider.
//
// The shape of a push is decided by what the store says, not by what the plan
// claims: a row with no binding is an INSERT, a row with one is an UPDATE, and a
// row that no longer exists is a local deletion, which is the one case that is
// never carried out here.

import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { assertPermitted } from "../loop/policy.js";
import type { PlanPush } from "../orchestration/plan.js";
import type { ApplyContext } from "./context.js";
import type { EventPayload } from "./provider.js";
import type { ApplyOutcome } from "./types.js";

const REF = /^row:([a-z_]+):(\d+)$/;

const Attributes = z.object({ summary: z.string().min(1).optional() }).passthrough();

interface PeriodRow extends RowDataPacket {
  linked_bead_id: string | null;
  attributes_json: unknown;
  startUtc: string;
  endUtc: string;
}

interface BindingRow extends RowDataPacket {
  external_uid: string;
  last_synced_etag: string | null;
  ownership_token: string | null;
}

const asObject = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

const fetchPeriod = async (ctx: ApplyContext, id: string): Promise<PeriodRow | null> => {
  const [rows] = await ctx.conn.query<PeriodRow[]>(
    `SELECT linked_bead_id, attributes_json,
            DATE_FORMAT(period_start_utc, '%Y-%m-%dT%H:%i:%sZ') AS startUtc,
            DATE_FORMAT(period_end_utc, '%Y-%m-%dT%H:%i:%sZ') AS endUtc
       FROM calendar_period WHERE id = ?`,
    [id],
  );
  return rows[0] ?? null;
};

const fetchBinding = async (ctx: ApplyContext, beadId: string): Promise<BindingRow | null> => {
  const [rows] = await ctx.conn.query<BindingRow[]>(
    `SELECT external_uid, last_synced_etag, ownership_token
       FROM calendar_binding WHERE bead_id = ? AND calendar_id = ?`,
    [beadId, ctx.calendarId],
  );
  return rows[0] ?? null;
};

/**
 * A local deletion would mean deleting an external event. That is destructive
 * and human-gated, so it is recorded in the quarantine sink instead and the
 * provider is never called - whatever the policy allowlist says.
 */
const quarantineDelete = async (ctx: ApplyContext, ref: string): Promise<ApplyOutcome> => {
  const key = ref;
  const reason = "local_delete_needs_human";
  const [existing] = await ctx.conn.query<RowDataPacket[]>(
    `SELECT id FROM calendar_conflict
      WHERE calendar_id = ? AND bead_id = ? AND reason = ? AND resolved = 0`,
    [ctx.calendarId, key, reason],
  );
  if (existing.length === 0) {
    const ts = ctx.now();
    await ctx.conn.query(
      `INSERT INTO calendar_conflict (calendar_id, bead_id, reason, resolved, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      [ctx.calendarId, key, reason, ts, ts],
    );
  }
  return {
    kind: "refused",
    key,
    reason: "a local deletion would delete an external event; that needs a human decision",
  };
};

const insertBinding = async (ctx: ApplyContext, beadId: string, uid: string, etag: string) => {
  const ts = ctx.now();
  await ctx.conn.query(
    `INSERT INTO calendar_binding
       (bead_id, calendar_id, external_uid, external_sequence, last_synced_etag,
        ownership_token, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [beadId, ctx.calendarId, uid, etag, ctx.mintToken(), ts, ts],
  );
};

const bumpBinding = async (ctx: ApplyContext, beadId: string, etag: string) => {
  await ctx.conn.query(
    `UPDATE calendar_binding
        SET external_sequence = external_sequence + 1, last_synced_etag = ?, updated_at = ?
      WHERE bead_id = ? AND calendar_id = ?`,
    [etag, ctx.now(), beadId, ctx.calendarId],
  );
};

const payloadOf = (row: PeriodRow, beadId: string): EventPayload => {
  const attributes = Attributes.parse(asObject(row.attributes_json));
  return {
    summary: attributes.summary ?? beadId,
    startUtc: row.startUtc,
    endUtc: row.endUtc,
  };
};

export const applyPush = async (ctx: ApplyContext, push: PlanPush): Promise<ApplyOutcome> => {
  const key = push.idempotencyKey ?? push.beadId;
  const ref = REF.exec(push.beadId);
  if (ref === null) return { kind: "failed", key, error: `unrecognised push ref ${push.beadId}` };
  // Bookkeeping tables are the service's own writes; pushing them outward would
  // be the loop the loop breaker exists to prevent.
  if (ref[1] !== "calendar_period") {
    return { kind: "skipped", key, reason: `${ref[1]} is service bookkeeping, not an event` };
  }

  const row = await fetchPeriod(ctx, ref[2]);
  if (row === null) return quarantineDelete(ctx, push.beadId);
  const beadId = row.linked_bead_id;
  if (beadId === null) return { kind: "skipped", key, reason: "period has no linked bead" };

  const binding = await fetchBinding(ctx, beadId);
  const payload = payloadOf(row, beadId);
  const uid = binding?.external_uid ?? `${beadId}@brain-calendar-service`;
  if (binding === null) {
    assertPermitted(ctx.policy, ctx.calendarId, "INSERT");
    const made = await ctx.provider.insert(ctx.calendarId, uid, payload, { idempotencyKey: key });
    await insertBinding(ctx, beadId, uid, made.etag);
    return { kind: "applied", key, op: "INSERT", uid };
  }
  assertPermitted(ctx.policy, ctx.calendarId, "UPDATE");
  const made = await ctx.provider.update(ctx.calendarId, uid, payload, binding.last_synced_etag, {
    idempotencyKey: key,
  });
  await bumpBinding(ctx, beadId, made.etag);
  return { kind: "applied", key, op: "UPDATE", uid };
};
