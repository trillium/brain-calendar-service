// Google's silent limits and two-valued delete. These are properties of Google
// Calendar, not of the transport, so they hold under gog exactly as under CalDAV.

import { describe, expect, it } from "vitest";
import {
  assertWithinGoogleLimits,
  classifyCancelled,
  LIMITS,
  PropertyLimitError,
} from "./google-limits.js";

describe("google private-property limits", () => {
  it("accepts a marker at the limit", () => {
    expect(() =>
      assertWithinGoogleLimits({ "X-Beads-Id": "a".repeat(LIMITS.propertyValueMax) }),
    ).not.toThrow();
  });

  it("refuses an over-long KEY, which Google drops silently", () => {
    expect(() => assertWithinGoogleLimits({ "X-Beads-Id-too-long": "x" })).not.toThrow();
    expect(() =>
      assertWithinGoogleLimits({ ["X".repeat(LIMITS.propertyKeyMax + 1)]: "x" }),
    ).toThrow(PropertyLimitError);
  });

  it("refuses an over-long VALUE, which Google truncates silently", () => {
    expect(() =>
      assertWithinGoogleLimits({ "X-Beads-Id": "a".repeat(LIMITS.propertyValueMax + 1) }),
    ).toThrow(/TRUNCATES/);
  });

  it("refuses more properties than a calendar will hold", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.propertiesPerEventMax; i += 1) many[`X-${i}`] = "v";
    expect(() => assertWithinGoogleLimits(many)).toThrow(/per-event limit/);
  });

  it("states the limits the marker scheme must be built to", () => {
    expect(LIMITS.propertyKeyMax).toBe(44);
    expect(LIMITS.propertyValueMax).toBe(1024);
  });
});

describe("google's two-valued delete", () => {
  it("treats a cancelled exception of a live series as 'this instance only'", () => {
    expect(
      classifyCancelled({
        cancelled: true,
        recurrenceId: "2026-03-04T10:00:00Z",
        parent: { uid: "series@example.com", cancelled: false },
      }),
    ).toBe("cancel_instance");
  });

  it("treats a cancelled PARENT as a delete of the whole series", () => {
    expect(
      classifyCancelled({
        cancelled: true,
        recurrenceId: null,
        parent: { uid: "series@example.com", cancelled: true },
      }),
    ).toBe("delete_event");
  });

  it("treats a cancelled exception of an already-cancelled series as a delete", () => {
    expect(
      classifyCancelled({
        cancelled: true,
        recurrenceId: "2026-03-04T10:00:00Z",
        parent: { uid: "series@example.com", cancelled: true },
      }),
    ).toBe("delete_event");
  });

  it("treats an ordinary cancelled event as a delete", () => {
    expect(classifyCancelled({ cancelled: true, recurrenceId: null })).toBe("delete_event");
  });

  it("returns null for a live event, which is not a delete at all", () => {
    expect(classifyCancelled({ cancelled: false, recurrenceId: null })).toBeNull();
  });
});
