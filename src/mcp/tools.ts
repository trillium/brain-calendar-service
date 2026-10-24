// The tool surface. Domain only - never adapters.
//
// The plan is explicit that the MCP layer must not be able to reach a provider:
// "tools over src/domain only (never over adapters - the MCP layer must not be
// able to reach a provider directly)". That is a structural boundary, not a
// convention, and the only imports below are from domain/. If a tool needed a
// calendar provider it would be a different service.
//
// Every input is validated with Zod at the boundary. Zod is load-bearing here
// rather than decorative: an unvalidated tool argument is an unauthenticated
// write into the authoritative store.

import { z } from "zod";
import { expand } from "../domain/recurrence/expand.js";
import { type PeriodRecord, type Store, StoreConflict } from "./store.js";

const isoSeconds = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** The end of a query window: one grain after its (UTC midnight) start. */
const windowEnd = (grain: "day" | "week" | "month", from: Date): string => {
  const end = new Date(from);
  if (grain === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + (grain === "week" ? 7 : 1));
  return isoSeconds(end.getTime());
};

// Bounds mirror the Dolt column widths (migrations/), so an over-long value is a
// typed validation refusal at the boundary rather than a driver error mid-write.
// A commitment's summary is stored in calendar_period.linked_bead_id.
const MAX_BEAD_ID = 64;
const MAX_CALENDAR_ID = 24;
const MAX_EXTERNAL_UID = 512;

const QueryPeriod = z.object({
  grain: z.enum(["day", "week", "month"]),
  startUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
  zone: z.string().min(1),
});

const ProposeDay = z.object({
  zone: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z
    .array(
      z.object({
        summary: z.string().min(1).max(MAX_BEAD_ID),
        startLocal: z.string(),
        minutes: z.number().int().positive(),
      }),
    )
    .min(1),
});

const MoveCommitment = z.object({
  beadId: z.string().min(1).max(MAX_BEAD_ID),
  newStartUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
});

const LinkExternal = z.object({
  beadId: z.string().min(1).max(MAX_BEAD_ID),
  calendarId: z.string().min(1).max(MAX_CALENDAR_ID),
  externalUid: z.string().min(1).max(MAX_EXTERNAL_UID),
});

const UnlinkExternal = z.object({
  beadId: z.string().min(1).max(MAX_BEAD_ID),
  calendarId: z.string().min(1).max(MAX_CALENDAR_ID),
});

export const queryPeriod = async (store: Store, raw: unknown) => {
  const input = QueryPeriod.parse(raw);
  const from = new Date(`${input.startUtc.slice(0, 10)}T00:00:00Z`);
  const periods = await store.periodsBetween(
    isoSeconds(from.getTime()),
    windowEnd(input.grain, from),
  );
  return { grain: input.grain, zone: input.zone, periods };
};

const proposeDay = async (store: Store, raw: unknown) => {
  const input = ProposeDay.parse(raw);
  const planned = input.items.map((item) => {
    const [first] = expand({
      uid: `proposed-${input.date}-${item.summary}`,
      dtstart: item.startLocal,
      zone: input.zone,
      durationSeconds: item.minutes * 60,
      rrule: "FREQ=DAILY;COUNT=1",
    });
    const startUtc = first?.recurrenceIdUtc ?? null;
    return { item, startUtc };
  });
  const periods: PeriodRecord[] = [];
  for (const { item, startUtc } of planned) {
    if (startUtc === null) continue;
    const start = Date.parse(startUtc);
    periods.push({
      grain: "day",
      startUtc: isoSeconds(start),
      endUtc: isoSeconds(start + item.minutes * 60_000),
      summary: item.summary,
    });
  }
  await store.addPeriods(periods);
  return {
    date: input.date,
    zone: input.zone,
    firstOccurrenceUtc: planned[0]?.startUtc ?? null,
    items: input.items.length,
  };
};

export const moveCommitment = async (store: Store, raw: unknown) => {
  const input = MoveCommitment.parse(raw);
  try {
    const moved = await store.movePeriod(input.beadId, input.newStartUtc);
    if (!moved) return { moved: false, reason: `no commitment named ${input.beadId}` };
    return { moved: true, beadId: input.beadId, startUtc: moved.startUtc };
  } catch (error) {
    if (error instanceof StoreConflict) return { moved: false, reason: error.message };
    throw error;
  }
};

const linkExternal = async (store: Store, raw: unknown) => {
  const input = LinkExternal.parse(raw);
  try {
    await store.link(input);
  } catch (error) {
    if (error instanceof StoreConflict) return { linked: false, reason: error.message, ...input };
    throw error;
  }
  return { linked: true, ...input };
};

const unlinkExternal = async (store: Store, raw: unknown) => {
  const input = UnlinkExternal.parse(raw);
  return { unlinked: await store.unlink(input.beadId, input.calendarId), ...input };
};

const ListChanges = z.object({ beadId: z.string().min(1).max(MAX_BEAD_ID).optional() });

const listChanges = async (store: Store, raw: unknown) => {
  const input = ListChanges.parse(raw);
  const periods = await store.listPeriods(input.beadId);
  return periods.map((p) => ({ beadId: p.summary, startUtc: p.startUtc, endUtc: p.endUtc }));
};

const listQuarantined = async (store: Store) => ({
  conflicts: await store.quarantined(),
  automaticResolution: false,
  note: "Quarantine has no exit path; resolving one is a human decision.",
});

const Nothing = z.object({});

export const TOOLS = [
  {
    name: "query_period",
    description: "Query a day, week or month of the plan.",
    schema: QueryPeriod,
    run: queryPeriod,
  },
  {
    name: "propose_day",
    description: "Propose a structured day.",
    schema: ProposeDay,
    run: proposeDay,
  },
  {
    name: "move_commitment",
    description: "Move or reschedule a commitment.",
    schema: MoveCommitment,
    run: moveCommitment,
  },
  {
    name: "link_external",
    description: "Link a durable record to an external event.",
    schema: LinkExternal,
    run: linkExternal,
  },
  {
    name: "unlink_external",
    description: "Remove a link to an external event.",
    schema: UnlinkExternal,
    run: unlinkExternal,
  },
  {
    name: "list_changes",
    description: "Report changes made through a planning interface.",
    schema: ListChanges,
    run: listChanges,
  },
  {
    name: "list_quarantined",
    description: "Surface quarantined conflicts.",
    schema: Nothing,
    run: listQuarantined,
  },
] as const;

/**
 * Registration form matters and the obvious choice is wrong. With
 * @modelcontextprotocol/sdk 1.32.1, verified with a real argument-bearing tool
 * call at both Zod 4.6.5 and Zod 3.25.76:
 *
 *   tool(name, description, zodRawShape, cb)  WORKS. Schema published, arguments
 *                                             validated, handler gets an object.
 *   tool(name, description, cb)               handler receives nothing.
 *   registerTool(name, {description, inputSchema: shape}, cb)
 *                                             schema silently published as
 *     {"type":"object","properties":{}} and the handler receives nothing.
 *
 * The registerTool form type-checks, reads like the documented modern API, and
 * accepts ZERO arguments. A handshake smoke test therefore passes while every
 * real tool call fails - the exact shape of "an exit code is not evidence".
 */
export const dispatch = async (store: Store, name: string, args: unknown): Promise<unknown> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool)
    throw new Error(
      `Unknown tool "${name}". The surface is fixed; this is a bug, not a user error.`,
    );
  return (tool.run as (s: Store, a: unknown) => Promise<unknown>)(store, args);
};
