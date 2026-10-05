// The RFC 5546 decision table, as data.
//
// Kept as data rather than as prose so it can be executed, counted, and written
// to evidence/stage-02/decision-table.md as a committed artifact (R4) instead of
// being printed once and forgotten. Every case names the keys that separated the
// two sides, so a reviewer can see WHY one won, not just that one won.

import { resolve } from "./resolve.js";
import type { Occurrence } from "./types.js";

const BASE: Omit<Occurrence, "source"> = {
  uid: "uid-a@example.com",
  recurrenceId: null,
  sequence: 0,
  dtstamp: "2026-03-01T10:00:00Z",
  etag: null,
  payload: { summary: "Design review" },
};

const occ = (
  over: Partial<Omit<Occurrence, "source">> & Pick<Occurrence, "source">,
): Occurrence => ({
  ...BASE,
  ...over,
  source: over.source,
});

interface DecisionCase {
  readonly name: string;
  readonly keys: string;
  readonly local: Occurrence;
  readonly remote: Occurrence;
}

export const CASES: readonly DecisionCase[] = [
  {
    name: "different UIDs are not a conflict at all",
    keys: "UID",
    local: occ({ source: "local", uid: "uid-a@example.com" }),
    remote: occ({ source: "remote", uid: "uid-b@example.com" }),
  },
  {
    name: "two different occurrences of one series are not a conflict",
    keys: "UID + RECURRENCE-ID",
    local: occ({ source: "local", recurrenceId: "2026-03-04T10:00:00Z" }),
    remote: occ({ source: "remote", recurrenceId: "2026-03-11T10:00:00Z" }),
  },
  {
    name: "an instance overlays its parent for one occurrence",
    keys: "UID + RECURRENCE-ID presence",
    local: occ({ source: "local" }),
    remote: occ({ source: "remote", recurrenceId: "2026-03-04T10:00:00Z", sequence: 9 }),
  },
  {
    name: "equal sequence, later DTSTAMP wins",
    keys: "SEQUENCE tie -> DTSTAMP",
    local: occ({ source: "local", dtstamp: "2026-03-02T10:00:00Z" }),
    remote: occ({ source: "remote", dtstamp: "2026-03-05T10:00:00Z" }),
  },
  {
    name: "higher remote sequence beats lower local DTSTAMP",
    keys: "SEQUENCE",
    local: occ({ source: "local", sequence: 1, dtstamp: "2026-03-09T10:00:00Z" }),
    remote: occ({ source: "remote", sequence: 2, dtstamp: "2026-03-02T10:00:00Z" }),
  },
  {
    name: "higher local sequence beats lower remote DTSTAMP",
    keys: "SEQUENCE",
    local: occ({ source: "local", sequence: 7 }),
    remote: occ({ source: "remote", sequence: 2, dtstamp: "2026-03-02T10:00:00Z" }),
  },
  {
    name: "a missing DTSTAMP sorts below a real one rather than throwing",
    keys: "SEQUENCE tie -> DTSTAMP absent",
    local: occ({ source: "local", dtstamp: null }),
    remote: occ({ source: "remote", dtstamp: "2026-03-02T10:00:00Z" }),
  },
  {
    name: "both DTSTAMPs missing falls through to a deterministic tie-break",
    keys: "SEQUENCE tie -> DTSTAMP tie",
    local: occ({ source: "local", dtstamp: null, payload: { summary: "A" } }),
    remote: occ({ source: "remote", dtstamp: null, payload: { summary: "B" } }),
  },
  {
    name: "identical payloads resolve without flapping",
    keys: "SEQUENCE tie -> DTSTAMP tie -> canonical identity",
    local: occ({ source: "local" }),
    remote: occ({ source: "remote" }),
  },
  {
    name: "a far-future sequence still wins: sequence outranks DTSTAMP",
    keys: "SEQUENCE",
    local: occ({ source: "local", sequence: 100, dtstamp: "2026-03-01T10:00:00Z" }),
    remote: occ({ source: "remote", sequence: 99, dtstamp: "2099-01-01T00:00:00Z" }),
  },
];

/** Every case, executed. Used by the test and by the artifact generator. */
export const runTable = () =>
  CASES.map((c) => {
    const result = resolve(c.local, c.remote);
    return {
      name: c.name,
      keys: c.keys,
      reason: result.reason,
      winner: result.winner ? result.winner.source : "none (both retained)",
      conflicted: result.conflicted,
    };
  });
