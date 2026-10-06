#!/usr/bin/env tsx
// rollout:dry-run --scenario backfill
//
// Runs the backfill twice against a disposable marker set. The FIRST run creates;
// the SECOND must create nothing. That single property is what makes a partial
// failure safe to recover from, and it is the most common way a calendar
// integration becomes a duplicate-event incident.

import { backfill, RIGHTS } from "../src/sync/rollout/phases.ts";

const args = process.argv.slice(2);
const i = args.indexOf("--scenario");
const scenario = i >= 0 ? (args[i + 1] ?? "backfill") : "backfill";

const candidates = Array.from({ length: 25 }, (_, n) => ({
  beadId: `brain-${n}`,
  summary: `Event ${n}`,
  startUtc: new Date(Date.UTC(2026, 4, 1, 15 + (n % 8), n % 60)).toISOString(),
  durationSeconds: 900,
  markerKey: "X-Beads-Id",
  markerValue: `brain-${n}`,
}));

const markers = new Map<string, string>();
const first = backfill(candidates, markers, RIGHTS.backfill);
const second = backfill(candidates, markers, RIGHTS.backfill);

console.log(`rollout:dry-run --scenario ${scenario}`);
console.log(`  first run  created=${first.created} skipped=${first.skipped}`);
console.log(`  second run created=${second.created} skipped=${second.skipped}`);

if (second.created !== 0) {
  console.error(
    `\nrollout:dry-run FAILED: the second run created ${second.created} event(s); backfill is not idempotent`,
  );
  process.exit(1);
}
console.log("\nrollout:dry-run PASSED: the second run created nothing");
