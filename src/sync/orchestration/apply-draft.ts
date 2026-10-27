// Turning a calendar_period row into the event the provider is asked to write,
// and the markers that make that write findable again.
//
// Two private properties travel with a created event:
//
//   bcs-key    which row this event is for, qualified by the database that owns it.
//              A create that landed but whose binding was never written (a crash
//              between the two) is found again by this marker, not duplicated.
//   bcs-owner  the ownership token, so an adopted event keeps the token it was
//              created with. Google silently drops keys over 44 characters; these
//              are short on purpose, and google-limits.ts checks them on every send.

import type { RowDataPacket } from "mysql2";
import type { CalendarProvider, EventDraft, ProviderEvent } from "../../adapters/provider.js";

export const MARKER_KEY = "bcs-key";
export const OWNER_KEY = "bcs-owner";

export interface PeriodRow {
  readonly id: number;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly summary: string;
}

/** The summary is attributes_json.summary, else the bead the period is linked to. */
export const periodFromRow = (row: RowDataPacket): PeriodRow => {
  const raw = row.attributes_json;
  const attributes = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    summary?: unknown;
  } | null;
  const summary =
    typeof attributes?.summary === "string" ? attributes.summary : (row.linked_bead_id ?? "");
  return {
    id: Number(row.id),
    startUtc: String(row.start_utc),
    endUtc: String(row.end_utc),
    summary: summary === "" ? `period ${row.id}` : summary,
  };
};

export const markerValue = (sourceDatabase: string, periodId: number): string =>
  `${sourceDatabase}:period:${periodId}`;

export const draftFor = (period: PeriodRow): EventDraft => ({
  summary: period.summary,
  from: period.startUtc,
  to: period.endUtc,
});

/**
 * Look for an event this service already created for `marker`. A listing may omit
 * extended properties, so an event that matches on summary and start but shows no
 * marker is read back through the lossless `getEvent` before it is ruled out.
 */
export const findMarked = async (
  provider: CalendarProvider,
  remoteCalendarId: string,
  listed: readonly ProviderEvent[],
  marker: string,
  draft: EventDraft,
): Promise<ProviderEvent | null> => {
  const hit = listed.find((e) => e.privateProperties[MARKER_KEY] === marker);
  if (hit !== undefined) return hit;
  const candidates = listed.filter(
    (e) =>
      e.privateProperties[MARKER_KEY] === undefined &&
      e.summary === draft.summary &&
      e.start?.dateTime === draft.from,
  );
  for (const candidate of candidates) {
    const full = await provider.getEvent(remoteCalendarId, candidate.id);
    if (full.privateProperties[MARKER_KEY] === marker) return full;
  }
  return null;
};
