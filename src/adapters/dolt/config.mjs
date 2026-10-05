// Connection settings for the calendar service's own Dolt store.
//
// Per decision-4wh this is a SEPARATE store from Beads. Nothing here reads or
// writes the bd-owned schema; the only link between the two is an opaque
// bead_id string.
//
// The default target is a DISPOSABLE local Dolt server, not the fleet-shared one
// on 127.0.0.1:3307. S1's exit condition is "a real Dolt server, not a mock",
// and a disposable local server satisfies that exactly - same binary, same SQL,
// same history and diff semantics S4 depends on - without an autonomous worker
// creating databases on infrastructure every other lane shares. Pointing this at
// a shared server is a deliberate, human-gated step (plan 7.0 T8).

export const config = {
  host: process.env.CALENDAR_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.CALENDAR_DB_PORT ?? 3399),
  database: process.env.CALENDAR_DB_NAME ?? "brain_calendar_service",
  user: process.env.CALENDAR_DB_USER ?? "root",
  password: process.env.CALENDAR_DB_PASSWORD ?? "",
};

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, so scripts and the adapter agree on where `migrations/` lives. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
