#!/usr/bin/env node
// A stand-in for the gog CLI, used by tests so nothing touches a real account.
//
// It appends each invocation's argv (as one JSON line) to $FAKE_GOG_LOG and
// answers with canned JSON shaped like gog's calendar output. FAKE_GOG_FAIL
// makes every call exit 1 with gog's "no tokens" complaint.

import { appendFileSync } from "node:fs";
import { runStateful } from "./fake-gog-state.mjs";

const args = process.argv.slice(2);
if (process.env.FAKE_GOG_LOG) appendFileSync(process.env.FAKE_GOG_LOG, `${JSON.stringify(args)}\n`);

if (process.env.FAKE_GOG_FAIL) {
  process.stderr.write("no stored token for account\n");
  process.exit(1);
}

const COMMON = ["-a", "--json", "--no-input", "--readonly"];
const WRITE = [
  "summary",
  "description",
  "location",
  "from",
  "to",
  "all-day",
  "rrule",
  "private-prop",
  "send-updates",
];
const ALLOWED = {
  events: ["all-pages", "from", "to", "max", "private-prop-filter"],
  raw: [],
  create: [...WRITE, "timezone"],
  update: [...WRITE, "start-timezone", "end-timezone"],
  delete: ["force", "send-updates"],
};
const rest = args.slice(args.indexOf("calendar") + 1);
const words = rest.filter((a, i) => !a.startsWith("-") && rest[i - 1] !== "-a");
const [sub, ...positional] = words;
const event = (id, extra = {}) => ({
  id,
  status: "confirmed",
  summary: `event ${id}`,
  start: { dateTime: "2026-03-04T10:00:00Z" },
  end: { dateTime: "2026-03-04T11:00:00Z" },
  extendedProperties: { private: { "X-Beads-Id": `bead-${id}` } },
  ...extra,
});

for (const a of rest.filter((x) => x.startsWith("--") && !COMMON.includes(x))) {
  const name = a.slice(2).split("=")[0];
  if (sub in ALLOWED && !ALLOWED[sub].includes(name)) {
    process.stderr.write(`unknown flag --${name}\n`);
    process.exit(2);
  }
}

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (runStateful(sub, positional, args, out)) process.exit(0);

switch (sub) {
  case "events":
    out({ events: [event("e1"), event("e2")], nextPageToken: "" });
    break;
  case "raw":
    out(event(positional[1]));
    break;
  case "create":
    out({ event: event("created-1", { summary: flag("summary") }) });
    break;
  case "update":
    out({ event: event(positional[1], { summary: flag("summary") }) });
    break;
  case "delete":
    out({ deleted: true });
    break;
  case "garbled":
    process.stdout.write("not json\n");
    break;
  default:
    process.stderr.write(`fake-gog: unhandled ${sub}\n`);
    process.exit(2);
}
