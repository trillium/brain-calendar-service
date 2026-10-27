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

/** Wide and explicit, so the search never depends on the provider's default range. */
const MARKER_WINDOW = { from: "2000-01-01", to: "2100-01-01" } as const;

/**
 * Look for an event this service already created for `marker`, by the marker
 * itself rather than by the period's current time, so a period moved since its
 * create was landed is still found. A listing may omit extended properties, so
 * each hit is read back through the lossless `getEvent` and confirmed there.
 */
export const findMarked = async (
  provider: CalendarProvider,
  remoteCalendarId: string,
  marker: string,
): Promise<ProviderEvent | null> => {
  const hits = await provider.listEvents(remoteCalendarId, {
    ...MARKER_WINDOW,
    privateProperty: { key: MARKER_KEY, value: marker },
  });
  for (const hit of hits) {
    const full = await provider.getEvent(remoteCalendarId, hit.id);
    if (full.privateProperties[MARKER_KEY] === marker) return full;
  }
  return null;
};
