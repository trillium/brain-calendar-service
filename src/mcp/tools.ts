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

export interface PeriodRecord {
  grain: string;
  startUtc: string;
  endUtc: string;
  summary: string;
}

export interface ConflictRecord {
  beadId: string | null;
  externalUid: string | null;
  reason: string;
}

/**
 * What the tools read and write. Declared here, in the domain-facing layer, so
 * the tools never name a database: entry.ts decides which implementation backs
 * it (a Dolt store when a database is configured, the in-process one otherwise).
 */
export interface Store {
  /** Periods whose UTC start falls on the given YYYY-MM-DD date. */
  periodsOnDate(date: string): Promise<PeriodRecord[]>;
  allPeriods(): Promise<PeriodRecord[]>;
  addPeriods(periods: PeriodRecord[]): Promise<void>;
  /** Moves the commitment named `summary`; false when none exists. */
  moveStart(summary: string, startUtc: string): Promise<boolean>;
  unresolvedConflicts(): Promise<ConflictRecord[]>;
}

/** The in-process store: used only when no database is configured. */
interface MemoryStore extends Store {
  periods: PeriodRecord[];
  conflicts: ConflictRecord[];
}

export const newStore = (): MemoryStore => {
  const store: MemoryStore = {
    periods: [],
    conflicts: [],
    periodsOnDate: async (date) => store.periods.filter((p) => p.startUtc.startsWith(date)),
    allPeriods: async () => [...store.periods],
    addPeriods: async (periods) => {
      store.periods.push(...periods);
    },
    moveStart: async (summary, startUtc) => {
      const target = store.periods.find((p) => p.summary === summary);
      if (target) target.startUtc = startUtc;
      return target !== undefined;
    },
    unresolvedConflicts: async () => [...store.conflicts],
  };
  return store;
};

/** Whole-second UTC, the shape every tool argument and result uses. */
const wireUtc = (epochMs: number) => `${new Date(epochMs).toISOString().slice(0, 19)}Z`;

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
        summary: z.string().min(1).max(64),
        startLocal: z.string(),
        minutes: z.number().int().positive(),
      }),
    )
    .min(1),
});

const MoveCommitment = z.object({
  beadId: z.string().min(1),
  newStartUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
});

const LinkExternal = z.object({
  beadId: z.string().min(1),
  calendarId: z.string().min(1),
  externalUid: z.string().min(1),
});

const UnlinkExternal = z.object({
  beadId: z.string().min(1),
  calendarId: z.string().min(1),
});

export const queryPeriod = async (store: Store, raw: unknown) => {
  const input = QueryPeriod.parse(raw);
  const found = await store.periodsOnDate(input.startUtc.slice(0, 10));
  return { grain: input.grain, zone: input.zone, periods: found };
};

const proposeDay = async (store: Store, raw: unknown) => {
  const input = ProposeDay.parse(raw);
  const written: PeriodRecord[] = input.items.map((item) => {
    const [first] = expand({
      uid: `proposed-${input.date}-${item.summary}`,
      dtstart: item.startLocal,
      zone: input.zone,
      durationSeconds: item.minutes * 60,
      rrule: "FREQ=DAILY;COUNT=1",
    });
    if (!first) throw new Error(`could not resolve "${item.startLocal}" in ${input.zone}`);
    const startMs = Date.parse(first.recurrenceIdUtc);
    return {
      grain: "day",
      startUtc: wireUtc(startMs),
      endUtc: wireUtc(startMs + item.minutes * 60_000),
      summary: item.summary,
    };
  });
  await store.addPeriods(written);
  return {
    date: input.date,
    zone: input.zone,
    firstOccurrenceUtc: written[0]?.startUtc ?? null,
    items: written.length,
  };
};

export const moveCommitment = async (store: Store, raw: unknown) => {
  const input = MoveCommitment.parse(raw);
  const moved = await store.moveStart(input.beadId, input.newStartUtc);
  if (!moved) return { moved: false, reason: `no commitment named ${input.beadId}` };
  return { moved: true, beadId: input.beadId, startUtc: input.newStartUtc };
};

const linkExternal = async (_store: Store, raw: unknown) => {
  const input = LinkExternal.parse(raw);
  return { linked: true, ...input };
};

const unlinkExternal = async (_store: Store, raw: unknown) => {
  const input = UnlinkExternal.parse(raw);
  return { unlinked: true, ...input };
};

const ListChanges = z.object({ beadId: z.string().min(1).optional() });

const listChanges = async (store: Store, raw: unknown) => {
  const input = ListChanges.parse(raw);
  return (await store.allPeriods())
    .filter((p) => input.beadId === undefined || p.summary === input.beadId)
    .map((p) => ({ beadId: p.summary, startUtc: p.startUtc, endUtc: p.endUtc }));
};

const listQuarantined = async (store: Store) => ({
  conflicts: await store.unresolvedConflicts(),
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
