// S3's four named fixtures, plus the pinned-table contract.
//
// The plan names these four cases specifically, and they are the cases where
// calendar implementations historically go wrong:
//   1. 09:00 weekly across BOTH US DST boundaries
//   2. an all-day event in a zone whose DST transition happens AT MIDNIGHT
//   3. a monthly-on-the-31st series (months without a 31st are skipped)
//   4. a RECURRENCE-ID exception overlay producing exactly one patched occurrence
//
// Everything is asserted against the PINNED table, never against the host's live
// tzdata, so these tests pass or fail for reasons the code controls.

import { describe, expect, it } from "vitest";
import { expand } from "./expand.js";
import { HORIZON } from "./ical.timezones.generated.js";
import {
  instantOfWallClock,
  isoUtc,
  OutOfHorizonError,
  offsetSecondsAt,
  SUPPORTED_ZONES,
  wallClockAt,
} from "./zones.js";

const NY = "America/New_York";

describe("1. 09:00 weekly across both US DST boundaries", () => {
  // 2026-03-08 is the spring-forward, 2026-11-01 the fall-back, for New York.
  const occurrences = expand({
    uid: "weekly-9am",
    dtstart: "2026-03-01T09:00:00",
    zone: NY,
    durationSeconds: 3600,
    rrule: "FREQ=WEEKLY;COUNT=40",
  });

  it("keeps 09:00 local across both boundaries", () => {
    expect(occurrences.length).toBe(40);
    for (const o of occurrences) {
      expect(o.localStart.slice(11)).toBe("09:00:00");
    }
  });

  it("actually crosses a spring-forward and a fall-back", () => {
    const offsets = new Set(occurrences.map((o) => o.utcOffsetSeconds));
    expect(offsets).toEqual(new Set([-18000, -14400])); // EST then EDT
  });

  it("keeps the interval at 7 days of wall-clock time, in real hours", () => {
    // 168h normally; 167h across spring-forward; 169h across fall-back. Anything
    // else means the series drifted by a wall-clock hour somewhere.
    const HOUR = 3600000;
    for (let i = 1; i < occurrences.length; i += 1) {
      const gap =
        (Date.parse(occurrences[i].recurrenceIdUtc) -
          Date.parse(occurrences[i - 1].recurrenceIdUtc)) /
        HOUR;
      expect([168, 167, 169]).toContain(gap);
    }
  });

  it("shows the spring-forward week as 23 hours of real time", () => {
    const weekOf = (iso: string) =>
      occurrences.find((o) => o.recurrenceIdUtc.startsWith(iso))?.recurrenceIdUtc;
    const before = Date.parse(weekOf("2026-03-01") as string);
    const after = Date.parse(weekOf("2026-03-08") as string);
    // 168 wall-clock hours minus the one hour the clocks skipped.
    expect((after - before) / 3600000).toBe(167);
  });
});

describe("2. all-day in a zone whose DST transition happens at midnight", () => {
  // America/Santiago moves its clocks at 24:00 local: a day can begin at 01:00
  // or the calendar day itself can be 23 or 25 hours long.
  const zone = "America/Santiago";

  it("keeps an all-day event on its calendar date through the transition", () => {
    const occurrences = expand({
      uid: "all-day",
      dtstart: "2026-09-01T00:00:00",
      zone,
      durationSeconds: 86400,
      rrule: "FREQ=DAILY;COUNT=10",
    });
    expect(occurrences).toHaveLength(10);
    expect(occurrences.map((o) => o.localStart.slice(0, 10))).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
    ]);
  });

  it("reports the transition day as a 23-hour day in real time", () => {
    const start = instantOfWallClock(zone, {
      year: 2026,
      month: 9,
      day: 6,
      hour: 0,
      minute: 0,
      second: 0,
    });
    const nextDay = instantOfWallClock(zone, {
      year: 2026,
      month: 9,
      day: 7,
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect((nextDay - start) / 3600000).toBe(23);
  });
});

