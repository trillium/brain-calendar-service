#!/usr/bin/env tsx
// sync:soak-report --since <N>d
//
// S10's entry condition. It exits 0 only when there is REAL soak evidence: a
// service that has run against a real calendar, with per-round conflict counts
// and a quarantined count.
//
// It is deliberately honest about having none. Reporting success from an absent
// soak is the exact failure this command exists to prevent, so with no soak data
// it exits non-zero and says so.

import { existsSync, readFileSync } from "node:fs";

const i = process.argv.indexOf("--since");
const since = i >= 0 ? (process.argv[i + 1] ?? "0d") : "0d";
const soakFile = "evidence/soak/report.json";

console.log(`sync:soak-report --since ${since}`);
if (!existsSync(soakFile)) {
  console.log("  rounds: 0");
  console.log("  conflicts per round: none");
  console.log("  quarantined: 0");
  console.error("");
  console.error("sync:soak-report FAILED: no soak report exists.");
  console.error("  A soak means the service ran against a REAL external calendar for a");
  console.error("  defined period. That needs live provider credentials, which this");
  console.error("  environment does not have, and pointing the service at a real");
  console.error("  calendar is the captain's call rather than a worker's.");
  console.error(`  Write ${soakFile} from a real soak run, then re-run this.`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(soakFile, "utf8"));
console.log(`  rounds: ${report.rounds}`);
console.log(`  conflicts per round: ${(report.conflictsPerRound ?? []).join(", ")}`);
console.log(`  quarantined: ${report.quarantined}`);
if (!report.rounds || report.rounds <= 0) {
  console.error("\nsync:soak-report FAILED: the soak recorded zero rounds.");
  process.exit(1);
}
console.log("\nsync:soak-report PASSED");
