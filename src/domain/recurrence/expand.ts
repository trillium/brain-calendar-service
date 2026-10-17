// Recurrence expansion, with exceptions.
//
// rrule.js is deliberately NOT used. It deviates from RFC 5545 in two ways that
// matter on the wire - BYDAY renamed for yearly BYYDAY rules, and DTSTART not
// guaranteed to be the first instance - and Google rejects both. ical.js is used
// for the recurrence RULE only; all timezone arithmetic is done by zones.ts
// against the pinned table, because ical.js ships no timezone data at all.

import ICAL from "ical.js";
import {
  HORIZON_END,
  instantOfWallClock,
  isoUtc,
  offsetSecondsAt,
  parseWall,
  wallClockAt,
} from "./zones.js";

interface OccurrencePatch {
  /** The RECURRENCE-ID this patch applies to, as an ISO-8601 UTC instant. */
  readonly recurrenceIdUtc: string;
  /** Replacement local wall time. */
  readonly start?: string;
  readonly durationSeconds?: number;
  readonly summary?: string;
  readonly cancelled?: boolean;
}

interface RecurrenceOccurrence {
  /** UTC instant, which is the RECURRENCE-ID. */
  readonly recurrenceIdUtc: string;
  /** Local wall time as the user sees it. */
  readonly localStart: string;
  readonly durationSeconds: number;
  readonly utcOffsetSeconds: number;
  readonly summary: string;
  readonly patched: boolean;
  readonly cancelled: boolean;
}

interface ExpandWindow {
  /** Keep occurrences starting at or after this UTC instant. Default: no lower bound. */
  readonly from?: string;
  /**
   * Stop before this UTC instant (exclusive). An open-ended rule (no COUNT, no
   * UNTIL) with no `to` stops at the end of the pinned timezone table (to
   * within 14 hours) instead of walking past it and throwing: it has no last
   * occurrence of its own.
   */
  readonly to?: string;
}

interface ExpandInput {
  /** Floating local start, e.g. "2026-01-05T09:00:00". */
  readonly dtstart: string;
  readonly zone: string;
  readonly durationSeconds: number;
  /** An RRULE body, e.g. "FREQ=WEEKLY;COUNT=6". */
  readonly rrule: string;
  /** RDATE list, floating local times. */
  readonly rdates?: readonly string[];
  /** VEVENT UID; required for an EXDATE/exception surface. */
  readonly uid: string;
  readonly summary?: string;
  readonly exceptions?: readonly OccurrencePatch[];
  /** Hard cap on generated occurrences, so a bad rule cannot run forever. */
  readonly limit?: number;
  readonly window?: ExpandWindow;
}

// Semicolons separate RRULE parts, so a rule body must NOT be escaped as if it
// were a value list. Escaping them yields FREQ=WEEKLY\;COUNT=6, which ical.js
// reads as the literal frequency "WEEKLY\;COUNT=6" and rejects.
const escapeListValue = (value: string) => value.replace(/([\\,;])/g, "\\$1");
const escapeTextValue = (value: string) => value.replace(/([\\,;])/g, "\\$1");

const toIcal = (iso: string) =>
  iso
    .replace(/[-:]/g, "")
    .replace("T", "T")
    .replace(/\.\d{3}Z$/, "");

const parseBound = (name: string, iso: string | undefined, fallback: number): number => {
  if (iso === undefined) return fallback;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`expand window.${name} is not an ISO instant: "${iso}"`);
  return ms;
};

/** No zone is further than 14 hours from UTC, so this is a safe margin on a wall clock. */
const MAX_UTC_OFFSET_MS = 14 * 3600 * 1000;

interface Bounds {
  readonly lower: number;
  readonly upper: number;
  /**
   * Wall-clock ceiling for an open-ended rule with no `to`. It is checked BEFORE
   * the wall time is turned into an instant, because that conversion is what
   * throws once the table ends. Infinity whenever the caller named a `to`: a
   * window that reaches past the table should fail loudly, not be trimmed.
   */
  readonly wallCeiling: number;
}

const boundsOf = (input: ExpandInput, openEnded: boolean): Bounds => ({
  lower: parseBound("from", input.window?.from, Number.NEGATIVE_INFINITY),
  upper: parseBound("to", input.window?.to, Number.POSITIVE_INFINITY),
  wallCeiling:
    openEnded && input.window?.to === undefined
      ? HORIZON_END - MAX_UTC_OFFSET_MS
      : Number.POSITIVE_INFINITY,
});

