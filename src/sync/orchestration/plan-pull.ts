// Turning observed remote edits into pulls, through the SAME RFC 5546 resolution
// the rest of the engine uses rather than a second rule of its own.
//
// Dolt is the organizer, so only Dolt assigns SEQUENCE. A remote client cannot
// bump it, which makes a remote edit "the next revision after the last one we
// wrote": binding sequence + 1. A period changed locally since its binding was
// last written is also the next revision. When both sides hold a next revision nobody can say which one was
// made knowing about the other, and a pull would overwrite a local edit while a
// push would overwrite a remote one. Neither is undone by the loser's author, so
// that pair is quarantined, with what RFC 5546 would have picked kept beside it.

import { resolve } from "../../domain/rfc5546/resolve.js";
import type { Occurrence } from "../../domain/rfc5546/types.js";
import type { PlanPull, Quarantine, RemoteChange } from "./pull-types.js";

const payloadOf = (side: { summary: string; startUtc: string; endUtc: string }) => ({
  summary: side.summary,
  startUtc: side.startUtc,
  endUtc: side.endUtc,
});

const localOccurrence = (change: RemoteChange, sequence: number): Occurrence => ({
  uid: change.externalUid,
  recurrenceId: null,
  sequence,
  dtstamp: change.local.updatedUtc,
  etag: null,
  source: "local",
  payload: payloadOf(change.local),
});

const remoteOccurrence = (change: RemoteChange): Occurrence => ({
  uid: change.externalUid,
  recurrenceId: null,
  sequence: change.sequence + 1,
  dtstamp: change.remote.updated,
  etag: change.remote.etag,
  source: "remote",
  payload: payloadOf(change.remote),
});

interface PulledPlan {
  readonly pull: PlanPull[];
  readonly quarantined: Quarantine[];
}

const toPull = (change: RemoteChange, reason: string): PlanPull => ({
  beadId: change.beadId,
  externalUid: change.externalUid,
  reason,
  periodId: change.periodId,
  startUtc: change.remote.startUtc,
  endUtc: change.remote.endUtc,
  previous: { startUtc: change.local.startUtc, endUtc: change.local.endUtc },
  etag: change.remote.etag,
  updated: change.remote.updated,
});

export const planPulls = (changes: readonly RemoteChange[]): PulledPlan => {
  const out: { pull: PlanPull[]; quarantined: Quarantine[] } = { pull: [], quarantined: [] };
  for (const change of changes) {
    const isPending = change.localPending;
    const local = localOccurrence(change, change.sequence + (isPending ? 1 : 0));
    const remote = remoteOccurrence(change);
    const decision = resolve(local, remote);
    if (!isPending && decision.conflicted && decision.winner?.source === "remote") {
      out.pull.push(toPull(change, decision.reason));
      continue;
    }
    out.quarantined.push({
      beadId: change.beadId,
      externalUid: change.externalUid,
      reason:
        `concurrent edit of ${change.externalUid}: Dolt and the provider both changed it since ` +
        `the last sync; held for a human (RFC 5546 would pick ${decision.winner?.source ?? "neither"}` +
        ` by ${decision.reason})`,
      conflict: {
        code: "concurrent_edit",
        local,
        remote,
        verdict: `${decision.winner?.source ?? "neither"}: ${decision.reason}`,
      },
    });
  }
  return out;
};
