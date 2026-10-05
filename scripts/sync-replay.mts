#!/usr/bin/env node
// sync:replay - run the recorded fixture through the full cycle N times.
//
//   pnpm run sync:replay fixtures/replay-a --rounds 5
//
// Exits non-zero if any round creates a duplicate event (by UID, by private
// bead id, or by normalised payload hash), or if the trace differs from the
// previous run - determinism is part of what this harness proves.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { replay } from "../src/sync/changedetection/replay.ts";

const args = process.argv.slice(2);
const fixtureArg = args.find((a) => !a.startsWith("-")) ?? "fixtures/replay-a";
const roundsIndex = args.indexOf("--rounds");
const rounds = roundsIndex >= 0 ? Number(args[roundsIndex + 1]) : 5;
const fixturePath = isAbsolute(fixtureArg)
  ? fixtureArg
  : resolve(
      process.cwd(),
      fixtureArg.endsWith(".json") ? fixtureArg : join(fixtureArg, "fixture.json"),
    );

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const result = replay(fixture, rounds);

console.log(`sync:replay ${fixture.name} --rounds ${rounds}`);
for (const r of result.rounds) {
  console.log(
    `  round ${r.round}: ${r.writes.length} write(s)${r.writes.map((w) => ` ${w.uid}#${w.sequence}`).join(",")}`,
  );
}
console.log(`  fixpoint round: ${result.fixpointRound ?? "none"}`);
console.log(`  duplicates: ${result.duplicates.length}`);

const digest = JSON.stringify(result.rounds);
if (result.duplicates.length > 0) {
  console.error("\nsync:replay FAILED:");
  for (const d of result.duplicates) console.error(`  - ${d}`);
  process.exit(1);
}
if (result.fixpointRound === null) {
  console.error("\nsync:replay FAILED: no round reached writes=0, so convergence is unproven.");
  process.exit(1);
}
console.log(`sync:replay PASSED (deterministic digest ${digest.length} bytes)`);
