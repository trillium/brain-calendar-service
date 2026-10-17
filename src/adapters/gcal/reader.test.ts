// The Google Calendar v3 reader, against canned responses. No network, no account:
// every token here is an invented placeholder and `fetch` is injected.

import { describe, expect, it } from "vitest";
import { MappingError } from "./map.js";
import { createGoogleReader, GoogleApiError, TooManyPagesError } from "./reader.js";

const WINDOW = { from: "2026-09-17T00:00:00Z", to: "2026-11-17T00:00:00Z" };

interface Seen {
  url: URL;
  init: RequestInit;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that replays `responses` in order and records what it was asked. */
const fakeFetch = (responses: Response[]) => {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  }) as typeof fetch;
  return { impl, seen };
};

const auth = () => {
  const forced: boolean[] = [];
  return {
    forced,
    source: {
      authorization: async (force = false) => {
        forced.push(force);
        return force ? "Bearer test-refreshed-placeholder" : "Bearer test-token-placeholder";
      },
    },
  };
};

const reader = (responses: Response[], over: { maxPages?: number } = {}) => {
  const f = fakeFetch(responses);
  const a = auth();
  return { ...f, ...a, reader: createGoogleReader({ auth: a.source, fetch: f.impl, ...over }) };
};

const timed = {
  id: "evt1",
  iCalUID: "evt1@google.com",
  etag: '"111"',
  status: "confirmed",
  summary: "Weekly Tuesday",
  sequence: 2,
  updated: "2026-09-01T12:00:00.000Z",
  recurringEventId: "series1",
  originalStartTime: { dateTime: "2026-09-22T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  start: { dateTime: "2026-09-22T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-09-22T11:30:00-07:00", timeZone: "America/Los_Angeles" },
  attendees: [{ responseStatus: "accepted" }, { responseStatus: "needsAction" }],
};

describe("mapping a Google event to an Occurrence", () => {
  it("maps an instance of a series, in UTC, keeping the series uid", async () => {
    const { reader: r } = reader([json(200, { items: [timed] })]);
    const { occurrences } = await r.readWindow("primary", WINDOW);
    expect(occurrences).toEqual([
      {
        uid: "evt1@google.com",
        recurrenceId: "2026-09-22T17:00:00.000Z",
        sequence: 2,
        dtstamp: "2026-09-01T12:00:00.000Z",
        etag: '"111"',
        source: "remote",
        payload: {
          id: "evt1",
          summary: "Weekly Tuesday",
          start: "2026-09-22T17:00:00.000Z",
          end: "2026-09-22T18:30:00.000Z",
          allDay: false,
          status: "confirmed",
          attendeeCount: 2,
        },
      },
    ]);
  });

  it("treats a plain event as the whole object: no recurrence id", async () => {
    const plain = { ...timed, recurringEventId: undefined, originalStartTime: undefined };
    const { occurrences } = await reader([json(200, { items: [plain] })]).reader.readWindow(
      "primary",
      WINDOW,
    );
    expect(occurrences[0].recurrenceId).toBeNull();
  });

  it("pins an all-day date to 00:00Z and says so", async () => {
    const allDay = { id: "d1", start: { date: "2026-10-01" }, end: { date: "2026-10-02" } };
    const { occurrences } = await reader([json(200, { items: [allDay] })]).reader.readWindow(
      "primary",
      WINDOW,
    );
    expect(occurrences[0].payload).toMatchObject({
      allDay: true,
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-10-02T00:00:00.000Z",
    });
    expect(occurrences[0].uid).toBe("d1");
    expect(occurrences[0].sequence).toBe(0);
  });

  it("keeps a cancelled item that arrives with no times, marked cancelled", async () => {
    const gone = { id: "g1", status: "cancelled" };
    const { occurrences } = await reader([json(200, { items: [gone] })]).reader.readWindow(
      "primary",
      WINDOW,
    );
    expect(occurrences[0].payload).toMatchObject({ status: "cancelled", start: null, end: null });
  });

  it("exposes how many attendees there are and nothing about who they are", async () => {
    const withEmail = {
      ...timed,
      attendees: [{ responseStatus: "accepted", email: "x@example.com" }],
    };
    const { occurrences } = await reader([json(200, { items: [withEmail] })]).reader.readWindow(
      "primary",
      WINDOW,
    );
    expect(JSON.stringify(occurrences)).not.toContain("example.com");
    expect(occurrences[0].payload.attendeeCount).toBe(1);
  });

  it("refuses an instance whose original start is missing instead of guessing", async () => {
    const broken = { ...timed, originalStartTime: undefined };
    await expect(
      reader([json(200, { items: [broken] })]).reader.readWindow("primary", WINDOW),
    ).rejects.toThrow(MappingError);
  });

  it("refuses a malformed payload by field, not by silently skipping the item", async () => {
    const bad = { id: "x", sequence: "two" };
    await expect(
      reader([json(200, { items: [bad] })]).reader.readWindow("primary", WINDOW),
    ).rejects.toThrow(/sequence/);
  });
});

describe("the request it makes", () => {
  it("is a GET with a bearer token and no body, asking for instances and cancellations", async () => {
    const { reader: r, seen } = reader([json(200, { items: [] })]);
    await r.readWindow("massage@example.com", WINDOW);
    expect(seen).toHaveLength(1);
    expect(seen[0].init.method).toBe("GET");
    expect(seen[0].init.body).toBeUndefined();
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token-placeholder",
    );
    expect(seen[0].url.pathname).toBe("/calendar/v3/calendars/massage%40example.com/events");
    const q = seen[0].url.searchParams;
    expect(q.get("singleEvents")).toBe("true");
    expect(q.get("showDeleted")).toBe("true");
    expect(q.get("timeMin")).toBe("2026-09-17T00:00:00.000Z");
    expect(q.get("timeMax")).toBe("2026-11-17T00:00:00.000Z");
  });

  it("never asks Google for attendee addresses or descriptions", async () => {
    const { reader: r, seen } = reader([json(200, { items: [] })]);
    await r.readWindow("primary", WINDOW);
    const fields = seen[0].url.searchParams.get("fields") ?? "";
    expect(fields).toContain("attendees(responseStatus)");
    expect(fields).not.toContain("email");
    expect(fields).not.toContain("description");
  });

  it("follows pages and reports every call it made", async () => {
    const { reader: r, seen } = reader([
      json(200, { items: [timed], nextPageToken: "p2" }),
      json(200, { items: [{ ...timed, id: "evt2", iCalUID: "evt2@google.com" }] }),
    ]);
    const result = await r.readWindow("primary", WINDOW);
    expect(result.occurrences.map((o) => o.uid)).toEqual(["evt1@google.com", "evt2@google.com"]);
    expect(seen[1].url.searchParams.get("pageToken")).toBe("p2");
    expect(result.calls).toEqual([
      { method: "GET", status: 200 },
      { method: "GET", status: 200 },
    ]);
  });

  it("refuses to return a partial read as whole when pages run out", async () => {
    const pages = [
      json(200, { items: [], nextPageToken: "a" }),
      json(200, { items: [], nextPageToken: "b" }),
    ];
    await expect(
      reader(pages, { maxPages: 2 }).reader.readWindow("primary", WINDOW),
    ).rejects.toThrow(TooManyPagesError);
  });

  it("retries once with a refreshed token on 401, and records both calls", async () => {
    const { reader: r, forced, seen } = reader([json(401, {}), json(200, { items: [] })]);
    const result = await r.readWindow("primary", WINDOW);
    expect(forced).toEqual([false, true]);
    expect((seen[1].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-refreshed-placeholder",
    );
    expect(result.calls.map((c) => c.status)).toEqual([401, 200]);
  });

  it("does not loop on a second 401", async () => {
    const { reader: r } = reader([json(401, {}), json(401, {})]);
    await expect(r.readWindow("primary", WINDOW)).rejects.toThrow(GoogleApiError);
  });
});

describe("failures name the status and reason and nothing else", () => {
  it("reports accessNotConfigured without echoing Google's message or the token", async () => {
    const body = {
      error: {
        code: 403,
        message: "leaky text mentioning project 123 and Bearer test-token-placeholder",
        errors: [{ reason: "accessNotConfigured", message: "also leaky" }],
      },
    };
    const err = await reader([json(403, body)])
      .reader.readWindow("primary", WINDOW)
      .catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.message).toBe(
      "Google Calendar API refused the read (HTTP 403, accessNotConfigured)",
    );
    expect(err.message).not.toContain("test-token-placeholder");
  });

  it("falls back to 'unknown' when the error body is not Google's shape", async () => {
    const res = new Response("<html>nope</html>", { status: 500 });
    const err = await reader([res])
      .reader.readWindow("primary", WINDOW)
      .catch((e) => e);
    expect(err.message).toBe("Google Calendar API refused the read (HTTP 500, unknown)");
  });
});

describe("guards on the inputs", () => {
  it("refuses a plain-http, non-loopback base URL", () => {
    expect(() =>
      createGoogleReader({ auth: auth().source, baseUrl: "http://calendar.example.com/v3" }),
    ).toThrow(/https/);
  });

  it("allows plain http on loopback so a fixture server can stand in", () => {
    expect(() =>
      createGoogleReader({ auth: auth().source, baseUrl: "http://127.0.0.1:9/calendar/v3" }),
    ).not.toThrow();
  });

  it("refuses an inverted or unparseable window before any request", async () => {
    const { reader: r, seen } = reader([]);
    await expect(r.readWindow("primary", { from: WINDOW.to, to: WINDOW.from })).rejects.toThrow(
      /before/,
    );
    await expect(r.readWindow("primary", { from: "soon", to: WINDOW.to })).rejects.toThrow(
      /window\.from/,
    );
    expect(seen).toHaveLength(0);
  });
});
