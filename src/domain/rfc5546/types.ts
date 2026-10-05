// Pure domain types for RFC 5546 conflict resolution.
//
// Zero I/O, zero dependencies, zero clock reads. Anything that needs "now" is
// injected by the caller, so every function here is deterministic and testable
// without a calendar, a network, or a database - which is the whole reason the
// plan makes domain/ import nothing but domain/.

/** One side of a conflict: a single VEVENT occurrence as an external system sees it. */
export interface Occurrence {
  /** VEVENT UID. Identifies the event; for a series, every occurrence shares it. */
  readonly uid: string;
  /**
   * RECURRENCE-ID, as UTC. Absent (null) means this side describes the whole
   * series (the parent). Present means this side describes one occurrence.
   */
  readonly recurrenceId: string | null;
  /**
   * SEQUENCE. Per RFC 5545 section 3.8.7.4 only the ORGANIZER's CUA increments
   * it. Beads/Dolt is the organizer in this architecture, so Beads assigns it
   * and every external calendar is a client of it.
   */
  readonly sequence: number;
  /** DTSTAMP. Breaks a SEQUENCE tie. Null sorts below every real timestamp. */
  readonly dtstamp: string | null;
  /** Provider-reported revision. Null when the provider has none (ETag-only). */
  readonly etag: string | null;
  /** Opaque record of where this side came from, for the loser payload and audit. */
  readonly source: "local" | "remote";
  /** The event payload itself. Compared canonically, never merged. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Why one side won. Named so the decision table is machine-readable and so a
 * human reading a quarantined conflict sees the actual reason rather than a
 * generic "conflict".
 */
export type ResolutionReason =
  | "different_object"
  | "different_occurrence"
  | "instance_overrides_parent"
  | "higher_sequence"
  | "later_dtstamp"
  | "identical"
  | "tie_broken_canonically";

export interface Resolution {
  /**
   * The side that stands. Null only when both sides are retained, which is a
   * successful resolution, not a failure: two different objects are not a
   * conflict at all.
   */
  readonly winner: Occurrence | null;
  /** The side that is superseded, retained verbatim so a human can undo it. */
  readonly loserPayload: Occurrence | null;
  readonly reason: ResolutionReason;
  /** What superseded what, for the audit trail. */
  readonly supersededBy: { readonly source: "local" | "remote"; readonly sequence: number } | null;
  /** Whether this pair was a conflict at all. */
  readonly conflicted: boolean;
}

/** A canonical, order-independent string form used for tie-breaking and tests. */
export const canonical = (occ: Occurrence): string =>
  JSON.stringify([occ.uid, occ.recurrenceId, occ.sequence, occ.dtstamp, occ.etag, occ.payload]);
