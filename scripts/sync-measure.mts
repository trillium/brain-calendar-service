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
// measurement - gog calls by subcommand, bytes, and time - because a budget that only compares a number cannot tell a healthy transport
// from a mismeasured one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CallRecord, profileCost } from "../src/adapters/gog/cost.ts";
import { createGogProvider } from "../src/adapters/gog/provider.ts";
import { execRunner, subcommandOf } from "../src/adapters/gog/runner.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const scenario = flag("scenario", "realistic");
const rounds = Number(flag("rounds", "5"));
// Measured against the fake gog fixture by default, so the gate needs no
// account. Point GOG_BIN at a real gog (and set GOG_ACCOUNT) to measure live.
const bin = process.env.GOG_BIN ?? resolve(import.meta.dirname, "../fixtures/gog/fake-gog.mjs");
const account = process.env.GOG_ACCOUNT ?? "measure@example.invalid";

// A realistic sync reads three calendars and fetches the changed events by id.
const CALENDARS = ["cal-a", "cal-b", "cal-c"];
const FETCHES_PER_ROUND = 8;

const dir = mkdtempSync(join(tmpdir(), "sync-measure-"));
const log: CallRecord[] = [];
const inner = execRunner(bin);
const provider = createGogProvider({
  account,
  runner: async (argv) => {
    const started = Date.now();
    const result = await inner(argv);
    log.push({
      command: subcommandOf(argv),
      ms: Date.now() - started,
      bytes: result.stdout.length,
    });
    return result;
  },
});

process.env.FAKE_GOG_LOG = join(dir, "calls.log");
for (let round = 0; round < rounds; round += 1) {
  for (const cal of CALENDARS) await provider.listEvents(cal);
  for (let n = 0; n < FETCHES_PER_ROUND; n += 1)
    await provider.getEvent(CALENDARS[n % 3] ?? "", `e${n}`);
}
rmSync(dir, { recursive: true, force: true });

const profile = profileCost(log, rounds);
const defaultBudget = Math.ceil(profile.callsPerSync * 2);
const budget = Number(flag("assert-under", String(defaultBudget)));

console.log(`sync:measure --scenario ${scenario} --rounds ${rounds}`);
console.log("");
console.log("MEASURED");
console.log(`  gog calls per sync: ${profile.callsPerSync.toFixed(1)}`);
console.log(`  total calls       : ${profile.calls}`);
console.log(`  total bytes       : ${profile.bytes.toLocaleString("en-US")}`);
console.log(`  client-observed ms: ${profile.ms}`);
console.log("");
console.log("BY SUBCOMMAND (this is the part that explains the number)");
for (const [command, b] of Object.entries(profile.byCommand)) {
  const shareMs = profile.ms ? ((b.ms / profile.ms) * 100).toFixed(1) : "0.0";
  console.log(
    `  ${command.padEnd(9)} calls=${String(b.calls).padStart(4)}  ` +
      `bytes=${String(b.bytes).padStart(8)}  ms=${String(b.ms).padStart(5)} (${shareMs}%)`,
  );
}
console.log("");
console.log("WHAT DOMINATED");
if (profile.dominantByTime === null) {
  console.log("  nothing was measured - a gate on an empty measurement is not a gate");
} else {
  console.log(
    `  ${profile.dominantByTime.command} dominated on time: ` +
      `${(profile.dominantByTime.share * 100).toFixed(1)}% of the total`,
  );
}
console.log("");
console.log("BUDGET (decision-kax: measured cost + 2x headroom)");
console.log(`  measured ${profile.callsPerSync.toFixed(1)} calls/sync -> budget ${budget}`);

const failures: string[] = [];
if (profile.dominantByTime === null) {
  failures.push("the measurement is empty; a budget on an empty measurement proves nothing");
}
if (profile.callsPerSync > budget) {
  failures.push(
    `measured ${profile.callsPerSync.toFixed(1)} calls/sync exceeds the budget of ${budget}`,
  );
}

if (failures.length > 0) {
  console.error("\nsync:measure FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nsync:measure PASSED");
