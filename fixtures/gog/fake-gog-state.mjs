// Stateful mode for fake-gog: a calendar that remembers what was written to it.
//
// Off unless FAKE_GOG_STATE names a JSON file, so every existing test keeps the
// canned answers. With it set, `create` stores an event (with its private
// properties), `update` edits it, `delete` removes it, `events` and `raw` read it
// back (`events` honoring --from/--to and --private-prop-filter), and each
// calendar id is its own namespace - so a test can prove a write
// never reached a calendar it was not allowed to touch.
//
// FAKE_GOG_FAIL_NTH=<sub>:<n> makes the n-th call to that subcommand (counted
// across processes, in the same file) exit 1, to exercise a mid-round failure.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const load = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { next: 1, calls: {}, calendars: {} };

const flagValues = (args, name) =>
  args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const applyFlags = (event, args) => {
  const [summary] = flagValues(args, "summary");
  const [from] = flagValues(args, "from");
  const [to] = flagValues(args, "to");
  if (summary !== undefined) event.summary = summary;
  if (from !== undefined) event.start = { dateTime: from };
  if (to !== undefined) event.end = { dateTime: to };
  for (const prop of flagValues(args, "private-prop")) {
    const eq = prop.indexOf("=");
    event.extendedProperties.private[prop.slice(0, eq)] = prop.slice(eq + 1);
  }
  event.updated = "2026-03-04T12:00:00.000Z";
  event.rev = (event.rev ?? 0) + 1;
  event.etag = `"etag-${event.id}-${event.rev}"`;
};

/** Honors --from/--to (overlap, as Google does) and --private-prop-filter=key=value. */
const listed = (event, args) => {
  const [from] = flagValues(args, "from");
  const [to] = flagValues(args, "to");
  const [filter] = flagValues(args, "private-prop-filter");
  if (from !== undefined && Date.parse(event.end?.dateTime) <= Date.parse(from)) return false;
  if (to !== undefined && Date.parse(event.start?.dateTime) >= Date.parse(to)) return false;
  if (filter === undefined) return true;
  const eq = filter.indexOf("=");
  return event.extendedProperties.private[filter.slice(0, eq)] === filter.slice(eq + 1);
};

const shouldFail = (state, sub) => {
  const [name, nth] = (process.env.FAKE_GOG_FAIL_NTH ?? ":").split(":");
  return name === sub && Number(nth) === state.calls[sub];
};

/** Returns the JSON to print, or throws a string to print on stderr and exit 1. */
const handle = (state, sub, positional, args) => {
  const [calendarId, eventId] = positional;
  state.calendars[calendarId] ??= {};
  const events = state.calendars[calendarId];
  switch (sub) {
    case "events":
      return { events: Object.values(events).filter((e) => listed(e, args)), nextPageToken: "" };
    case "raw":
    case "update":
    case "delete": {
      const event = events[eventId];
      if (event === undefined) throw `event ${eventId} not found on ${calendarId}`;
      if (sub === "delete") delete events[eventId];
      if (sub === "update") applyFlags(event, args);
      return sub === "delete" ? { deleted: true } : sub === "raw" ? event : { event };
    }
    case "create": {
      const id = `fake-${state.next++}`;
      const event = { id, status: "confirmed", extendedProperties: { private: {} } };
      applyFlags(event, args);
      events[id] = event;
      return { event };
    }
    default:
      return undefined;
  }
};

/** True when the call was handled here. */
export const runStateful = (sub, positional, args, out) => {
  const path = process.env.FAKE_GOG_STATE;
  if (!path || !["events", "raw", "create", "update", "delete"].includes(sub)) return false;
  const state = load(path);
  state.calls[sub] = (state.calls[sub] ?? 0) + 1;
  try {
    if (shouldFail(state, sub)) throw `injected failure on ${sub} #${state.calls[sub]}`;
    out(handle(state, sub, positional, args));
  } catch (message) {
    writeFileSync(path, JSON.stringify(state));
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
  writeFileSync(path, JSON.stringify(state));
  return true;
};
