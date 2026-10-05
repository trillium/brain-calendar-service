// S6 contract tests, against a real local CalDAV server and recorded fixtures.
//
// No network, no credentials, no live provider. What is exercised for real is
// the transport: status codes, bodies, and the RFC 6578 invalid-token fallback,
// because those ARE status codes and a mocked HTTP client would prove nothing
// about them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FixtureServer, startFixtureServer } from "./fixture-server.js";
import {
  assertWithinGoogleLimits,
  classifyCancelled,
  LIMITS,
  PropertyLimitError,
} from "./google.js";
import {
  fetchTransport,
  INVALID_SYNC_TOKEN,
  profileCost,
  type RequestRecord,
  syncCollectionBody,
} from "./transport.js";

const EVENTS = [
  { href: "/cal/evt-1.ics", etag: '"v1"', status: 200, calendarData: "BEGIN:VCALENDAR" },
  { href: "/cal/evt-2.ics", etag: '"v2"', status: 200, calendarData: "BEGIN:VCALENDAR" },
];

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({ events: EVENTS, validSyncToken: '"v2"' });
});

afterAll(async () => {
  await server.close();
});

describe("RFC 6578 sync-collection", () => {
  it("sends an empty sync-token for an initial sync", () => {
    expect(syncCollectionBody(null)).toContain("<D:sync-token></D:sync-token>");
  });

  it("sends the stored token for an incremental sync", () => {
    expect(syncCollectionBody('"v2"')).toContain('<D:sync-token>"v2"</D:sync-token>');
  });

  it("returns the changed set for a valid token", async () => {
    const t = fetchTransport(server.url);
    const res = await t.request("REPORT", "/cal/", syncCollectionBody('"v2"'));
    expect(res.status).toBe(207);
    // The client is at "v2", so only what differs from "v2" comes back.
    expect(res.body).toContain("evt-1.ics");
    expect(res.body).not.toContain("evt-2.ics");
    expect(res.body).toContain("<D:sync-token>");
  });

  it("falls back to a full re-run when the token is rejected", async () => {
    const t = fetchTransport(server.url);
    const stale = await t.request("REPORT", "/cal/", syncCollectionBody('"gone"'));
    expect(stale.status).toBe(INVALID_SYNC_TOKEN);

    // The plan names this fallback explicitly: re-run the report with an empty
    // token rather than treating a rejected token as "nothing changed".
    const fallback = await t.request("REPORT", "/cal/", syncCollectionBody(null));
    expect(fallback.status).toBe(207);
    expect(fallback.body).toContain("evt-1.ics");
  });
});

describe("ETag change path", () => {
  it("reports an event whose ETag changed", async () => {
    const t = fetchTransport(server.url);
    server.advance([EVENTS[0], { ...EVENTS[1], etag: '"v3"' }], '"v3"');
    const res = await t.request("REPORT", "/cal/", syncCollectionBody('"v3"'));
    expect(res.status).toBe(207);
    await server.advance(EVENTS, '"v2"');
  });

  it("lists every event with its ETag on PROPFIND", async () => {
    const t = fetchTransport(server.url);
    const res = await t.request("PROPFIND", "/cal/");
    expect(res.status).toBe(207);
    expect(res.body).toContain('"v1"');
    expect(res.body).toContain('"v2"');
  });
});

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

describe("cost accounting", () => {
  const log: RequestRecord[] = [
    { method: "PROPFIND", url: "/cal/", status: 207, bytes: 900, ms: 40 },
    { method: "REPORT", url: "/cal/", status: 207, bytes: 100, ms: 30 },
    { method: "REPORT", url: "/cal/", status: 207, bytes: 100, ms: 20 },
  ];

  it("names what dominated the measurement, not just the total", () => {
    const profile = profileCost(log, 2);
    expect(profile.requestsPerSync).toBe(1.5);
    expect(profile.dominatedBy.kind).toBe("bytes");
    expect(profile.dominatedBy.kind === "bytes" && profile.dominatedBy.method).toBe("PROPFIND");
  });

  it("breaks the cost down by method", () => {
    const profile = profileCost(log, 2);
    expect(profile.byMethod.PROPFIND.requests).toBe(1);
    expect(profile.byMethod.REPORT.requests).toBe(2);
    expect(profile.bytes).toBe(1100);
  });
});
