// S10's tests: the four phases, backfill idempotency, and a rollback that is
// measured rather than asserted.

import { describe, expect, it } from "vitest";
import { refuseOnDirty } from "./drill-store.js";
import { backfill, mayDelete, PHASES, RIGHTS } from "./phases.js";
import { measureRollback } from "./rollback.js";

const CANDIDATES = [
  {
    beadId: "brain-1",
    summary: "One",
    startUtc: "2026-05-01T15:00:00Z",
    durationSeconds: 900,
    markerKey: "X-Beads-Id",
    markerValue: "brain-1",
  },
  {
    beadId: "brain-2",
    summary: "Two",
    startUtc: "2026-05-02T15:00:00Z",
    durationSeconds: 900,
    markerKey: "X-Beads-Id",
    markerValue: "brain-2",
  },
];

describe("phase order and rights", () => {
  it("is shadow, backfill, pull-only, bidirectional", () => {
    expect(PHASES).toEqual(["shadow", "backfill", "pull-only", "bidirectional"]);
  });

  it("never lets shadow or pull-only write to a provider", () => {
    expect(RIGHTS.shadow.writesToProvider).toBe(false);
    expect(RIGHTS["pull-only"].writesToProvider).toBe(false);
  });

  it("never grants delete to ANY phase", () => {
    for (const phase of PHASES) expect(mayDelete(phase)).toBe(false);
    for (const phase of PHASES) expect(RIGHTS[phase].deletesFromProvider).toBe(false);
  });
});

describe("backfill is idempotent from the first run", () => {
  it("creates everything on the first run", () => {
    const markers = new Map<string, string>();
    const first = backfill(CANDIDATES, markers, RIGHTS.backfill);
    expect(first.created).toBe(2);
    expect(first.skipped).toBe(0);
  });

  it("creates NOTHING on the second run - this is the whole point", () => {
    const markers = new Map<string, string>();
    backfill(CANDIDATES, markers, RIGHTS.backfill);
    const second = backfill(CANDIDATES, markers, RIGHTS.backfill);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("creates nothing at all during shadow", () => {
    const markers = new Map<string, string>();
    expect(backfill(CANDIDATES, markers, RIGHTS.shadow).created).toBe(0);
  });

  it("recovers from a partial failure without duplicating what landed", () => {
    const markers = new Map<string, string>();
    const partial = backfill([CANDIDATES[0]], markers, RIGHTS.backfill);
    expect(partial.created).toBe(1);
    const resumed = backfill(CANDIDATES, markers, RIGHTS.backfill);
    expect(resumed.created).toBe(1);
    expect(resumed.skipped).toBe(1);
    expect(new Set([...markers.values()]).size).toBe(2);
  });
});

describe("rollback is measured, not asserted", () => {
  const base = {
    checkpoint: { commitHash: "aaa", at: 1_000, rows: 10 },
    failedAt: { commitHash: "bbb", at: 4_000, rows: 14 },
  };

  it("reports RTO, RPO and what dominated the rollback", async () => {
    const result = await measureRollback({
      ...base,
      rowsBefore: 14,
      restore: async () => ({ ms: 12, phaseMs: { checkout: 8, verify: 4 }, rowsAfter: 10 }),
    });
    expect(result.ok).toBe(true);
    expect(result.rtoMs).toBeGreaterThanOrEqual(0);
    expect(result.rpoRows).toBe(4);
    expect(result.rpoMs).toBe(3_000);
    expect(result.rowsBefore).toBe(14);
    expect(result.rowsAfter).toBe(10);
    expect(result.dominatedBy.phase).toBe("checkout");
    expect(result.dominatedBy.share).toBeCloseTo(8 / 12, 5);
  });

  it("FAILS when the store did not return to its pre-migration state", async () => {
    const result = await measureRollback({
      ...base,
      rowsBefore: 14,
      restore: async () => ({ ms: 5, phaseMs: { checkout: 5 }, rowsAfter: 13 }),
    });
    expect(result.ok).toBe(false);
    expect(result.residual[0]).toMatch(/pre-migration/);
  });
});

describe("the drill refuses to roll back someone else's uncommitted work", () => {
  it("passes a clean store", () => {
    expect(refuseOnDirty([])).toBeNull();
  });

  it("names the dirty tables rather than discarding them", () => {
    const refusal = refuseOnDirty(["calendar_period", "calendar_binding"]);
    expect(refusal).toMatch(/calendar_period, calendar_binding/);
    expect(refusal).toMatch(/refusing/);
  });
});
