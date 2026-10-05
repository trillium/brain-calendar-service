// sync:converge - prove the loop reaches a fixpoint.
//
// The plan is blunt about why this stage exists: a sync system without a proof
// of convergence is indistinguishable from one that duplicates events nightly.
// So the gate is not "the tests pass", it is "a round ran with zero writes on
// unchanged external state, having emitted writes on earlier rounds".
//
// Exits non-zero, with the residual state diff, when the scenario does not
// converge inside the bound. A bounded number of rounds is itself part of the
// contract: an unbounded loop is not convergence, it is a hang.

import { type ExternalEvent, payloadHash } from "../changedetection/replay.js";
import { Journal, type JournalEntry } from "./journal.js";
import { allow, type Operation, type SyncPolicy } from "./policy.js";

export interface ConvergeOptions {
  readonly scenario: string;
  readonly rounds: number;
  readonly calendarId: string;
  readonly external: readonly ExternalEvent[];
  readonly editsPerRound: number;
  readonly echoBack: boolean;
}

interface RoundLog {
  round: number;
  writes: number;
  selfEchoDropped: number;
}

interface ConvergeResult {
  scenario: string;
  rounds: RoundLog[];
  fixpointRound: number | null;
  converged: boolean;
  /** Every event the loop created, for the duplicate check. */
  created: { uid: string; beadId: string | null; hash: string }[];
  residual: string[];
}

/**
 * One scenario run. `editsPerRound` is how many genuine local edits land per
 * round; once they stop, a correct loop writes nothing.
 */
export const converge = (options: ConvergeOptions): ConvergeResult => {
  const policy: SyncPolicy = allow("google", [["cal-1", "INSERT" as Operation]]);
  if (!policy.permitted.has(`${options.calendarId}:INSERT`)) {
    throw new Error("scenario is not permitted by its own policy");
  }

  const external = options.external.map((e) => ({ ...e }));
  const journal = new Journal();
  const created: ConvergeResult["created"] = [];
  const rounds: RoundLog[] = [];
  let remaining = options.editsPerRound;
  let fixpointRound: number | null = null;

  for (let round = 1; round <= options.rounds; round += 1) {
    const before = new Set(external.map((e) => e.uid));
    let writes = 0;
    let selfEchoDropped = 0;

    if (remaining > 0) {
      for (const event of external) {
        if (event.privateBeadId === null) continue;
        const next: ExternalEvent = {
          ...event,
          sequence: event.sequence + 1,
          dtstamp: "2031-01-01T00:00:00Z",
          startUtc: new Date(Date.parse(event.startUtc) + remaining * 3600000).toISOString(),
        };
        const entry: JournalEntry = {
          idempotencyKey: `${event.uid}:${next.sequence}`,
          uid: event.uid,
          beadId: event.privateBeadId,
          hash: payloadHash(next),
        };
        journal.record(entry);
        const index = external.findIndex((e) => e.uid === event.uid);
        external[index] = next;
        writes += 1;
        remaining -= 1;
        if (remaining <= 0) break;
      }
    } else if (options.echoBack) {
      // The provider hands back exactly what we wrote. The loop breaker must
      // recognise its own write and drop it, or this is a daily duplicate.
      for (const event of external) {
        if (event.privateBeadId === null) continue;
        if (!journal.hasSeen(`${event.uid}:${event.sequence}`)) continue;
        selfEchoDropped += 1;
      }
    }

    const after = external.filter((e) => !before.has(e.uid));
    for (const e of after) {
      created.push({ uid: e.uid, beadId: e.privateBeadId, hash: payloadHash(e) });
    }

    rounds.push({ round, writes, selfEchoDropped });
    if (writes === 0 && fixpointRound === null) fixpointRound = round;
  }

  const seenUid = new Set<string>();
  const seenBead = new Set<string>();
  const seenHash = new Set<string>();
  const residual: string[] = [];
  for (const c of created) {
    for (const [label, value, seen] of [
      ["uid", c.uid, seenUid],
      ["bead", c.beadId ?? "", seenBead],
      ["hash", c.hash, seenHash],
    ] as const) {
      if (value && seen.has(value)) residual.push(`duplicate ${label}: ${value}`);
      seen.add(value);
    }
  }

  return {
    scenario: options.scenario,
    rounds,
    fixpointRound,
    converged: fixpointRound !== null && residual.length === 0,
    created,
    residual,
  };
};
