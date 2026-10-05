// A deterministic generator of occurrence pairs for the property tests.
//
// Deliberately NOT fast-check: the plan classifies that as a canon-extension
// request that has not been made yet, and an unapproved dependency is not a
// build decision. So the properties are exercised over a seeded, reproducible
// sweep instead - same coverage of the key space, no new dependency, and a
// fixed seed means a failure is always reproducible from the log alone.

import type { Occurrence } from "../types.js";

/** mulberry32: small, fast, and identical on every platform. */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const UIDS = ["uid-a@example.com", "uid-b@example.com", "uid-c@example.com"];
const RECURRENCE_IDS: (string | null)[] = [null, "2026-03-04T10:00:00Z", "2026-03-11T10:00:00Z"];
const DTSTAMPS: (string | null)[] = [
  null,
  "not-a-timestamp",
  "2026-03-01T10:00:00Z",
  "2026-03-05T10:00:00Z",
];
const SUMMARIES = ["Design review", "Standup", "Retro", "1:1"];

const make = (rand: () => number, source: "local" | "remote"): Occurrence => ({
  uid: UIDS[Math.floor(rand() * UIDS.length)],
  recurrenceId: RECURRENCE_IDS[Math.floor(rand() * RECURRENCE_IDS.length)],
  sequence: Math.floor(rand() * 4),
  dtstamp: DTSTAMPS[Math.floor(rand() * DTSTAMPS.length)],
  etag: rand() < 0.5 ? null : `etag-${Math.floor(rand() * 3)}`,
  source,
  payload: { summary: SUMMARIES[Math.floor(rand() * SUMMARIES.length)] },
});

/** `count` pairs drawn from a fixed seed. Same input, same pairs, every run. */
export const pairs = (seed: number, count: number): [Occurrence, Occurrence][] => {
  const rand = rng(seed);
  return Array.from({ length: count }, () => [make(rand, "local"), make(rand, "remote")]);
};
