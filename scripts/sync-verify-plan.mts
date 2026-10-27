#!/usr/bin/env tsx
// sync:verify-plan - the S7 gate's second half.
//
//   pnpm run sync:verify-plan <plan.json>
//
// Two jobs, and the second is the one the plan actually cares about:
//
//   1. the plan is INTERNALLY CONSISTENT: every bead resolves, nothing appears as
//      both a push and a pull, no write is issued for an unchanged pair, and
//      every external write carries an idempotency key.
//   2. the plan was NOT EXECUTED: observed row deltas are zero, no observed table's
//      working-set hash moved, no mutating provider method was called, and the
//      Dolt head did not move.
//
// A dry-run that only proves job 1 proves that a flag was honoured. Job 2 is
// what proves nothing happened.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: sync:verify-plan <plan.json>");
  process.exit(2);
}

interface Plan {
  calendarId: string;
  dryRun: boolean;
  push: { beadId: string; externalUid: string; reason: string; idempotencyKey?: string }[];
  pull: { beadId: string; externalUid: string; reason: string; idempotencyKey?: string }[];
  quarantined: unknown[];
  observations: {
    rowDeltas: Record<string, number>;
    tableHashesBefore: Record<string, string>;
    tableHashesAfter: Record<string, string>;
    providerCalls: { method: string }[];
    doltHeadBefore: string | null;
    doltHeadAfter: string | null;
  };
}

// The plan's exit command pipes the dry-run straight through `tee`, so the file
// carries whatever the package runner printed before the JSON. Taking the JSON
// from the first brace rather than assuming the file is pure JSON keeps the
// documented command working as documented.
const raw = readFileSync(path, "utf8");
const start = raw.indexOf("{");
if (start < 0) {
  console.error(`sync:verify-plan: no JSON found in ${path}`);
  process.exit(2);
}
const plan = JSON.parse(raw.slice(start)) as Plan;
const failures: string[] = [];

// 1. internal consistency
for (const [i, p] of plan.push.entries()) {
  if (!p.beadId) failures.push(`push[${i}] has no bead id; every write must name what it writes`);
  if (!p.idempotencyKey) {
    failures.push(`push[${i}] (${p.beadId}) carries no idempotency key`);
  }
}
for (const [i, p] of plan.pull.entries()) {
  if (!p.idempotencyKey) {
    failures.push(`pull[${i}] (${p.externalUid}) carries no idempotency key`);
  }
}
const pushed = new Set(plan.push.map((p) => p.beadId));
for (const p of plan.pull) {
  if (p.beadId && pushed.has(p.beadId)) {
    failures.push(`${p.beadId} appears as both a push and a pull`);
  }
}
for (const p of [...plan.push, ...plan.pull]) {
  if (p.reason === "identical") {
    failures.push(`${p.beadId || p.externalUid} is scheduled for a write despite being unchanged`);
  }
}

// 2. it was not executed
for (const [table, delta] of Object.entries(plan.observations.rowDeltas)) {
  if (delta !== 0) failures.push(`dry-run changed ${delta} row(s) in ${table}`);
}
for (const [table, hash] of Object.entries(plan.observations.tableHashesBefore)) {
  if (plan.observations.tableHashesAfter[table] !== hash) {
    failures.push(`dry-run modified ${table} in the Dolt working set`);
  }
}
// gog verbs (create, update, delete, move) and the HTTP verbs a raw transport uses.
const MUTATING_METHODS = new Set(["create", "update", "delete", "move", "put", "post", "patch"]);
const isMutating = (method: string) => MUTATING_METHODS.has(method.toLowerCase());
for (const call of plan.observations.providerCalls) {
  if (isMutating(call.method)) {
    failures.push(`dry-run issued a mutating provider call: ${call.method}`);
  }
}
if (plan.observations.doltHeadBefore !== plan.observations.doltHeadAfter) {
  failures.push("dry-run moved the Dolt head");
}
if (plan.dryRun !== true) failures.push("this is not a dry-run plan; use the live command instead");

console.log("sync:verify-plan");
console.log(
  `  push: ${plan.push.length}  pull: ${plan.pull.length}  quarantined: ${plan.quarantined.length}`,
);
console.log(`  observed row deltas: ${JSON.stringify(plan.observations.rowDeltas)}`);
console.log(
  `  observed provider calls: ${plan.observations.providerCalls.map((c) => c.method).join(",") || "none"}`,
);
console.log(
  `  dolt head unchanged: ${plan.observations.doltHeadBefore === plan.observations.doltHeadAfter}`,
);

if (failures.length > 0) {
  console.error("\nsync:verify-plan FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nsync:verify-plan PASSED: the plan is well-formed AND was not executed");
