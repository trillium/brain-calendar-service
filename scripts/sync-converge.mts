#!/usr/bin/env tsx
// sync:converge - the S5 gate.
//
//   pnpm run sync:converge --scenario loop --rounds 5
//
// Exits 0 only when the scenario reaches a fixpoint: a round with writes=0 on
// unchanged external state, having emitted writes on earlier rounds, with no
// duplicate created by UID, by private bead id, or by normalised payload hash.
// Otherwise it exits non-zero and prints the residual state.

import { type ConvergeOptions, converge } from "../src/sync/loop/converge.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const scenario = flag("scenario", "loop");
const rounds = Number(flag("rounds", "5"));

const external = [
  {
    uid: "evt-loop-1@example.com",
    privateBeadId: "brain-loop-1",
    sequence: 0,
    dtstamp: "2026-01-01T00:00:00Z",
    summary: "Loop one",
    startUtc: "2026-04-01T15:00:00.000Z",
    durationSeconds: 900,
  },
  {
    uid: "evt-loop-2@example.com",
    privateBeadId: "brain-loop-2",
    sequence: 0,
    dtstamp: "2026-01-01T00:00:00Z",
    summary: "Loop two",
    startUtc: "2026-04-02T15:00:00.000Z",
    durationSeconds: 900,
  },
];

const options: ConvergeOptions = {
  scenario,
  rounds,
  calendarId: "cal-1",
  external,
  editsPerRound: 2,
  echoBack: true,
};

const result = converge(options);
console.log(`sync:converge --scenario ${scenario} --rounds ${rounds}`);
for (const r of result.rounds) {
  console.log(`  round ${r.round}: writes=${r.writes} selfEchoDropped=${r.selfEchoDropped}`);
}
console.log(`  fixpoint round: ${result.fixpointRound ?? "none"}`);
console.log(`  events created: ${result.created.length}`);

if (!result.converged) {
  console.error("\nsync:converge FAILED:");
  if (result.fixpointRound === null) {
    console.error("  - no round reached writes=0 inside the bound; convergence unproven");
  }
  for (const r of result.residual) console.error(`  - ${r}`);
  process.exit(1);
}
console.log("sync:converge PASSED");
