// Google Calendar API v3 event resources -> the domain's Occurrence.
//
// Every response is validated at this boundary (zod), because a provider payload
// that is not what we think it is must fail here, by field name, and not three
// layers down as a quiet wrong date.
//
// Privacy by construction: the payload carries the title and times a sync needs,
// and only the NUMBER of attendees, never an address. The request also asks
// Google for no more than this (see FIELDS in reader.ts).

import { z } from "zod";
import type { Occurrence } from "../../domain/rfc5546/types.js";

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

const When = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

const Item = z.object({
  id: z.string().min(1),
  iCalUID: z.string().min(1).optional(),
  etag: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  sequence: z.number().int().optional(),
  updated: z.string().optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: When.optional(),
  start: When.optional(),
  end: When.optional(),
  attendees: z.array(z.object({ responseStatus: z.string().optional() })).optional(),
});

export const EventsPage = z.object({
  items: z.array(Item).default([]),
  nextPageToken: z.string().optional(),
});

type GoogleItem = z.infer<typeof Item>;
type When = z.infer<typeof When>;

const toIso = (id: string, field: string, raw: string): string => {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new MappingError(`event ${id}: ${field} is not a valid instant`);
  return new Date(ms).toISOString();
};

/**
 * A timed value is exact. An all-day value is a calendar DATE with no zone, so
 * it is pinned to 00:00Z and flagged `allDay` rather than pretending to be an
 * instant in the user's zone.
 */
const instantOf = (id: string, field: string, when: When | undefined) => {
  if (when?.dateTime !== undefined) return { iso: toIso(id, field, when.dateTime), allDay: false };
  if (when?.date !== undefined)
    return { iso: toIso(id, field, `${when.date}T00:00:00Z`), allDay: true };
  return null;
};

const recurrenceIdOf = (item: GoogleItem): string | null => {
  if (item.recurringEventId === undefined) return null;
  const original = instantOf(item.id, "originalStartTime", item.originalStartTime);
  if (original === null) {
    throw new MappingError(`event ${item.id}: instance of a series has no originalStartTime`);
  }
  return original.iso;
};

export const toOccurrence = (item: GoogleItem): Occurrence => {
  const start = instantOf(item.id, "start", item.start);
  const end = instantOf(item.id, "end", item.end);
  return {
    uid: item.iCalUID ?? item.id,
    recurrenceId: recurrenceIdOf(item),
    sequence: item.sequence ?? 0,
    // Google has no DTSTAMP; `updated` is its last-modified time, the closest honest stand-in.
    dtstamp: item.updated === undefined ? null : toIso(item.id, "updated", item.updated),
    etag: item.etag ?? null,
    source: "remote",
    payload: {
      id: item.id,
      summary: item.summary ?? "",
      // A cancelled item can arrive with no times at all; null says so.
      start: start?.iso ?? null,
      end: end?.iso ?? null,
      allDay: start?.allDay ?? false,
      status: item.status ?? "confirmed",
      attendeeCount: item.attendees?.length ?? 0,
    },
  };
};
