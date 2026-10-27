#!/usr/bin/env tsx
// sync:once - one cycle for one calendar.
//
//   pnpm run sync:once --calendar <id> --dry-run --json | tee /tmp/plan.json
//   pnpm run sync:verify-plan /tmp/plan.json
//   pnpm run sync:once --calendar <id>          # the live path
//
// A dry-run writes nothing to Dolt and nothing to a provider, and the plan it
// emits carries the OBSERVATIONS that prove it, not a promise that it did.

import { createConnection } from "mysql2/promise";
import { execRunner, recordingRunner } from "../src/adapters/gog/runner.ts";
import { buildSyncPlan } from "../src/sync/orchestration/plan.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string, fallback: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

// calendar_id is a BIGINT in the schema, so the calendar identity is numeric on
// the wire. "cal-1" is a readable alias and is mapped here, once, at the edge.
const calendarAlias = value("calendar", "cal-1");
const calendarId = calendarAlias.startsWith("cal-") ? calendarAlias.slice(4) : calendarAlias;
// The store's calendar_id is a BIGINT. Resolve the alias once, here, and refuse
// a non-numeric id loudly rather than letting the driver discover it.
const calendarIdNumber = Number(calendarId);
if (!Number.isInteger(calendarIdNumber)) {
  throw new Error(`--calendar must resolve to an integer id, got "${calendarAlias}"`);
}
const dryRun = flag("dry-run");
const json = flag("json");
const conn = await createConnection({
  host: process.env.CALENDAR_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.CALENDAR_DB_PORT ?? 3399),
  database: process.env.CALENDAR_DB_NAME ?? "brain_calendar_service",
  user: process.env.CALENDAR_DB_USER ?? "root",
  password: process.env.CALENDAR_DB_PASSWORD ?? "",
});

try {
  // A calendar with no cursor has no baseline, and the honest first action is a
  // full resync - not an empty diff. Bootstrapping the cursor to the current
  // commit IS that first action, so it happens on the LIVE path only. A dry-run
  // must not write to Dolt, including to its own bookkeeping.
  if (!dryRun) {
    const [existing] = await conn.query(
      "SELECT id FROM calendar_sync_cursor WHERE source_database = ? AND calendar_id = ?",
      ["brain_calendar_service", calendarIdNumber],
    );
    if (existing.length === 0) {
      const [head] = await conn.query(
        "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1",
      );
      const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
      await conn.query(
        `INSERT INTO calendar_sync_cursor
           (source_database, calendar_id, last_synced_commit_hash, last_round_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["brain_calendar_service", calendarIdNumber, head[0].commit_hash, ts, ts, ts],
      );
    }
  }

  // A pure dry-run asks gog for nothing, so the log is empty; a provider built
  // here must take its runner from the recorder so the log stays real.
  const recorder = recordingRunner(execRunner(process.env.GOG_BIN ?? "gog"));
  const plan = await buildSyncPlan({
    conn,
    calendarId: String(calendarIdNumber),
    provider: "google",
    remoteChanges: [],
    providerCalls: () => recorder.calls,
  });

  // Every planned write carries its idempotency key, so a replay is safe.
  plan.push = plan.push.map((p, i) => ({ ...p, idempotencyKey: `${p.beadId}:${i}` }));
  plan.pull = plan.pull.map((p, i) => ({ ...p, idempotencyKey: `${p.externalUid}:${i}` }));

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(
      `sync:once calendar=${calendarIdNumber} dryRun=${dryRun} push=${plan.push.length} ` +
        `pull=${plan.pull.length} conflicts_quarantined=${plan.conflictsQuarantined}`,
    );
  }

  if (!dryRun && plan.conflictsQuarantined > 0) {
    console.error("sync:once: a clean calendar must quarantine nothing");
    process.exit(1);
  }
} finally {
  await conn.end();
}
