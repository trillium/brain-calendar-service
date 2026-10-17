#!/usr/bin/env tsx
// sync:once - one cycle for one calendar.
//
//   pnpm run sync:once --calendar <id> --dry-run --json | tee /tmp/plan.json
//   pnpm run sync:verify-plan /tmp/plan.json
//   pnpm run sync:once --calendar <id>          # the live path
//
// A dry-run writes nothing to Dolt and nothing to a provider, and the plan it
// emits carries the OBSERVATIONS that prove it, not a promise that it did.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "mysql2/promise";
import { applyPlan } from "../src/sync/apply/apply.ts";
import { configuredProvider } from "../src/sync/apply/provider.ts";
import type { ApplyResult } from "../src/sync/apply/types.ts";
import { buildSyncPlan, cyclePolicy } from "../src/sync/orchestration/plan.ts";

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
const gitHead = () => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

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

  const temporalTables = ["calendar_period", "calendar_binding"];
  const countRows = async (): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const table of temporalTables) {
      const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      counts[table] = Number(rows[0].n);
    }
    return counts;
  };
  const rowsBefore = await countRows();

  const plan = await buildSyncPlan({
    conn,
    calendarId: String(calendarIdNumber),
    provider: "google",
    remoteChanges: [],
    providerCalls: [{ method: "PROPFIND" }, { method: "REPORT" }],
    gitHead,
    dryRun,
  });

  // Every planned write carries its idempotency key, so a replay is safe.
  plan.push = plan.push.map((p, i) => ({ ...p, idempotencyKey: `${p.beadId}:${i}` }));
  plan.pull = plan.pull.map((p, i) => ({ ...p, idempotencyKey: `${p.externalUid}:${i}` }));

  // The apply step. Not reached on a dry-run, which is what keeps a dry-run inert.
  let applied: ApplyResult | null = null;
  const work = plan.push.length + plan.pull.length;
  if (!dryRun && work > 0) {
    const provider = configuredProvider();
    if (provider === null) {
      // Refuse BEFORE any write rather than apply against a stand-in and record
      // bindings for events that do not exist anywhere.
      console.error(
        `sync:once: ${work} change(s) to apply, but no CalendarProvider is configured. ` +
          "Nothing was written. See docs/running-by-hand.md (L3).",
      );
      process.exit(1);
    }
    applied = await applyPlan(
      {
        conn,
        provider,
        policy: cyclePolicy("google", String(calendarIdNumber)),
        calendarId: String(calendarIdNumber),
        now: () => new Date().toISOString().slice(0, 19).replace("T", " "),
        mintToken: randomUUID,
      },
      plan,
    );
    plan.cursorAfter = applied.cursorAdvancedTo ?? plan.cursorBefore;
  }

  // OBSERVED row deltas, read back from the store rather than asserted.
  const rowsAfter = await countRows();
  for (const table of temporalTables) {
    plan.observations.rowDeltas[table] = rowsAfter[table] - rowsBefore[table];
  }
  plan.observations.gitHeadAfter = gitHead();

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(
      `sync:once calendar=${calendarIdNumber} dryRun=${dryRun} push=${plan.push.length} ` +
        `pull=${plan.pull.length} conflicts_quarantined=${plan.conflictsQuarantined}`,
    );
  }

  const unfinished = applied?.outcomes.filter((o) => o.kind === "failed" || o.kind === "refused");
  if (unfinished && unfinished.length > 0) {
    console.error(`sync:once: ${unfinished.length} entr(ies) not applied; cursor held back`);
    console.error(JSON.stringify(unfinished, null, 2));
    process.exit(1);
  }

  if (!dryRun && plan.conflictsQuarantined > 0) {
    console.error("sync:once: a clean calendar must quarantine nothing");
    process.exit(1);
  }
} finally {
  await conn.end();
}
