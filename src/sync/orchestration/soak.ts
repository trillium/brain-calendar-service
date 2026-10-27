// The soak recorder: one line of evidence per live round.
//
// `sync:soak-report` passes only on real evidence, and nothing but a live round
// may produce it, so this is called after every non-dry-run round and nowhere
// else. It appends to evidence/soak/report.json in the shape that script already
// reads (`rounds`, `conflictsPerRound`, `quarantined`) and keeps the per-round
// records beside them. A report it cannot read is an error, never a fresh start:
// overwriting evidence is how a soak quietly loses its history.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ApplyResult } from "./apply.js";
import type { SyncPlan } from "./plan.js";

const count = z.number().int().nonnegative();
const roundSchema = z.object({
  round: z.number().int().positive(),
  conflicts: count,
  quarantined: count,
  pushes: count,
  pulls: count,
});
const reportSchema = z.object({
  rounds: count,
  conflictsPerRound: z.array(count),
  quarantined: count,
  roundLog: z.array(roundSchema),
});

type SoakRound = z.infer<typeof roundSchema>;

/** What a round did, in the soak report's terms. Applied counts, not planned ones. */
export const soakEntry = (plan: SyncPlan, applied: ApplyResult): Omit<SoakRound, "round"> => ({
  conflicts: plan.conflicts,
  quarantined: plan.conflictsQuarantined,
  pushes: applied.created + applied.updated + applied.adopted,
  pulls: applied.pulled,
});

const readReport = (file: string): z.infer<typeof reportSchema> | null => {
  if (!existsSync(file)) return null;
  return reportSchema.parse(JSON.parse(readFileSync(file, "utf8")));
};

/**
 * Append a round and return its number. `quarantined` at the top level is the
 * latest round's count: quarantine only ever clears by a human's decision, so a
 * sum across rounds would count the same held conflict once per round.
 */
export const recordSoakRound = (file: string, entry: Omit<SoakRound, "round">): SoakRound => {
  const previous = readReport(file) ?? {
    rounds: 0,
    conflictsPerRound: [],
    quarantined: 0,
    roundLog: [],
  };
  const round: SoakRound = { round: previous.rounds + 1, ...entry };
  const next = {
    rounds: round.round,
    conflictsPerRound: [...previous.conflictsPerRound, round.conflicts],
    quarantined: round.quarantined,
    roundLog: [...previous.roundLog, round],
  };
  mkdirSync(dirname(file), { recursive: true });
  const staging = `${file}.tmp`;
  writeFileSync(staging, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(staging, file);
  return round;
};
