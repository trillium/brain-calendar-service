// The four rollout phases, in the only order that is safe.
//
// shadow -> backfill -> pull-only -> bidirectional
//
// Pull-only before bidirectional is not optional: it is the cheapest place to
// discover that your conflict semantics are wrong, because the blast radius is
// one direction. Going straight to bidirectional discovers the same thing with
// the blast radius in both directions.
//
// The phase is a VALUE, not a flag passed to a function, because a phase that
// can be set from the command line is a phase that will be set to the last
// value during an incident.

export const PHASES = ["shadow", "backfill", "pull-only", "bidirectional"] as const;
type Phase = (typeof PHASES)[number];

/** Nothing a phase may write. Backfill writes events but creates nothing twice. */
interface PhaseRights {
  readonly writesToProvider: boolean;
  readonly readsFromProvider: boolean;
  readonly deletesFromProvider: boolean;
}

export const RIGHTS: Record<Phase, PhaseRights> = {
  shadow: { writesToProvider: false, readsFromProvider: true, deletesFromProvider: false },
  backfill: { writesToProvider: true, readsFromProvider: true, deletesFromProvider: false },
  "pull-only": { writesToProvider: false, readsFromProvider: true, deletesFromProvider: false },
  bidirectional: { writesToProvider: true, readsFromProvider: true, deletesFromProvider: false },
};

/**
 * DELETE IS NEVER A RIGHT OF ANY PHASE.
 *
 * Deleting an external event this service did not create is irreversible and
 * customer-visible, and it is gated behind an explicit human decision. Encoding
 * that as the absence of a capability rather than as a flag someone can set is
 * the same reasoning as the deny-by-default write path: unrepresentable beats
 * documented.
 */
export const mayDelete = (_phase: Phase): false => false;

interface BackfillCandidate {
  readonly beadId: string;
  readonly summary: string;
  readonly startUtc: string;
  readonly durationSeconds: number;
  /** The idempotency marker written onto the created event. */
  readonly markerKey: string;
  readonly markerValue: string;
}

interface BackfillResult {
  readonly created: number;
  readonly skipped: number;
  readonly createdUids: string[];
}

/**
 * Backfill, idempotent from the FIRST run.
 *
 * The marker is what makes a re-run a no-op, and it is checked BEFORE creating
 * anything - so a partial failure re-run creates nothing twice. This is the
 * single most common way a calendar integration becomes a duplicate-event
 * incident.
 *
 * `existingMarkers` is mutable and is written to as events are created: the
 * marker map IS the record of what this service created, and a caller that
 * cannot hold it cannot be idempotent.
 */
export const backfill = (
  candidates: readonly BackfillCandidate[],
  existingMarkers: Map<string, string>,
  rights: PhaseRights,
): BackfillResult => {
  const createdUids: string[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    const key = `${candidate.markerKey}=${candidate.markerValue}`;
    if (existingMarkers.has(key)) {
      skipped += 1;
      continue;
    }
    if (!rights.writesToProvider) continue;
    existingMarkers.set(key, candidate.beadId);
    createdUids.push(`${candidate.beadId}@${candidate.startUtc}`);
  }
  return { created: createdUids.length, skipped, createdUids };
};