/** Expand, then overlay exceptions by RECURRENCE-ID. */
export const expand = (input: ExpandInput): RecurrenceOccurrence[] => {
  const limit = input.limit ?? 1000;
  const rdates = (input.rdates ?? []).map(escapeListValue).join(",");
  const ics = [
    "BEGIN:VEVENT",
    `UID:${escapeTextValue(input.uid)}`,
    `DTSTART;VALUE=DATE-TIME:${toIcal(input.dtstart)}`,
    `DURATION:PT${Math.round(input.durationSeconds)}S`,
    `RRULE:${input.rrule}`,
    ...(rdates ? [`RDATE;VALUE=DATE-TIME:${rdates}`] : []),
    "END:VEVENT",
  ].join("\r\n");
  const component = new ICAL.Component(ICAL.parse(ics));
  const rawRule = component.getFirstPropertyValue("rrule");
  const rawStart = component.getFirstPropertyValue("dtstart");
  if (!(rawRule instanceof ICAL.Recur) || !(rawStart instanceof ICAL.Time)) {
    // A malformed rule must fail loudly and specifically. Silently expanding
    // nothing is the quiet-wrong-calendar-data failure the plan forbids.
    throw new Error(`Could not read RRULE "${input.rrule}" or DTSTART from a generated VEVENT`);
  }
  const expansion = new ICAL.RecurExpansion({
    component,
    dtstart: rawStart,
    // The rule comes from the component itself (see ics above); passing it
    // separately is not part of this version's constructor.
  });

  const { lower, upper, wallCeiling } = boundsOf(
    input,
    rawRule.count == null && rawRule.until == null,
  );
  const patches = new Map((input.exceptions ?? []).map((p) => [p.recurrenceIdUtc, p] as const));

  const raw: RecurrenceOccurrence[] = [];
  let next = expansion.next();
  while (next && raw.length < limit) {
    const wall = parseWall(next.toString());
    // Occurrences arrive in order, so the first one past a bound ends the walk.
    if (
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) >=
      wallCeiling
    ) {
      break;
    }
    const start = instantOfWallClock(input.zone, wall);
    if (start >= upper) break;
    if (start < lower) {
      next = expansion.next();
      continue;
    }
    const id = isoUtc(start);
    const patch = patches.get(id);
    const duration = patch?.durationSeconds ?? input.durationSeconds;
    const patchedStart = patch?.start
      ? instantOfWallClock(input.zone, parseWall(patch.start))
      : start;
    raw.push({
      recurrenceIdUtc: id,
      localStart: patch?.start ?? wallClockAt(input.zone, patchedStart),
      durationSeconds: duration,
      utcOffsetSeconds: offsetSecondsAt(input.zone, patchedStart),
      summary: patch?.summary ?? input.summary ?? "",
      patched: patch !== undefined,
      cancelled: patch?.cancelled === true,
    });
    next = expansion.next();
  }

  // An exception may name an occurrence the rule did not generate (a cancelled
  // instance of a recurring event is exactly that case). RFC 5546 says the
  // exception still exists, so it is materialised rather than dropped.
  const seen = new Set(raw.map((o) => o.recurrenceIdUtc));
  for (const patch of input.exceptions ?? []) {
    if (seen.has(patch.recurrenceIdUtc)) continue;
    const at = Date.parse(patch.recurrenceIdUtc);
    if (at < lower || at >= upper) continue;
    const start = patch.start
      ? instantOfWallClock(input.zone, parseWall(patch.start))
      : Date.parse(patch.recurrenceIdUtc);
    raw.push({
      recurrenceIdUtc: patch.recurrenceIdUtc,
      localStart: patch.start ?? wallClockAt(input.zone, start),
      durationSeconds: patch.durationSeconds ?? input.durationSeconds,
      utcOffsetSeconds: offsetSecondsAt(input.zone, start),
      summary: patch.summary ?? input.summary ?? "",
      patched: true,
      cancelled: patch.cancelled === true,
    });
  }

  return raw.sort((a, b) => a.recurrenceIdUtc.localeCompare(b.recurrenceIdUtc));
};
