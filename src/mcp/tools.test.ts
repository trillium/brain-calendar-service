// S8's tests. The tool surface is validated HERE as well as over the wire,
// because "the schema validates" and "the tool works" are different claims.

import { describe, expect, it } from "vitest";
import { dispatch, moveCommitment, newStore, queryPeriod, TOOLS } from "./tools.js";

const store = () => {
  const s = newStore();
  s.periods.push({
    grain: "day",
    startUtc: "2026-04-01T09:00:00Z",
    endUtc: "2026-04-01T09:15:00Z",
    summary: "standup",
  });
  return s;
};

describe("tool surface", () => {
  it("exposes exactly the tools the plan names", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "link_external",
      "list_changes",
      "list_quarantined",
      "move_commitment",
      "propose_day",
      "query_period",
      "unlink_external",
    ]);
  });

  it("rejects a malformed argument rather than coercing it", () => {
    expect(() =>
      queryPeriod(store(), { grain: "fortnight", startUtc: "2026-04-01T00:00:00", zone: "UTC" }),
    ).toThrow();
    expect(() => queryPeriod(store(), { grain: "day" })).toThrow();
  });

  it("reads through the query tool", () => {
    const out = queryPeriod(store(), {
      grain: "day",
      startUtc: "2026-04-01T00:00:00",
      zone: "UTC",
    });
    expect(out.periods).toHaveLength(1);
  });

  it("makes a write visible through a later read", () => {
    const s = store();
    dispatch(s, "move_commitment", { beadId: "standup", newStartUtc: "2026-04-01T11:00:00Z" });
    const after = queryPeriod(s, { grain: "day", startUtc: "2026-04-01T00:00:00", zone: "UTC" });
    expect(after.periods[0].startUtc).toBe("2026-04-01T11:00:00Z");
  });

  it("reports a move that names nothing rather than inventing a record", () => {
    expect(
      moveCommitment(store(), { beadId: "ghost", newStartUtc: "2026-04-01T11:00:00Z" }),
    ).toMatchObject({
      moved: false,
    });
  });

  it("refuses an unknown tool by name", () => {
    expect(() => dispatch(store(), "delete_everything", {})).toThrow(/Unknown tool/);
  });

  it("declares that quarantine has no automatic exit", () => {
    const out = dispatch(store(), "list_quarantined", {}) as { automaticResolution: boolean };
    expect(out.automaticResolution).toBe(false);
  });

  it("calls every tool through dispatch with real, valid arguments", () => {
    const valid: Record<string, unknown> = {
      query_period: { grain: "day", startUtc: "2026-04-01T00:00:00", zone: "UTC" },
      propose_day: {
        zone: "UTC",
        date: "2026-04-02",
        items: [{ summary: "review", startLocal: "2026-04-02T09:00:00", minutes: 30 }],
      },
      move_commitment: { beadId: "standup", newStartUtc: "2026-04-01T11:00:00Z" },
      link_external: { beadId: "standup", calendarId: "cal-1", externalUid: "uid-1" },
      unlink_external: { beadId: "standup", calendarId: "cal-1" },
      list_changes: {},
      list_quarantined: {},
    };
    expect(Object.keys(valid).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const tool of TOOLS) {
      expect(() => dispatch(store(), tool.name, valid[tool.name]), tool.name).not.toThrow();
    }
  });

  it("lists changes, optionally filtered by bead", () => {
    const s = store();
    expect(dispatch(s, "list_changes", {})).toHaveLength(1);
    expect(dispatch(s, "list_changes", { beadId: "standup" })).toHaveLength(1);
    expect(dispatch(s, "list_changes", { beadId: "ghost" })).toHaveLength(0);
    expect(() => dispatch(s, "list_changes", { beadId: "" })).toThrow();
  });

  it("persists a proposed day so a later read sees it", () => {
    const s = newStore();
    dispatch(s, "propose_day", {
      zone: "UTC",
      date: "2026-04-02",
      items: [{ summary: "review", startLocal: "2026-04-02T09:00:00", minutes: 30 }],
    });
    expect(dispatch(s, "list_changes", { beadId: "review" })).toHaveLength(1);
  });
});
