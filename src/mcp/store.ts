// The port the tools read and write through.
//
// The tools see only this interface. The real implementation lives in
// src/adapters/dolt, so the MCP layer still imports nothing that can reach a
// calendar provider, and a test cannot pass by quietly swapping in a stub: the
// only implementation is the Dolt one.

export interface PeriodRecord {
  grain: "day" | "week" | "month";
  /** UTC, second precision: `YYYY-MM-DDTHH:MM:SSZ`. */
  startUtc: string;
  endUtc: string;
  summary: string;
}

export interface QuarantinedConflict {
  beadId: string | null;
  externalUid: string | null;
  reason: string;
}

export interface LinkRequest {
  beadId: string;
  calendarId: string;
  externalUid: string;
}

/** A write the store refused because it would silently overwrite or orphan a record. */
export class StoreConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflict";
  }
}

export interface Store {
  /** Periods whose start lies in `[fromUtc, toUtc)`, earliest first. */
  periodsBetween(fromUtc: string, toUtc: string): Promise<PeriodRecord[]>;
  /** Every period, or only those linked to one bead, earliest first. */
  listPeriods(beadId?: string): Promise<PeriodRecord[]>;
  /** All-or-nothing. Re-adding an identical period is a no-op; a clash throws StoreConflict. */
  addPeriods(periods: readonly PeriodRecord[]): Promise<void>;
  /** Shifts the earliest period for the bead, keeping its length. Null when there is none. */
  movePeriod(beadId: string, newStartUtc: string): Promise<PeriodRecord | null>;
  /** Idempotent for the same uid; a different uid for the same bead and calendar throws. */
  link(request: LinkRequest): Promise<void>;
  /** Removes the local binding only. Returns whether one existed. Never touches a provider. */
  unlink(beadId: string, calendarId: string): Promise<boolean>;
  /** Unresolved conflicts. There is no method that resolves one, by design. */
  quarantined(): Promise<QuarantinedConflict[]>;
  close(): Promise<void>;
}
