// One sync cycle for one calendar: plan, then apply, then advance the cursor.
//
// The plan is produced before anything is written, and the dry-run's whole
// purpose is to be believable. A dry-run that asserts its own safety by its own
// flag name is rung 4 - this codebase carries a hand-maintained transport, which
// is exactly where a write leaks - so the plan carries OBSERVATIONS, not
// promises:
//
//   rowDeltas      per affected table, before and after
//   table hashes   the working-set hash of each observed table, before and after,
//                  so an UPDATE or an uncommitted write shows even when counts match
//   providerCalls  every method the transport was asked to make
//   dolt head      the Dolt branch head before and after
//
// `sync:verify-plan` then checks the plan was well-formed AND that none of those
// observations show an execution.
//
// Quarantine has no exit path. `calendar_conflict` is the only sink and nothing
// in this module promotes a row out of it; resolving one is a human decision.

import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { detectChanges, headCommit } from "../changedetection/plan.js";
import { allow, assertPermitted, type SyncPolicy } from "../loop/policy.js";
import { planPulls } from "./plan-pull.js";
import {
  type BindingRefresh,
  type ForeignEvent,
  NO_OBSERVATION,
  type PlanPull,
  type PullObservation,
  type Quarantine,
  type Skipped,
} from "./pull-types.js";

export interface PlanPush {
  beadId: string;
  externalUid: string;
  reason: string;
}

interface Observations {
  rowDeltas: Record<string, number>;
  tableHashesBefore: Record<string, string>;
  tableHashesAfter: Record<string, string>;
  providerCalls: { method: string }[];
  doltHeadBefore: string | null;
  doltHeadAfter: string | null;
}

export interface SyncPlan {
  calendarId: string;
  dryRun: boolean;
  cursorBefore: string | null;
  cursorAfter: string | null;
  push: PlanPush[];
  pull: PlanPull[];
  /** In-sync bindings whose provider etag moved; apply records the new one. */
  refresh: readonly BindingRefresh[];
  quarantined: Quarantine[];
  conflictsQuarantined: number;
  /** Edits made on both sides at once; each is also in `quarantined`. */
  conflicts: number;
  /** Provider events that are not ours: reported, never imported. */
  foreign: readonly ForeignEvent[];
  /** Remote edits that could not be pulled; the round that carries one is incomplete. */
  pullSkipped: readonly Skipped[];
  observations: Observations;
}

/** The cursor row is keyed by the database whose history it indexes. */
export const SOURCE_DATABASE = "brain_calendar_service";

const TEMPORAL_TABLES = ["calendar_period", "calendar_binding"] as const;
const OBSERVED_TABLES = [...TEMPORAL_TABLES, "calendar_sync_cursor"] as const;

const tableCount = async (conn: Connection, table: string): Promise<number> => {
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n);
};

const tableCounts = async (conn: Connection): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const table of TEMPORAL_TABLES) counts[table] = await tableCount(conn, table);
  return counts;
};

const tableHashes = async (conn: Connection): Promise<Record<string, string>> => {
  const hashes: Record<string, string> = {};
  for (const table of OBSERVED_TABLES) {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT DOLT_HASHOF_TABLE(?) AS h", [table]);
    hashes[table] = String(rows[0].h);
  }
  return hashes;
};

interface CycleInput {
  readonly conn: Connection;
  readonly calendarId: string;
  readonly provider: string;
  /** What the provider holds, from `observePull`. Absent means the pull half was not run. */
  readonly pull?: PullObservation;
  /** True (the default) for a plan that will not be applied. */
  readonly dryRun?: boolean;
  /** Read once the plan is built, so it reports the calls actually made. */
  readonly providerCalls: () =>
    | Promise<readonly { method: string }[]>
    | readonly { method: string }[];
}

/** Build the plan. Writes nothing, including in dry-run. */
export const buildSyncPlan = async (input: CycleInput): Promise<SyncPlan> => {
  const countsBefore = await tableCounts(input.conn);
  const tableHashesBefore = await tableHashes(input.conn);
  const doltHeadBefore = await headCommit(input.conn);
  const policy: SyncPolicy = allow(input.provider, [
    [input.calendarId, "INSERT"],
    [input.calendarId, "UPDATE"],
  ]);

  const [cursorRows] = await input.conn.query<RowDataPacket[]>(
    "SELECT last_synced_commit_hash FROM calendar_sync_cursor WHERE source_database = ? AND calendar_id = ?",
    [SOURCE_DATABASE, input.calendarId],
  );
  const cursorBefore = (cursorRows[0]?.last_synced_commit_hash as string | null) ?? null;

  const observed = input.pull ?? NO_OBSERVATION;
  const pulled = planPulls(observed.changes);
  if (pulled.pull.length > 0) assertPermitted(policy, input.calendarId, "UPDATE");
  const pulledIds = new Set(pulled.pull.map((p) => p.beadId));
  const push: PlanPush[] = [];
  const quarantined: Quarantine[] = [];

  for (const table of TEMPORAL_TABLES) {
    const detection = await detectChanges(input.conn, table, cursorBefore);
    if (detection.state === "full_resync_required") {
      // Not a failure and not a silent empty diff: the honest action is a full
      // resync, and saying so is the point.
      quarantined.push({ beadId: null, externalUid: null, reason: detection.reason });
      continue;
    }
    for (const id of detection.changedIds) {
      const beadId = `row:${table}:${id}`;
      // The provider already holds what Dolt holds (a pulled edit shows up in the
      // diff until the cursor passes it), or is about to be pulled from: pushing
      // it back would be an echo.
      if (observed.inSync.has(beadId) || pulledIds.has(beadId)) continue;
      assertPermitted(policy, input.calendarId, "INSERT");
      push.push({ beadId, externalUid: "", reason: "temporal change detected" });
    }
  }

  quarantined.push(...pulled.quarantined);

  const providerCalls = [...(await input.providerCalls())];
  const countsAfter = await tableCounts(input.conn);
  const tableHashesAfter = await tableHashes(input.conn);
  const rowDeltas: Record<string, number> = {};
  for (const table of TEMPORAL_TABLES) {
    rowDeltas[table] = countsAfter[table] - countsBefore[table];
  }

  return {
    calendarId: input.calendarId,
    dryRun: input.dryRun ?? true,
    cursorBefore,
    cursorAfter: cursorBefore,
    push,
    pull: pulled.pull,
    refresh: observed.refresh,
    quarantined,
    conflictsQuarantined: quarantined.length,
    conflicts: pulled.quarantined.length,
    foreign: observed.foreign,
    pullSkipped: observed.skipped,
    observations: {
      rowDeltas,
      tableHashesBefore,
      tableHashesAfter,
      providerCalls,
      doltHeadBefore,
      doltHeadAfter: await headCommit(input.conn),
    },
  };
};
