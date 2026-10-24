// CalendarProvider backed by the gog CLI (calendar list/get/create/update/delete).
//
// gog already owns Google authentication, so there is no CalDAV transport and
// no Google API client in this repo. The account is configuration, never a
// literal: pass it in, or set GOG_ACCOUNT.
//
// Output is read with --json and validated at the boundary. Because gog's
// envelope can wrap results ({events: [...]}, {event: {...}}), the unwrapping is
// tolerant of both the wrapped and the bare form, and strict about the event.

import { z } from "zod";
import {
  assertPermitted,
  authoriseDelete,
  type OwnershipToken,
  type SyncPolicy,
} from "../../sync/loop/policy.js";
import type { CalendarProvider, EventDraft, ListWindow, ProviderEvent } from "../provider.js";
import { assertWithinGoogleLimits } from "./google-limits.js";
import { execRunner, GogError, type GogRunner } from "./runner.js";

const timeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

const eventSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: timeSchema.optional(),
  end: timeSchema.optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  etag: z.string().optional(),
  updated: z.string().optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});

const toEvent = (raw: z.infer<typeof eventSchema>): ProviderEvent => {
  const { extendedProperties, ...rest } = raw;
  return { ...rest, privateProperties: extendedProperties?.private ?? {} };
};

const unwrap = (value: unknown, key: string): unknown => {
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return value;
};

const parseJson = (stdout: string, what: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GogError(`gog ${what}: stdout was not JSON`, null, stdout.slice(0, 200));
  }
};

const parseEvent = (stdout: string, what: string): ProviderEvent =>
  toEvent(eventSchema.parse(unwrap(parseJson(stdout, what), "event")));

const parseEvents = (stdout: string): readonly ProviderEvent[] =>
  z
    .array(eventSchema)
    .parse(unwrap(parseJson(stdout, "events"), "events"))
    .map(toEvent);

interface GogProviderOptions {
  /** The Google account gog acts as. Required; there is deliberately no default. */
  readonly account: string;
  readonly runner?: GogRunner;
  /** Path to gog; defaults to GOG_BIN, then "gog" on PATH. */
  readonly bin?: string;
  /** Block mutating requests inside gog itself, as a second line of defence. */
  readonly readonly?: boolean;
}

// `gog calendar create` takes --timezone; `update` only has the per-end flags.
const writeFlags = (draft: EventDraft, mode: "create" | "update"): string[] => {
  const out: string[] = [];
  const add = (flag: string, value: string | undefined) => {
    if (value !== undefined) out.push(`--${flag}=${value}`);
  };
  add("summary", draft.summary);
  add("description", draft.description);
  add("location", draft.location);
  add("from", draft.from);
  add("to", draft.to);
  if (mode === "create") {
    add("timezone", draft.timeZone);
  } else {
    add("start-timezone", draft.timeZone);
    add("end-timezone", draft.timeZone);
  }
  if (draft.allDay === true) out.push("--all-day");
  for (const rule of draft.rrule ?? []) out.push(`--rrule=${rule}`);
  for (const [k, v] of Object.entries(draft.privateProperties ?? {})) {
    out.push(`--private-prop=${k}=${v}`);
  }
  return out;
};

export const createGogProvider = (options: GogProviderOptions): CalendarProvider => {
  if (options.account.trim() === "") {
    throw new Error("gog provider needs an account address (option or GOG_ACCOUNT)");
  }
  const run = options.runner ?? execRunner(options.bin ?? process.env.GOG_BIN ?? "gog");
  const base = (): string[] => [
    "calendar",
    "-a",
    options.account,
    "--json",
    "--no-input",
    ...(options.readonly === true ? ["--readonly"] : []),
  ];
  const call = async (sub: string, flags: readonly string[], positional: readonly string[]) => {
    // An id starting with a dash would be parsed by gog as a flag.
    for (const id of positional) {
      if (id === "" || id.startsWith("-"))
        throw new Error(`refusing unsafe calendar/event id "${id}"`);
    }
    const { stdout } = await run([...base(), sub, ...flags, ...positional]);
    return stdout;
  };

  return {
    name: "gog",
    async listEvents(calendarId, window: ListWindow = {}) {
      const flags = [
        "--all-pages",
        ...(window.from !== undefined ? [`--from=${window.from}`] : []),
        ...(window.to !== undefined ? [`--to=${window.to}`] : []),
        ...(window.max !== undefined ? [`--max=${window.max}`] : []),
      ];
      return parseEvents(await call("events", flags, [calendarId]));
    },
    // `raw` is gog's lossless Events.Get dump, so extended properties survive.
    async getEvent(calendarId, eventId) {
      return parseEvent(await call("raw", [], [calendarId, eventId]), "raw");
    },
    async createEvent(policy: SyncPolicy, calendarId, draft) {
      assertPermitted(policy, calendarId, "INSERT");
      assertWithinGoogleLimits(draft.privateProperties ?? {});
      return parseEvent(
        await call("create", [...writeFlags(draft, "create"), "--send-updates=none"], [calendarId]),
        "create",
      );
    },
    async updateEvent(policy: SyncPolicy, calendarId, eventId, draft) {
      assertPermitted(policy, calendarId, "UPDATE");
      assertWithinGoogleLimits(draft.privateProperties ?? {});
      return parseEvent(
        await call(
          "update",
          [...writeFlags(draft, "update"), "--send-updates=none"],
          [calendarId, eventId],
        ),
        "update",
      );
    },
    async deleteEvent(policy: SyncPolicy, ownership: OwnershipToken | null, calendarId, eventId) {
      authoriseDelete(policy, ownership, calendarId, eventId);
      await call("delete", ["--force", "--send-updates=none"], [calendarId, eventId]);
    },
  };
};

/** Build the provider from the environment: GOG_ACCOUNT is the account address. */
export const gogProviderFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<GogProviderOptions> = {},
): CalendarProvider => {
  const account = overrides.account ?? env.GOG_ACCOUNT ?? "";
  return createGogProvider({ ...overrides, account });
};
