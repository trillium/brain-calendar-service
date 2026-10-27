// The shapes the pull half passes between observing the provider, planning, and
// applying. A leaf module: it imports only domain types, so the planner and the observer can
// both depend on it without depending on each other.

import type { Occurrence } from "../../domain/rfc5546/types.js";

export interface Skipped {
  readonly beadId: string;
  readonly reason: string;
}

export interface Times {
  readonly startUtc: string;
  readonly endUtc: string;
}

export interface RemoteChange {
  readonly beadId: string;
  readonly periodId: number;
  readonly externalUid: string;
  /** The binding's external_sequence: the last SEQUENCE this service assigned. */
  readonly sequence: number;
  /** The period changed in Dolt since the commit that last wrote its binding. */
  readonly localPending: boolean;
  readonly local: Times & { readonly summary: string; readonly updatedUtc: string };
  readonly remote: Times & {
    readonly summary: string;
    readonly etag: string | null;
    readonly updated: string | null;
  };
}

export interface ForeignEvent {
  readonly externalUid: string;
  readonly summary: string | null;
  readonly reason: string;
}

/** An in-sync event whose etag moved: the binding records the copy it now agrees with. */
export interface BindingRefresh {
  readonly beadId: string;
  readonly etag: string;
  readonly updated: string | null;
}

export interface PullObservation {
  readonly changes: readonly RemoteChange[];
  readonly foreign: readonly ForeignEvent[];
  readonly skipped: readonly Skipped[];
  /** Beads whose remote copy already says what Dolt says. */
  readonly inSync: ReadonlySet<string>;
  readonly refresh: readonly BindingRefresh[];
}

export const NO_OBSERVATION: PullObservation = {
  changes: [],
  foreign: [],
  skipped: [],
  inSync: new Set(),
  refresh: [],
};

export interface PlanPull {
  readonly beadId: string;
  readonly externalUid: string;
  readonly reason: string;
  readonly periodId: number;
  /** The remote's new times: what the period becomes. */
  readonly startUtc: string;
  readonly endUtc: string;
  /** The local times the plan saw; a period that moved since is not overwritten. */
  readonly previous: Times;
  readonly etag: string | null;
  readonly updated: string | null;
  idempotencyKey?: string;
}

/** An edit made on both sides since the last sync, held for a human. */
interface ConflictPayload {
  readonly code: "concurrent_edit";
  readonly local: Occurrence;
  readonly remote: Occurrence;
  /** What RFC 5546 would have picked, kept for whoever rules on it. */
  readonly verdict: string;
}

export interface Quarantine {
  readonly beadId: string | null;
  readonly externalUid: string | null;
  readonly reason: string;
  readonly conflict?: ConflictPayload;
}
