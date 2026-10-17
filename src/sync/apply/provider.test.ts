// configuredProvider(): credentials by variable NAME, a reader that only reads,
// and a writer that is honestly absent. Every credential here is an invented
// placeholder and every request goes to an injected fetch.

import { describe, expect, it } from "vitest";
import { CredentialsError } from "../../adapters/caldav/auth.js";
import { configuredProvider } from "./provider.js";

const ENV = {
  CALENDAR_OAUTH_CLIENT_ID: "test-client-id-placeholder",
  CALENDAR_OAUTH_CLIENT_SECRET: "test-client-secret-placeholder",
  CALENDAR_OAUTH_REFRESH_TOKEN: "test-refresh-token-placeholder",
};

const WINDOW = { from: "2026-09-17T00:00:00Z", to: "2026-11-17T00:00:00Z" };

describe("configuredProvider", () => {
  it("is null when no credential variable is set at all", () => {
    expect(configuredProvider({ env: {} })).toBeNull();
    expect(configuredProvider({ env: { CALENDAR_OAUTH_CLIENT_ID: "" } })).toBeNull();
  });

  it("fails loudly, naming the variable, when only some are set", () => {
    const attempt = () =>
      configuredProvider({ env: { CALENDAR_OAUTH_CLIENT_ID: ENV.CALENDAR_OAUTH_CLIENT_ID } });
    expect(attempt).toThrow(CredentialsError);
    expect(attempt).toThrow(/CALENDAR_OAUTH_CLIENT_SECRET, CALENDAR_OAUTH_REFRESH_TOKEN/);
    expect(attempt).not.toThrow(/placeholder/);
  });

  it("has a reader and NO writer: the write path is not built", () => {
    const provider = configuredProvider({ env: ENV });
    expect(provider?.writer).toBeNull();
    expect(typeof provider?.reader.readWindow).toBe("function");
  });

  it("reads through a token refresh and reports only the calendar request it sent", async () => {
    const sent: { url: string; method: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, method: init?.method ?? "GET" });
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "test-access-placeholder", expires_in: 3600 });
      }
      return Response.json({
        items: [
          {
            id: "e1",
            start: { dateTime: "2026-10-01T09:00:00Z" },
            end: { dateTime: "2026-10-01T10:00:00Z" },
          },
        ],
      });
    }) as typeof fetch;
    const provider = configuredProvider({ env: ENV, fetch: fetchImpl, now: () => 0 });
    const read = await provider?.reader.readWindow("primary", WINDOW);
    expect(read?.occurrences).toHaveLength(1);
    // The token exchange is auth plumbing, not a calendar request, so it is not
    // among the observed provider calls (a POST there would read as a write).
    expect(read?.calls).toEqual([{ method: "GET", status: 200 }]);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET"]);
    expect(sent[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(
      sent[1].url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?"),
    ).toBe(true);
  });

  it("refuses a plain-http calendar base URL that is not loopback", () => {
    expect(() =>
      configuredProvider({
        env: { ...ENV, CALENDAR_GOOGLE_BASE_URL: "http://example.com/calendar/v3" },
      }),
    ).toThrow(/https/);
  });
});
