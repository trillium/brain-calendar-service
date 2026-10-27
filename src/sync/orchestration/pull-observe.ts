// The pull half's read side: list the registered calendar, and sort what comes
// back into the only four things it can be. This reads and writes nothing, so a
// dry-run may call it.
//
//   in sync    a bound event whose times already match Dolt: nothing to do, and a
//              push for the same period would be a no-op
//   unchanged  a bound event whose etag is the one we recorded when we last wrote
//              it: the provider handing our own write back (self-echo). Dropped.
//   edited     a bound event whose times differ and whose etag moved: somebody
//              edited it remotely. THIS is the only thing that becomes a pull
//   foreign    an event with no binding and no bcs-key marker, or a binding with
//              no ownership token: not ours. Reported, never imported
//
// "Ours" is decided by identity, not by content: the binding (written when we
// created or adopted the event) and the marker we put on it. Content only
// separates an echo from an edit once the event is known to be ours.

import type { Connection } from "mysql2/promise";
import type { CalendarProvider, ProviderEvent } from "../../adapters/provider.js";
import { FULL_WINDOW, MARKER_KEY, periodBeadId, periodIdOf } from "./apply-draft.js";
import { viaProvider, viaStore } from "./apply-steps.js";
import { loadPeriod } from "./apply-store.js";
import { loadBindings, type PullBinding } from "./pull-store.js";
import type { ForeignEvent, PullObservation, RemoteChange, Skipped, Times } from "./pull-types.js";

interface Input {
  readonly conn: Connection;
  readonly provider: CalendarProvider;
  readonly calendar: { readonly id: number; readonly remoteCalendarId: string };
}

interface Sink {
  changes: RemoteChange[];
  foreign: ForeignEvent[];
  skipped: Skipped[];
  inSync: Set<string>;
}

/** A UTC instant to the second, or null for an all-day or malformed time. */
const instant = (time: ProviderEvent["start"]): string | null => {
  const parsed = time?.dateTime === undefined ? Number.NaN : Date.parse(time.dateTime);
  return Number.isNaN(parsed) ? null : `${new Date(parsed).toISOString().slice(0, 19)}Z`;
};

const remoteTimes = (event: ProviderEvent): Times | null => {
  const startUtc = instant(event.start);
  const endUtc = instant(event.end);
  return startUtc === null || endUtc === null ? null : { startUtc, endUtc };
};

const isMarked = async (input: Input, event: ProviderEvent): Promise<boolean> => {
  // A listing may omit extended properties, so an event that shows none is read
  // back through the lossless getEvent before it is called foreign.
  const props =
    Object.keys(event.privateProperties).length > 0
      ? event.privateProperties
      : (
          await viaProvider(() =>
            input.provider.getEvent(input.calendar.remoteCalendarId, event.id),
          )
        ).privateProperties;
  return props[MARKER_KEY] !== undefined;
};

const classifyUnbound = async (input: Input, event: ProviderEvent, out: Sink): Promise<void> => {
  // Marked but unbound is the crash window between a create and its binding. The
  // push half adopts it by marker; pulling it here would race that.
  if (await isMarked(input, event)) return;
  out.foreign.push({
    externalUid: event.id,
    summary: event.summary ?? null,
    reason: `no ${MARKER_KEY} marker and no binding: not created by this service; not imported`,
  });
};

const classifyBound = async (
  input: Input,
  event: ProviderEvent,
  binding: PullBinding,
  out: Sink,
): Promise<void> => {
  const periodId = periodIdOf(binding.beadId);
  if (periodId === null) {
    out.skipped.push({ beadId: binding.beadId, reason: "not a calendar_period row" });
    return;
  }
  const period = await viaStore(() => loadPeriod(input.conn, periodId));
  if (period === null) {
    out.skipped.push({
      beadId: binding.beadId,
      reason: "period no longer exists; deletes are not applied",
    });
    return;
  }
  const times = remoteTimes(event);
  if (times?.startUtc === period.startUtc && times.endUtc === period.endUtc) {
    out.inSync.add(periodBeadId(periodId));
    return;
  }
  if (event.etag !== undefined && event.etag === binding.etag) return;
  if (times === null) {
    out.skipped.push({
      beadId: binding.beadId,
      reason: "remote event has no dateTime start and end (all-day?); cannot be mapped to a period",
    });
    return;
  }
  out.changes.push({
    beadId: periodBeadId(periodId),
    periodId,
    externalUid: event.id,
    sequence: binding.sequence,
    local: {
      startUtc: period.startUtc,
      endUtc: period.endUtc,
      summary: period.summary,
      updatedUtc: period.updatedUtc,
    },
    remote: {
      ...times,
      summary: event.summary ?? "",
      etag: event.etag ?? null,
      updated: event.updated ?? null,
    },
  });
};

/** Read the calendar once and sort every event. Provider errors leave as StepFailure. */
export const observePull = async (input: Input): Promise<PullObservation> => {
  const { calendar, provider, conn } = input;
  const events = await viaProvider(() =>
    provider.listEvents(calendar.remoteCalendarId, FULL_WINDOW),
  );
  const bindings = new Map(
    (await viaStore(() => loadBindings(conn, calendar.id))).map((b) => [b.externalUid, b]),
  );
  const out: Sink = { changes: [], foreign: [], skipped: [], inSync: new Set() };
  const seen = new Set<string>();
  for (const event of events.filter((e) => e.status !== "cancelled")) {
    const binding = bindings.get(event.id);
    seen.add(event.id);
    if (binding === undefined) await classifyUnbound(input, event, out);
    else if (binding.ownershipToken === null) {
      out.foreign.push({
        externalUid: event.id,
        summary: event.summary ?? null,
        reason: "bound without an ownership token: not created by this service; not imported",
      });
    } else await classifyBound(input, event, binding, out);
  }
  for (const binding of bindings.values()) {
    if (seen.has(binding.externalUid) || binding.ownershipToken === null) continue;
    out.skipped.push({
      beadId: binding.beadId,
      reason: "remote event is no longer listed; deletes are not applied",
    });
  }
  return out;
};
