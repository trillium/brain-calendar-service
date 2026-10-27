#!/usr/bin/env tsx
// calendar:register - map a provider's calendar id to the store's numeric calendar_id.
//
//   pnpm run calendar:register --remote-id <google calendar id> --name <label> [--provider google]
//
// Idempotent, and it never calls a provider: it writes one calendar_calendar row
// and commits it. `sync:once --calendar <remote id>` (or the printed numeric id)
// resolves through that row, and the live apply is allowed to write only there.

import { createConnection } from "mysql2/promise";
import { registerCalendar } from "../src/adapters/dolt/calendar-registry.ts";
import { config } from "../src/adapters/dolt/config.mjs";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const remoteCalendarId = value("remote-id");
const displayName = value("name");
if (remoteCalendarId === undefined || displayName === undefined) {
  console.error("usage: calendar:register --remote-id <id> --name <label> [--provider google]");
  process.exit(2);
}

const conn = await createConnection(config);
try {
  const calendar = await registerCalendar(conn, {
    provider: value("provider") ?? "google",
    remoteCalendarId,
    displayName,
  });
  console.log(JSON.stringify(calendar, null, 2));
} finally {
  await conn.end();
}
