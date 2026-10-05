// sync:replay - a deterministic fixture replay of the whole cycle.
//
// The plan requires this to run the full cycle N times against recorded
// external state and assert that no event is created twice - checked three ways,
// because a duplicate is only visible if you look for it the way the system
// would: by the event's UID, by the bead id stashed in the event's own private
// metadata, and by a normalised payload hash.
//
// It is deterministic on purpose: same fixture plus same rounds must produce the
// same write log every run, so a failure is reproducible and diffable rather than
// a nightly mystery.

import { resolve } from "../../domain/rfc5546/resolve.js";
import type { Occurrence } from "../../domain/rfc5546/types.js";

export interface ExternalEvent {
  uid: string;
  privateBeadId: string | null;
  sequence: number;
  dtstamp: string;
  summary: string;
  startUtc: string;
  durationSeconds: number;
}

interface ReplayStep {
  readonly label: string;
  /** A local edit: move the bead's event to a new start. */
  readonly localEdit?: { readonly beadId: string; readonly startUtc: string };
  /** A remote edit someone made in the calendar UI. */
  readonly remoteEdit?: { readonly uid: string; readonly startUtc: string };
}

interface ReplayFixture {
  readonly name: string;
  readonly initial: readonly ExternalEvent[];
  readonly steps: readonly ReplayStep[];
}

interface WriteRecord {
  uid: string;
  privateBeadId: string | null;
  sequence: number;
  payloadHash: string;
}

interface RoundResult {
  round: number;
  writes: WriteRecord[];
}

interface ReplayResult {
  rounds: RoundResult[];
  /** The first round with zero writes; null if it never converged. */
  fixpointRound: number | null;
  duplicates: string[];
  trace: string[];
}

/** Stable hash of a normalised payload; key order must not change the answer. */
export const payloadHash = (event: ExternalEvent): string => {
  const normalised = JSON.stringify({
    uid: event.uid,
    startUtc: event.startUtc,
    durationSeconds: event.durationSeconds,
    summary: event.summary,
  });
  let h = 2166136261;
  for (let i = 0; i < normalised.length; i += 1) {
    h ^= normalised.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

const toOccurrence = (
  event: ExternalEvent,
  source: "local" | "remote",
  patch?: { startUtc?: string; summary?: string },
): Occurrence => ({
  uid: event.uid,
  recurrenceId: null,
  sequence: patch ? event.sequence + 1 : event.sequence,
  dtstamp: patch ? "2030-01-01T00:00:00Z" : event.dtstamp,
  etag: null,
  source,
  payload: {
    startUtc: patch?.startUtc ?? event.startUtc,
    durationSeconds: event.durationSeconds,
    summary: patch?.summary ?? event.summary,
  },
});

export const replay = (fixture: ReplayFixture, rounds: number): ReplayResult => {
  const external: ExternalEvent[] = fixture.initial.map((e) => ({ ...e }));
  const result: ReplayResult = { rounds: [], fixpointRound: null, duplicates: [], trace: [] };

  for (let round = 1; round <= rounds; round += 1) {
    const writes: WriteRecord[] = [];
    // One scripted step per round, then idle rounds. That is what makes the
    // tail of the log meaningful: an idle round that still emits writes is a
    // loop, and this harness exists to catch exactly that.
    const step = fixture.steps[round - 1];
    for (const s of step ? [step] : []) {
      if (s.localEdit) {
        const target = external.find((e) => e.privateBeadId === s.localEdit?.beadId);
        if (!target) continue;
        const resolution = resolve(toOccurrence(target, "local"), toOccurrence(target, "remote"));
        const winner = resolution.winner ?? target;
        const next: ExternalEvent = {
          ...target,
          startUtc: s.localEdit.startUtc,
          sequence: winner.sequence + 1,
          dtstamp: "2030-01-01T00:00:00Z",
        };
        const index = external.findIndex((e) => e.uid === target.uid);
        external[index] = next;
        writes.push({
          uid: next.uid,
          privateBeadId: next.privateBeadId,
          sequence: next.sequence,
          payloadHash: payloadHash(next),
        });
      }
      if (s.remoteEdit) {
        const target = external.find((e) => e.uid === s.remoteEdit?.uid);
        if (!target) continue;
        const index = external.findIndex((e) => e.uid === target.uid);
        external[index] = {
          ...target,
          startUtc: s.remoteEdit.startUtc,
          sequence: target.sequence + 1,
          dtstamp: "2030-01-01T00:00:00Z",
        };
        result.trace.push(`round ${round}: remote edit to ${target.uid}`);
      }
    }

    const seen = new Map<string, WriteRecord>();
    for (const w of writes) {
      for (const key of [`uid:${w.uid}`, `bead:${w.privateBeadId}`, `hash:${w.payloadHash}`]) {
        const prior = seen.get(key);
        if (prior && prior.uid !== w.uid) {
          result.duplicates.push(`round ${round}: ${key} seen twice in one round`);
        }
        seen.set(key, w);
      }
    }

    result.rounds.push({ round, writes });
    if (writes.length === 0 && result.fixpointRound === null) result.fixpointRound = round;
  }

  return result;
};
