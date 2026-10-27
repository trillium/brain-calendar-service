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
// a promise that it did. A registered calendar is READ in both modes (listEvents,
// through the gog provider: GOG_ACCOUNT, and GOG_BIN when gog is not on PATH), so
// the plan shows the remote edits it would pull. The live path then writes pulled
// edits into Dolt, applies pushes to the registered calendar only, and advances
// the cursor only after every one succeeded; a round that had to skip something
// exits non-zero with the cursor held. Events that are not ours are reported and
// never imported. Each live round appends one line to evidence/soak/report.json.

import { join } from "node:path";
import { createConnection } from "mysql2/promise";
import { resolveCalendar } from "../src/adapters/dolt/calendar-registry.ts";
import { config, ROOT } from "../src/adapters/dolt/config.mjs";
import { gogProviderFromEnv } from "../src/adapters/gog/provider.ts";
import { execRunner, recordingRunner } from "../src/adapters/gog/runner.ts";
import type { ApplyResult } from "../src/sync/orchestration/apply.ts";
import { SOURCE_DATABASE, type SyncPlan } from "../src/sync/orchestration/plan.ts";
import { runRound } from "../src/sync/orchestration/round.ts";
import { recordSoakRound, soakEntry } from "../src/sync/orchestration/soak.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string, fallback: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const PROVIDER = "google";
const SOAK_REPORT = join(ROOT, "evidence", "soak", "report.json");
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

const describeOutcome = (result: ApplyResult): string => {
  if (result.state === "ok") return ` cursor=${result.cursorAfter}`;
  if (result.state === "incomplete") {
    const skips = result.skipped.map((s) => `${s.beadId} (${s.reason})`).join(", ");
    return ` cursor_unchanged=${result.cursorBefore}: not applied: ${skips}`;
  }
  return ` kind=${result.kind} at=${result.at ?? "-"} cursor_unchanged=${result.cursorBefore}: ${result.message}`;
};

const describeApply = (result: ApplyResult): string =>
  `apply ${result.state} pulled=${result.pulled} created=${result.created} ` +
  `updated=${result.updated} adopted=${result.adopted} skipped=${result.skipped.length}` +
  describeOutcome(result);

const describeObservations = (plan: SyncPlan): string[] => [
  ...plan.foreign.map((f) => `foreign ${f.externalUid} (${f.summary ?? "no title"}): ${f.reason}`),
  ...plan.pullSkipped.map((s) => `cannot pull ${s.beadId}: ${s.reason}`),
  ...plan.quarantined.map((q) => `quarantined ${q.beadId ?? "-"}: ${q.reason}`),
];

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

  // The recorder wraps the runner, so the plan's provider-call log is what gog was
  // really asked. A dry-run also asks gog for --readonly, a second line of defence.
  const recorder = recordingRunner(execRunner(process.env.GOG_BIN ?? "gog"));
  const provider =
    registered === null
      ? null
      : gogProviderFromEnv(process.env, { runner: recorder.runner, readonly: dryRun });
  const { plan, applied } = await runRound({
    conn,
    provider,
    calendar: { id: calendarId, registered },
    dryRun,
    providerCalls: () => recorder.calls,
  });
  const soak = applied === null ? null : recordSoakRound(SOAK_REPORT, soakEntry(plan, applied));

  if (json) {
    console.log(JSON.stringify(applied === null ? plan : { ...plan, apply: applied }, null, 2));
  } else {
    console.log(
      `sync:once calendar=${calendarId} dryRun=${dryRun} push=${plan.push.length} ` +
        `pull=${plan.pull.length} conflicts_quarantined=${plan.conflictsQuarantined} ` +
        `foreign=${plan.foreign.length}`,
    );
    for (const line of describeObservations(plan)) console.log(`sync:once ${line}`);
    if (applied !== null) console.log(`sync:once ${describeApply(applied)}`);
    if (soak !== null) console.log(`sync:once soak round ${soak.round} recorded in ${SOAK_REPORT}`);
  }

  if (!dryRun && plan.conflictsQuarantined > 0) {
    console.error("sync:once: a clean calendar must quarantine nothing");
    process.exitCode = 1;
  }
  if (applied !== null && applied.state !== "ok") {
    console.error(`sync:once: ${describeApply(applied)}`);
    process.exitCode = 1;
  }
} finally {
  await conn.end();
}
