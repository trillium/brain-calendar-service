#!/usr/bin/env tsx
// sync:once - one cycle for one calendar.
//
//   pnpm run sync:once --calendar <id> --dry-run --json | tee /tmp/plan.json
//   pnpm run sync:verify-plan /tmp/plan.json
//   pnpm run sync:once --calendar <id>          # the live path
//
// --calendar takes a store id (`3` or `cal-3`) or a remote calendar id registered
// with `pnpm run calendar:register`. A dry-run writes nothing to Dolt and nothing
// to a provider, and the plan it emits carries the OBSERVATIONS that prove it, not
// a promise that it did. The live path builds the gog provider (GOG_ACCOUNT, and
// GOG_BIN when gog is not on PATH), applies the plan's pushes to the registered
// calendar only, and advances the cursor only after every push succeeded.

import { createConnection } from "mysql2/promise";
import { resolveCalendar } from "../src/adapters/dolt/calendar-registry.ts";
import { config } from "../src/adapters/dolt/config.mjs";
import { gogProviderFromEnv } from "../src/adapters/gog/provider.ts";
import { execRunner, recordingRunner } from "../src/adapters/gog/runner.ts";
import { type ApplyResult, applyPlan, pushPolicy } from "../src/sync/orchestration/apply.ts";
import { buildSyncPlan, SOURCE_DATABASE } from "../src/sync/orchestration/plan.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string, fallback: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const PROVIDER = "google";
const dryRun = flag("dry-run");
const json = flag("json");
const conn = await createConnection(config);

/**
 * A calendar with no cursor has no baseline, and the honest first action is a
 * full resync - not an empty diff. Bootstrapping the cursor to the current
 * commit IS that first action, so it happens on the LIVE path only. A dry-run
 * must not write to Dolt, including to its own bookkeeping.
 */
const bootstrapCursor = async (calendarId: number): Promise<void> => {
  const [existing] = await conn.query(
    "SELECT id FROM calendar_sync_cursor WHERE source_database = ? AND calendar_id = ?",
    [SOURCE_DATABASE, calendarId],
  );
  if ((existing as unknown[]).length > 0) return;
  const [head] = await conn.query("SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1");
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  await conn.query(
    `INSERT INTO calendar_sync_cursor
       (source_database, calendar_id, last_synced_commit_hash, last_round_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [SOURCE_DATABASE, calendarId, (head as { commit_hash: string }[])[0]?.commit_hash, ts, ts, ts],
  );
};

const describeApply = (result: ApplyResult): string =>
  `apply ${result.state} created=${result.created} updated=${result.updated} ` +
  `adopted=${result.adopted} skipped=${result.skipped.length}` +
  (result.state === "failed"
    ? ` kind=${result.kind} at=${result.at ?? "-"} cursor_unchanged=${result.cursorBefore}: ${result.message}`
    : ` cursor=${result.cursorAfter}`);

try {
  const { id: calendarId, registered } = await resolveCalendar(
    conn,
    value("calendar", "cal-1"),
    PROVIDER,
  );
  if (!dryRun && registered === null) {
    throw new Error(
      `calendar ${calendarId} is not registered, so there is no remote calendar to write to; ` +
        "run `pnpm run calendar:register` first",
    );
  }
  if (!dryRun) await bootstrapCursor(calendarId);

  // A pure dry-run asks gog for nothing, so the log is empty; a provider built
  // here must take its runner from the recorder so the log stays real.
  const recorder = recordingRunner(execRunner(process.env.GOG_BIN ?? "gog"));
  const plan = await buildSyncPlan({
    conn,
    calendarId: String(calendarId),
    provider: PROVIDER,
    remoteChanges: [],
    providerCalls: () => recorder.calls,
    dryRun,
  });

  // Every planned write carries its idempotency key, so a replay is safe.
  plan.push = plan.push.map((p, i) => ({ ...p, idempotencyKey: `${p.beadId}:${i}` }));
  plan.pull = plan.pull.map((p, i) => ({ ...p, idempotencyKey: `${p.externalUid}:${i}` }));

  let applied: ApplyResult | null = null;
  if (!dryRun && plan.conflictsQuarantined === 0 && registered !== null) {
    applied = await applyPlan({
      conn,
      provider: gogProviderFromEnv(process.env, { runner: recorder.runner }),
      plan,
      policy: pushPolicy(registered.provider, registered.remoteCalendarId),
      calendar: { id: calendarId, remoteCalendarId: registered.remoteCalendarId },
      sourceDatabase: SOURCE_DATABASE,
    });
  }

  if (json) {
    console.log(JSON.stringify(applied === null ? plan : { ...plan, apply: applied }, null, 2));
  } else {
    console.log(
      `sync:once calendar=${calendarId} dryRun=${dryRun} push=${plan.push.length} ` +
        `pull=${plan.pull.length} conflicts_quarantined=${plan.conflictsQuarantined}`,
    );
    if (applied !== null) console.log(`sync:once ${describeApply(applied)}`);
  }

  if (!dryRun && plan.conflictsQuarantined > 0) {
    console.error("sync:once: a clean calendar must quarantine nothing");
    process.exitCode = 1;
  }
  if (applied?.state === "failed") {
    console.error(`sync:once: ${describeApply(applied)}`);
    process.exitCode = 1;
  }
} finally {
  await conn.end();
}
