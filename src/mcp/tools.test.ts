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

  it("rejects a malformed argument rather than coercing it", async () => {
    await expect(
      queryPeriod(store(), { grain: "fortnight", startUtc: "2026-04-01T00:00:00", zone: "UTC" }),
    ).rejects.toThrow();
    await expect(queryPeriod(store(), { grain: "day" })).rejects.toThrow();
  });

  it("reads through the query tool", async () => {
    const out = await queryPeriod(store(), {
      grain: "day",
      startUtc: "2026-04-01T00:00:00",
      zone: "UTC",
    });
    expect(out.periods).toHaveLength(1);
  });

  it("makes a write visible through a later read", async () => {
    const s = store();
    await dispatch(s, "move_commitment", {
      beadId: "standup",
      newStartUtc: "2026-04-01T11:00:00Z",
    });
    const after = await queryPeriod(s, {
      grain: "day",
      startUtc: "2026-04-01T00:00:00",
      zone: "UTC",
    });
    expect(after.periods[0].startUtc).toBe("2026-04-01T11:00:00Z");
  });

  it("reports a move that names nothing rather than inventing a record", async () => {
    expect(
      await moveCommitment(store(), { beadId: "ghost", newStartUtc: "2026-04-01T11:00:00Z" }),
    ).toMatchObject({
      moved: false,
    });
  });

  it("refuses an unknown tool by name", async () => {
    await expect(dispatch(store(), "delete_everything", {})).rejects.toThrow(/Unknown tool/);
  });

  it("declares that quarantine has no automatic exit", async () => {
    const out = (await dispatch(store(), "list_quarantined", {})) as {
      automaticResolution: boolean;
    };
    expect(out.automaticResolution).toBe(false);
  });
});
