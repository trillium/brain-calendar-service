// RFC 5546 section 2.1.5 conflict and sequence semantics, as a total order.
//
// The three keys, in order:
//   1. identity   - UID, plus RECURRENCE-ID for a single occurrence
//   2. SEQUENCE   - highest obsoletes lower
//   3. DTSTAMP    - breaks a SEQUENCE tie
//
// Why identity comes first: two sides that are not the same object cannot
// conflict. Resolving them by sequence would silently drop one of them, which
// is the worst failure this stage could have.
//
// Why Beads is the organizer: per RFC 5545 section 3.8.7.4 only the ORGANIZER's
// CUA increments SEQUENCE. This architecture makes Dolt authoritative, so Dolt
// assigns SEQUENCE and every external calendar is a client of it. If Beads ever
// stops being the organizer, this module is where that shows up - it must be
// re-opened, not patched.
//
// Total by construction: every pair of inputs returns a Resolution with a named
// reason. There is no "unknown" branch and none may be added; the property test
// asserts the absence of one, which is gate G1.

import { canonical, type Occurrence, type Resolution, type ResolutionReason } from "./types.js";

/** A missing or unparsable DTSTAMP sorts below every real timestamp, never throws. */
const dtstampRank = (dtstamp: string | null): number => {
  if (dtstamp === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(dtstamp);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const retainBoth = (reason: ResolutionReason): Resolution => ({
  winner: null,
  loserPayload: null,
  reason,
  supersededBy: null,
  conflicted: false,
});

const supersede = (
  winner: Occurrence,
  loser: Occurrence,
  reason: ResolutionReason,
): Resolution => ({
  winner,
  loserPayload: loser,
  reason,
  supersededBy: { source: winner.source, sequence: winner.sequence },
  conflicted: true,
});

/**
 * Resolve one pair.
 *
 * `base` is the common ancestor when the caller has one. It is accepted so a
 * three-way view can be shown to whoever reviews a quarantined conflict, but it
 * deliberately does NOT change the outcome: RFC 5546 resolves by
 * last-writer-wins, it does not merge fields, and merging would reintroduce the
 * field-level authority question the approved architecture rejected.
 */
export const resolve = (
  local: Occurrence,
  remote: Occurrence,
  base?: Occurrence | null,
): Resolution => {
  void base;

  // 1. Identity: are these even the same thing?
  if (local.uid !== remote.uid) return retainBoth("different_object");
  if (
    local.recurrenceId !== null &&
    remote.recurrenceId !== null &&
    local.recurrenceId !== remote.recurrenceId
  ) {
    return retainBoth("different_occurrence");
  }
  if (local.recurrenceId !== remote.recurrenceId) {
    // A parent and one of its own instances are not in conflict: the instance
    // overlays the parent for one occurrence, and the parent still governs all
    // the others. Keeping both is the correct answer, not a compromise.
    const instance = local.recurrenceId !== null ? local : remote;
    return {
      winner: instance,
      loserPayload: null,
      reason: "instance_overrides_parent",
      supersededBy: null,
      conflicted: false,
    };
  }

  // 2. SEQUENCE: highest obsoletes lower.
  if (local.sequence > remote.sequence) return supersede(local, remote, "higher_sequence");
  if (remote.sequence > local.sequence) return supersede(remote, local, "higher_sequence");

  // 3. DTSTAMP: breaks a SEQUENCE tie.
  const localStamp = dtstampRank(local.dtstamp);
  const remoteStamp = dtstampRank(remote.dtstamp);
  if (localStamp > remoteStamp) return supersede(local, remote, "later_dtstamp");
  if (remoteStamp > localStamp) return supersede(remote, local, "later_dtstamp");

  // Neither key separated them. RFC 5546 says nothing further, so break the
  // tie deterministically on the canonical form rather than on which argument
  // happened to arrive first: commutativity is a property this stage is gated
  // on, and "prefer whoever called" would not survive it.
  const left = canonical(local);
  const right = canonical(remote);
  if (left === right) return supersede(local, remote, "identical");
  return left > right
    ? supersede(local, remote, "tie_broken_canonically")
    : supersede(remote, local, "tie_broken_canonically");
};
