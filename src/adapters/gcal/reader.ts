// Google Calendar API v3, READ ONLY.
//
// Why v3 and not CalDAV: the real-calendar soak found Google's CalDAV API is not
// enabled for the OAuth client's project (403 accessNotConfigured), while the
// same token reads v3 fine. v3 is also Google's own surface, so recurring
// instances, cancelled items and etags arrive as JSON instead of being parsed
// back out of ICS.
//
// Read-only is structural here, not a promise: the only request this module can
// build is a GET (see `get`), and there is no write function to call. The write
// path is a separate task with its own approval.
//
// Nothing secret is ever printed. A failure names the HTTP status and Google's
// machine-readable reason, never the response body and never a header.

import { z } from "zod";
import type { Occurrence } from "../../domain/rfc5546/types.js";
import type { AuthorizationSource } from "../caldav/auth.js";
import { EventsPage, toOccurrence } from "./map.js";

const DEFAULT_BASE = "https://www.googleapis.com/calendar/v3";
/** Ask Google for no more than the mapping uses: no attendee addresses, no description. */
const FIELDS =
  "nextPageToken,items(id,iCalUID,etag,status,summary,sequence,updated," +
  "recurringEventId,originalStartTime,start,end,attendees(responseStatus))";
const PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 40;

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Google Calendar API refused the read (HTTP ${status}, ${reason})`);
    this.name = "GoogleApiError";
  }
}

export class TooManyPagesError extends Error {
  constructor(maxPages: number) {
    super(
      `window has more than ${maxPages} pages of events; refusing to return a partial read as if it were whole`,
    );
    this.name = "TooManyPagesError";
  }
}

const ErrorBody = z.object({
  error: z.object({ errors: z.array(z.object({ reason: z.string() })).min(1) }),
});

interface ReadWindow {
  /** ISO instant, inclusive. */
  readonly from: string;
  /** ISO instant, exclusive. */
  readonly to: string;
}

/** One calendar request as observed. Method and status only: a URL carries the calendar id. */
interface ObservedCall {
  readonly method: "GET";
  readonly status: number;
}

interface GoogleRead {
  /** Every item in the window, cancelled ones included (payload.status says which). */
  readonly occurrences: readonly Occurrence[];
  readonly calls: readonly ObservedCall[];
}

interface ReaderDeps {
  readonly auth: AuthorizationSource;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly maxPages?: number;
}

const assertSafeBase = (raw: string): void => {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Calendar API base URL must be https (http only on loopback)");
  }
};

const instant = (name: string, raw: string): string => {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`read window.${name} is not an ISO instant: "${raw}"`);
  return new Date(ms).toISOString();
};

const failureOf = async (res: Response): Promise<GoogleApiError> => {
  const parsed = ErrorBody.safeParse(await res.json().catch(() => null));
  return new GoogleApiError(
    res.status,
    parsed.success ? parsed.data.error.errors[0].reason : "unknown",
  );
};

export const createGoogleReader = (deps: ReaderDeps) => {
  const base = deps.baseUrl ?? DEFAULT_BASE;
  assertSafeBase(base);
  const doFetch = deps.fetch ?? fetch;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

  /** The only request builder in this module, and it can only GET. */
  const get = async (url: string, forceRefresh: boolean): Promise<Response> =>
    doFetch(url, {
      method: "GET",
      headers: { Authorization: await deps.auth.authorization(forceRefresh) },
    });

  return {
    async readWindow(calendarId: string, window: ReadWindow): Promise<GoogleRead> {
      const timeMin = instant("from", window.from);
      const timeMax = instant("to", window.to);
      if (Date.parse(timeMin) >= Date.parse(timeMax)) {
        throw new Error("read window.from must be before window.to");
      }
      const calls: ObservedCall[] = [];
      const occurrences: Occurrence[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const query = new URLSearchParams({
          timeMin,
          timeMax,
          singleEvents: "true",
          showDeleted: "true",
          maxResults: String(PAGE_SIZE),
          fields: FIELDS,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        const url = `${base}/calendars/${encodeURIComponent(calendarId)}/events?${query}`;
        let res = await get(url, false);
        calls.push({ method: "GET", status: res.status });
        // 401 is rejected before processing, so one retry with a fresh token is safe.
        if (res.status === 401) {
          res = await get(url, true);
          calls.push({ method: "GET", status: res.status });
        }
        if (!res.ok) throw await failureOf(res);
        const body = EventsPage.parse(await res.json());
        for (const item of body.items) occurrences.push(toOccurrence(item));
        pageToken = body.nextPageToken;
        if (pageToken === undefined) return { occurrences, calls };
      }
      throw new TooManyPagesError(maxPages);
    },
  };
};
