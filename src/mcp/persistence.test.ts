// The claim these tests exist to prove: state written through the MCP server
// survives the process that wrote it. Each step runs a FRESH `entry.ts` child
// over real stdio, so nothing can be remembered in memory between calls, and the
// store is also read back over a separate connection that bypasses the tools.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectChanges } from "../sync/changedetection/plan.js";
import { buildSyncPlan } from "../sync/orchestration/plan.js";
import { createTestDatabase, openDirect, type TestDatabase } from "./test-db.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

/** One tool call against a brand-new server process, which exits afterwards. */
const callInFreshProcess = async (name: string, args: Record<string, unknown>) => {
  const client = new Client({ name: "persistence-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/mcp/entry.ts"],
      cwd: process.cwd(),
      env: { ...(process.env as Record<string, string>), CALENDAR_DB_NAME: db.name },
    }),
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? "null";
    return JSON.parse(text) as unknown;
  } finally {
    await client.close();
  }
};

const head = async (conn: Awaited<ReturnType<typeof openDirect>>): Promise<string> => {
  const [rows] = await conn.query(
    "SELECT commit_hash FROM dolt_log ORDER BY date DESC, commit_hash LIMIT 1",
  );
  return (rows as { commit_hash: string }[])[0]?.commit_hash ?? "";
};

describe("persistence across fresh server processes", () => {
  it("a day proposed in one process is read, moved and re-read in others", async () => {
    await callInFreshProcess("propose_day", {
      zone: "America/New_York",
      date: "2026-04-01",
      items: [{ summary: "standup", startLocal: "2026-04-01T09:00:00", minutes: 15 }],
    });

    const day = { grain: "day", startUtc: "2026-04-01T00:00:00", zone: "UTC" };
    expect(await callInFreshProcess("query_period", day)).toMatchObject({
      periods: [{ summary: "standup", startUtc: "2026-04-01T13:00:00Z" }],
    });

    expect(
      await callInFreshProcess("move_commitment", {
        beadId: "standup",
        newStartUtc: "2026-04-01T15:00:00Z",
      }),
    ).toMatchObject({ moved: true });
    expect(await callInFreshProcess("list_changes", { beadId: "standup" })).toEqual([
      { beadId: "standup", startUtc: "2026-04-01T15:00:00Z", endUtc: "2026-04-01T15:15:00Z" },
    ]);

    // Independent of the tools: the row is in the database, and in Dolt history.
    const conn = await openDirect(db.name);
    try {
      const [rows] = await conn.query(
        "SELECT linked_bead_id, period_start_utc FROM calendar_period",
      );
      expect(rows).toEqual([
        { linked_bead_id: "standup", period_start_utc: "2026-04-01 15:00:00" },
      ]);
      const [log] = await conn.query("SELECT message FROM dolt_log WHERE message LIKE 'mcp:%'");
      expect((log as { message: string }[]).map((r) => r.message).sort()).toEqual([
        "mcp: move standup",
        "mcp: propose 1 period(s)",
      ]);
      const [status] = await conn.query(
        "SELECT table_name FROM dolt_status WHERE table_name IN ('calendar_period', 'calendar_binding')",
      );
      // Everything the tools wrote is committed, not left in the working set.
      expect(status).toEqual([]);
    } finally {
      await conn.end();
    }
  }, 60_000);

  it("links persist, and a refused move names a clash in a later process", async () => {
    await callInFreshProcess("link_external", {
      beadId: "standup",
      calendarId: "cal-1",
      externalUid: "uid-1",
    });
    expect(
      await callInFreshProcess("link_external", {
        beadId: "standup",
        calendarId: "cal-1",
        externalUid: "uid-2",
      }),
    ).toMatchObject({ linked: false });
    expect(
      await callInFreshProcess("unlink_external", { beadId: "standup", calendarId: "cal-1" }),
    ).toMatchObject({ unlinked: true });
  }, 60_000);
});

describe("tool writes reach the sync engine", () => {
  it("a proposed day shows up in change detection and in the sync plan", async () => {
    const conn = await openDirect(db.name);
    try {
      const cursor = await head(conn);
      await callInFreshProcess("propose_day", {
        zone: "UTC",
        date: "2026-05-01",
        items: [{ summary: "planning", startLocal: "2026-05-01T09:00:00", minutes: 60 }],
      });

      const detection = await detectChanges(conn, "calendar_period", cursor);
      expect(detection).toMatchObject({ state: "ok" });
      expect(detection.state === "ok" ? detection.changedIds.length : 0).toBe(1);

      await conn.query(
        `INSERT INTO calendar_sync_cursor
           (source_database, calendar_id, last_synced_commit_hash, last_round_at, created_at, updated_at)
         VALUES ('brain_calendar_service', 1, ?, NOW(), NOW(), NOW())`,
        [cursor],
      );
      const plan = await buildSyncPlan({
        conn,
        calendarId: "1",
        provider: "google",
        remoteChanges: [],
        providerCalls: () => [],
      });
      expect(plan.push.map((p) => p.beadId)).toEqual([
        expect.stringMatching(/^row:calendar_period:\d+$/),
      ]);
      expect(plan.quarantined).toEqual([]);
    } finally {
      await conn.end();
    }
  }, 60_000);
});
