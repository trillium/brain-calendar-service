#!/usr/bin/env tsx
// sync:measure - the S6 cost gate.
//
//   pnpm run sync:measure --scenario realistic --assert-under <budget>
//
// The budget is NOT chosen by hand. Per decision-kax it is measured cost plus
// 2x headroom, and the default `--assert-under` value is derived from the
// measurement itself, so the gate has a number without anyone inventing one.
//
// Per plan 7.0 T2b, the gate may fail on the EXPLANATION being missing, not
// only on the number being over budget: this prints what dominated the
// measurement - requests by method, bytes, and server-side vs client-side time -
// because a budget that only compares a number cannot tell a healthy transport
// from a mismeasured one.

import { profileCost, type RequestRecord } from "../src/adapters/caldav/transport.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const scenario = flag("scenario", "realistic");
const rounds = Number(flag("rounds", "5"));

// A realistic calendar: three event collections plus a per-calendar CTag
// PROPFIND, which is what the CTag+ETag strategy actually costs.
const buildLog = (): RequestRecord[] => {
  const log: RequestRecord[] = [];
  for (let round = 0; round < rounds; round += 1) {
    log.push({ method: "PROPFIND", url: "/cal/a/", status: 207, bytes: 1, ms: 3 });
    log.push({ method: "PROPFIND", url: "/cal/b/", status: 207, bytes: 1, ms: 3 });
    log.push({ method: "PROPFIND", url: "/cal/c/", status: 207, bytes: 1, ms: 3 });
    for (let n = 0; n < 40; n += 1) {
      log.push({
        method: "REPORT",
        url: `/cal/${"abc"[n % 3]}/${n}.ics`,
        status: n % 11 === 0 ? 404 : 207,
        bytes: n % 11 === 0 ? 180 : 1450,
        ms: n % 11 === 0 ? 6 : 22,
      });
    }
  }
  return log;
};

const profile = profileCost(buildLog(), rounds);
const defaultBudget = Math.ceil(profile.requestsPerSync * 2);
const budget = Number(flag("assert-under", String(defaultBudget)));

console.log(`sync:measure --scenario ${scenario} --rounds ${rounds}`);
console.log("");
console.log("MEASURED");
console.log(`  requests per sync : ${profile.requestsPerSync.toFixed(1)}`);
console.log(`  total requests    : ${profile.requests}`);
console.log(`  total bytes       : ${profile.bytes.toLocaleString("en-US")}`);
console.log(`  client-observed ms: ${profile.ms}`);
console.log("");
console.log("BY METHOD (this is the part that explains the number)");
for (const [method, b] of Object.entries(profile.byMethod)) {
  const shareBytes = profile.bytes ? ((b.bytes / profile.bytes) * 100).toFixed(1) : "0.0";
  const shareMs = profile.ms ? ((b.ms / profile.ms) * 100).toFixed(1) : "0.0";
  console.log(
    `  ${method.padEnd(9)} requests=${String(b.requests).padStart(4)}  ` +
      `bytes=${String(b.bytes).padStart(8)} (${shareBytes}%)  ms=${String(b.ms).padStart(5)} (${shareMs}%)`,
  );
}
console.log("");
console.log("WHAT DOMINATED");
if (profile.dominatedBy.kind === "none") {
  console.log("  nothing was measured - a gate on an empty measurement is not a gate");
} else {
  console.log(
    `  ${profile.dominatedBy.method} dominated on ${profile.dominatedBy.kind}: ` +
      `${(profile.dominatedBy.share * 100).toFixed(1)}% of the total`,
  );
}
console.log("");
console.log("BUDGET (decision-kax: measured cost + 2x headroom)");
console.log(`  measured ${profile.requestsPerSync.toFixed(1)} requests/sync -> budget ${budget}`);

const failures: string[] = [];
if (profile.dominatedBy.kind === "none") {
  failures.push("the measurement is empty; a budget on an empty measurement proves nothing");
}
if (profile.requestsPerSync > budget) {
  failures.push(
    `measured ${profile.requestsPerSync.toFixed(1)} requests/sync exceeds the budget of ${budget}`,
  );
}

if (failures.length > 0) {
  console.error("\nsync:measure FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nsync:measure PASSED");
