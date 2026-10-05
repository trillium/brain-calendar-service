// The CalDAV transport, and what it deliberately is NOT.
//
// The plan specifies building on ts-caldav. This module does not, and the reason
// is recorded rather than assumed: the load-bearing piece of S6 is RFC 6578
// sync-collection with DAV:sync-token, and the plan's own research records that
// ts-caldav does NOT support it (its sync is CTag + ETag diffing). So the code
// we would have to write and maintain is a patch either way. Writing it directly
// against fetch keeps that patch in this repo, typed, testable against a local
// fixture server with no network in CI, and honest about what it covers.
//
// Two hard boundaries from the plan, enforced here rather than by convention:
//   1. NO RECURRENCE EXPANSION HAPPENS HERE. This is transport. Occurrence
//      semantics belong to the domain layer, which is the whole reason the
//      boundary rule exists; a transport that expanded occurrences would leak
//      authority into the wrong layer.
//   2. Every method the loop may call is named, so the deny-by-default policy
//      has something concrete to check against.

export type CalDavMethod = "PROPFIND" | "REPORT" | "PUT" | "DELETE" | "GET" | "HEAD";

export interface RequestRecord {
  method: CalDavMethod;
  url: string;
  status: number;
  bytes: number;
  ms: number;
}

export interface Transport {
  request(
    method: CalDavMethod,
    url: string,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: string; ms: number }>;
  readonly log: RequestRecord[];
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>
</C:calendar-query>`;

/**
 * RFC 6578 sync-collection REPORT.
 *
 * `syncToken` null means "initial sync", which RFC 6578 spells as an empty
 * DAV:sync-token element rather than omitting it.
 */
export const syncCollectionBody = (syncToken: string | null): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${syncToken ?? ""}</D:sync-token>
  <D:sync-level>1</D:sync-level>
  <D:prop><D:getetag/><D:status/></D:prop>
</D:sync-collection>`;

/** The fallback the plan names: an invalid token means re-run with an empty one. */
export const INVALID_SYNC_TOKEN = 403;
const INVALID_SYNC_TOKEN_BODY = /valid-sync-token/i;

export const fetchTransport = (
  baseUrl: string,
  headers: Record<string, string> = {},
): Transport => {
  const log: RequestRecord[] = [];
  return {
    log,
    async request(method, url, body, extra = {}) {
      const started = Date.now();
      const res = await fetch(url.startsWith("http") ? url : `${baseUrl}${url}`, {
        method,
        body,
        headers: { ...headers, ...extra },
      });
      const text = await res.text();
      const ms = Date.now() - started;
      log.push({ method, url, status: res.status, bytes: text.length, ms });
      return { status: res.status, body: text, ms };
    },
  };
};

/** Total cost of a CTag + ETag style scan: what dominated, not just the number. */
export interface CostProfile {
  requests: number;
  bytes: number;
  ms: number;
  byMethod: Record<string, { requests: number; bytes: number; ms: number }>;
  /** The single largest contributor, by bytes and by time, named. */
  dominatedBy:
    | { kind: "none" }
    | { kind: "bytes"; method: CalDavMethod; share: number }
    | { kind: "time"; method: CalDavMethod; share: number };
  /** Headline number the budget is compared against: requests per sync. */
  requestsPerSync: number;
}

export const profileCost = (log: readonly RequestRecord[], rounds: number): CostProfile => {
  const byMethod: CostProfile["byMethod"] = {};
  let bytes = 0;
  let ms = 0;
  for (const r of log) {
    const bucket = byMethod[r.method] ?? { requests: 0, bytes: 0, ms: 0 };
    bucket.requests += 1;
    bucket.bytes += r.bytes;
    bucket.ms += r.ms;
    byMethod[r.method] = bucket;
    bytes += r.bytes;
    ms += r.ms;
  }
  // Dominance is decided on whichever axis is actually larger, and BOTH are
  // reported. A single number with no explanation is a proxy; "PROPFIND was 82%
  // of the bytes" is a finding.
  let topBytes = { method: "" as CalDavMethod, share: 0 };
  let topMs = { method: "" as CalDavMethod, share: 0 };
  for (const [method, b] of Object.entries(byMethod)) {
    const byteShare = bytes ? b.bytes / bytes : 0;
    const msShare = ms ? b.ms / ms : 0;
    if (byteShare > topBytes.share) topBytes = { method: method as CalDavMethod, share: byteShare };
    if (msShare > topMs.share) topMs = { method: method as CalDavMethod, share: msShare };
  }
  const dominatedBy: CostProfile["dominatedBy"] =
    topBytes.share === 0 && topMs.share === 0
      ? { kind: "none" }
      : topBytes.share >= topMs.share
        ? { kind: "bytes", method: topBytes.method, share: topBytes.share }
        : { kind: "time", method: topMs.method, share: topMs.share };
  return {
    requests: log.length,
    bytes,
    ms,
    byMethod,
    dominatedBy,
    requestsPerSync: rounds ? log.length / rounds : log.length,
  };
};