describe("3. a monthly series on the 31st", () => {
  const occurrences = expand({
    uid: "monthly-31",
    dtstart: "2026-01-31T14:00:00",
    zone: "UTC",
    durationSeconds: 1800,
    rrule: "FREQ=MONTHLY;COUNT=8",
  });

  it("skips months that have no 31st rather than spilling into the next month", () => {
    expect(occurrences.map((o) => o.localStart.slice(0, 10))).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-08-31",
      "2026-10-31",
      "2026-12-31",
      "2027-01-31",
    ]);
  });

  it("never lands on a day other than the 31st", () => {
    for (const o of occurrences) expect(o.localStart.slice(8, 10)).toBe("31");
  });
});

describe("4. a RECURRENCE-ID exception overlay", () => {
  const base = {
    uid: "standup",
    dtstart: "2026-01-05T09:00:00",
    zone: "UTC",
    durationSeconds: 900,
    rrule: "FREQ=DAILY;COUNT=10",
  };

  it("patches exactly one occurrence and leaves the other nine alone", () => {
    const plain = expand(base);
    const target = plain[3].recurrenceIdUtc;
    const patched = expand({
      ...base,
      exceptions: [{ recurrenceIdUtc: target, start: "2026-01-08T16:30:00", summary: "Moved" }],
    });

    expect(patched).toHaveLength(10);
    expect(patched.filter((o) => o.patched)).toHaveLength(1);
    const changed = patched.find((o) => o.patched);
    expect(changed?.localStart).toBe("2026-01-08T16:30:00");
    expect(changed?.summary).toBe("Moved");
    expect(patched.filter((o) => !o.patched)).toHaveLength(9);
  });

  it("does not shift the following occurrences", () => {
    const plain = expand(base);
    const patched = expand({
      ...base,
      exceptions: [{ recurrenceIdUtc: plain[3].recurrenceIdUtc, start: "2026-01-08T16:30:00" }],
    });
    expect(patched.map((o) => o.recurrenceIdUtc)).toEqual(plain.map((o) => o.recurrenceIdUtc));
  });

  it("materialises a cancelled occurrence the rule never generated", () => {
    const patched = expand({
      ...base,
      exceptions: [
        { recurrenceIdUtc: "2026-06-01T09:00:00.000Z", cancelled: true, summary: "Off" },
      ],
    });
    const cancelled = patched.find((o) => o.cancelled);
    expect(cancelled?.recurrenceIdUtc).toBe("2026-06-01T09:00:00.000Z");
    expect(patched.filter((o) => !o.cancelled)).toHaveLength(10);
  });
});

describe("the pinned table is a contract, not a convenience", () => {
  it("refuses an instant outside the horizon instead of guessing", () => {
    expect(() => offsetSecondsAt(NY, Date.parse("2100-01-01T00:00:00Z"))).toThrow(
      OutOfHorizonError,
    );
  });

  it("refuses a zone it does not pin", () => {
    expect(() => offsetSecondsAt("Mars/Olympus_Mons", Date.parse("2026-01-01T00:00:00Z"))).toThrow(
      /Unsupported timezone/,
    );
  });

  it("pins every zone it claims to support", () => {
    expect(SUPPORTED_ZONES.length).toBeGreaterThanOrEqual(8);
    expect(SUPPORTED_ZONES).toContain(NY);
    expect(HORIZON.start).toBeLessThan(2026);
    expect(HORIZON.end).toBeGreaterThan(2026);
  });

  it("round-trips a wall clock through an instant for every supported zone", () => {
    for (const zone of SUPPORTED_ZONES) {
      const wall = { year: 2026, month: 6, day: 15, hour: 12, minute: 0, second: 0 };
      const ms = instantOfWallClock(zone, wall);
      expect(wallClockAt(zone, ms)).toBe("2026-06-15T12:00:00");
      expect(isoUtc(ms)).toMatch(/Z$/);
    }
  });
});
