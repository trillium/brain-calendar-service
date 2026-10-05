// Gate G1: the resolution function must be TOTAL and STABLE.
//
// The plan is explicit that before the sync stage is worth building, the
// resolution function must be proven total - every pair of inputs resolves,
// none returns "unknown" - and that the properties which matter are
// idempotence, commutativity, and stability (no flapping).
//
// Per plan 7.0 T10, every assertion here fails if `resolve` returned nothing: the
// totality check asserts the SHAPE of the result, and each property asserts on
// the resolved winner rather than on a proxy.

import { describe, expect, it } from "vitest";
import { CASES, runTable } from "../decision-table.js";
import { resolve } from "../resolve.js";
import { canonical, type Occurrence, type ResolutionReason } from "../types.js";
import { pairs } from "./pairs.js";

const REASONS: ResolutionReason[] = [
  "different_object",
  "different_occurrence",
  "instance_overrides_parent",
  "higher_sequence",
  "later_dtstamp",
  "identical",
  "tie_broken_canonically",
];

const SWEEP = pairs(20260301, 2000);

describe("decision table", () => {
  it("gives every case a named reason and a winner or an explicit both-retained", () => {
    for (const row of runTable()) {
      expect(REASONS).toContain(row.reason);
      expect(row.reason).not.toBe("unknown");
      expect(row.winner.length).toBeGreaterThan(0);
    }
  });

  it("retains both sides when the two sides are not the same object", () => {
    const row = runTable().find((r) => r.name.startsWith("different UIDs"));
    expect(row?.reason).toBe("different_object");
    expect(row?.conflicted).toBe(false);
  });

  it("lets a higher sequence win even against a far-future DTSTAMP", () => {
    const row = runTable().find((r) => r.name.startsWith("a far-future sequence"));
    expect(row?.reason).toBe("higher_sequence");
    expect(row?.winner).toBe("local");
  });

  it("has a case for each key the plan names", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10);
  });
});

describe("totality", () => {
  it("resolves every pair with a reason that is never 'unknown'", () => {
    for (const [local, remote] of SWEEP) {
      const result = resolve(local, remote);
      expect(result).toBeDefined();
      expect(REASONS).toContain(result.reason);
      expect(result.reason).not.toBe("unknown");
    }
  });

  it("always returns either a winner or an explicit both-retained outcome", () => {
    for (const [local, remote] of SWEEP) {
      const result = resolve(local, remote);
      if (result.winner === null) {
        // Both retained is a SUCCESSFUL resolution, not a failure: two
        // different objects were never in conflict.
        expect(["different_object", "different_occurrence"]).toContain(result.reason);
      } else if (result.conflicted) {
        // A real conflict must name what superseded what.
        expect(result.supersededBy).not.toBeNull();
        expect(result.loserPayload).not.toBeNull();
      } else {
        // An instance overlaying its parent is not a supersession.
        expect(result.reason).toBe("instance_overrides_parent");
        expect(result.supersededBy).toBeNull();
      }
    }
  });
});

describe("commutativity", () => {
  it("picks the same winning content whichever side is presented first", () => {
    for (const [local, remote] of SWEEP) {
      const forward = resolve(local, remote);
      const backward = resolve(remote, local);
      if (forward.winner === null) {
        expect(backward.winner).toBeNull();
        expect(backward.reason).toBe(forward.reason);
        continue;
      }
      // Normalise `source` away: commutativity is a claim about WHICH payload
      // stands, not about which argument happened to arrive first.
      const strip = (o: Occurrence): Occurrence => ({ ...o, source: "local" });
      const winnerForward = forward.winner as Occurrence;
      const winnerBackward = backward.winner as Occurrence;
      expect(canonical(strip(winnerForward))).toBe(canonical(strip(winnerBackward)));
    }
  });
});

describe("idempotence", () => {
  it("re-resolving an already-resolved pair changes nothing", () => {
    for (const [local, remote] of SWEEP) {
      const once = resolve(local, remote);
      if (once.winner === null || once.loserPayload === null) continue;
      const twice = resolve(once.winner, once.loserPayload);
      expect(twice.winner).not.toBeNull();
      expect(canonical(twice.winner as Occurrence)).toBe(canonical(once.winner));
      expect(twice.reason).toBe(once.reason);
    }
  });
});

describe("stability", () => {
  it("does not flap: a resolved pair re-fed stays resolved the same way", () => {
    for (const [local, remote] of SWEEP) {
      const first = resolve(local, remote);
      if (first.winner === null || first.loserPayload === null) continue;
      for (let round = 0; round < 3; round += 1) {
        const again = resolve(first.winner as Occurrence, first.loserPayload);
        expect(canonical(again.winner as Occurrence)).toBe(canonical(first.winner));
      }
    }
  });

  it("keeps the same side as winner across repeated syncs of the same pair", () => {
    for (const [local, remote] of SWEEP.slice(0, 200)) {
      const first = resolve(local, remote);
      if (first.winner === null) continue;
      const source = first.winner.source;
      expect(resolve(local, remote).winner?.source).toBe(source);
      expect(resolve(remote, local).winner?.source).toBe(source);
    }
  });
});
