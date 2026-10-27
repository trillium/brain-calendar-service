// sync:verify-plan has to be able to fail. These run the real script against a
// plan file, once with a recorded gog create (must fail) and once clean (must pass).

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HASHES = { calendar_period: "p", calendar_binding: "b", calendar_sync_cursor: "c" };

const verify = (
  providerCalls: { method: string }[],
  tableHashesAfter: Record<string, string> = HASHES,
) => {
  const file = join(mkdtempSync(join(tmpdir(), "verify-plan-")), "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      calendarId: "1",
      dryRun: true,
      push: [],
      pull: [],
      quarantined: [],
      observations: {
        rowDeltas: { calendar_period: 0, calendar_binding: 0 },
        tableHashesBefore: HASHES,
        tableHashesAfter,
        providerCalls,
        doltHeadBefore: "abc",
        doltHeadAfter: "abc",
      },
    }),
  );
  return spawnSync("pnpm", ["exec", "tsx", "scripts/sync-verify-plan.mts", file], {
    encoding: "utf8",
  });
};

describe("sync:verify-plan provider-call check", () => {
  it("passes an empty call log", () => {
    expect(verify([]).status).toBe(0);
  });

  it("passes read-only gog calls", () => {
    expect(verify([{ method: "events" }, { method: "get" }]).status).toBe(0);
  });

  it.each([
    "create",
    "update",
    "delete",
    "move",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ])("fails a recorded %s", (method) => {
    const result = verify([{ method }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`mutating provider call: ${method}`);
  });

  it("passes a read-only verb that merely starts like a mutating one", () => {
    expect(verify([{ method: "updates" }]).status).toBe(0);
  });
});

describe("sync:verify-plan working-set check", () => {
  it("fails when an observed table's working-set hash moved", () => {
    const result = verify([], { ...HASHES, calendar_sync_cursor: "c2" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "dry-run modified calendar_sync_cursor in the Dolt working set",
    );
  });
});
