// L1: the MCP tools used an in-process store that started empty, so nothing a
// tool wrote survived the call. These tests use a REAL disposable Dolt (port
// 3399, never the fleet server on 3307), each run in its own database.
//
// The strongest case spawns the real stdio entry point twice: a write made by
// one server process must be read by the next one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Connection, createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config, ROOT } from "../adapters/dolt/config.mjs";
import { databaseConfigured, openDoltStore } from "../adapters/dolt/store.js";
import { dispatch, newStore } from "./tools.js";

const DB = `mcp_store_test_${process.pid}`;
const PORT = 3399;
let admin: Connection;

beforeAll(async () => {
  expect(config.port).not.toBe(3307);
  admin = await createConnection({ host: config.host, port: PORT, user: config.user });
  await admin.query(`CREATE DATABASE \`${DB}\``);
  const conn = await createConnection({
    host: config.host,
    port: PORT,
    user: config.user,
    database: DB,
    multipleStatements: true,
  });
  await conn.query(
    readFileSync(join(ROOT, "migrations", "1_calendar_service_initial_schema.sql"), "utf8"),
  );
  await conn.end();
});

afterAll(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin?.end();
});

const PROPOSE = {
  zone: "America/New_York",
  date: "2026-04-01",
  items: [
    { summary: "standup", startLocal: "2026-04-01T09:00:00", minutes: 15 },
    { summary: "review", startLocal: "2026-04-01T14:00:00", minutes: 30 },
  ],
};
const QUERY = { grain: "day", startUtc: "2026-04-01T00:00:00", zone: "America/New_York" };

describe("Dolt-backed store", () => {
  it("returns across calls what propose_day wrote", async () => {
    const store = await openDoltStore({ port: PORT, database: DB });
    try {
      const before = (await dispatch(store, "query_period", QUERY)) as { periods: unknown[] };
      expect(before.periods).toEqual([]);

      await dispatch(store, "propose_day", PROPOSE);
      const after = (await dispatch(store, "query_period", QUERY)) as {
        periods: { summary: string; startUtc: string; endUtc: string }[];
      };
      expect(after.periods).toEqual([
        expect.objectContaining({
          summary: "standup",
          startUtc: "2026-04-01T13:00:00Z",
          endUtc: "2026-04-01T13:15:00Z",
        }),
        expect.objectContaining({ summary: "review", startUtc: "2026-04-01T18:00:00Z" }),
      ]);
    } finally {
      await store.close();
    }
  });

  it("moves a stored commitment and reports a ghost as not moved", async () => {
    const store = await openDoltStore({ port: PORT, database: DB });
    try {
      const moved = await dispatch(store, "move_commitment", {
        beadId: "standup",
        newStartUtc: "2026-04-01T15:00:00Z",
      });
      expect(moved).toMatchObject({ moved: true, startUtc: "2026-04-01T15:00:00Z" });
      const changes = (await dispatch(store, "list_changes", { beadId: "standup" })) as {
        startUtc: string;
        endUtc: string;
      }[];
      expect(changes).toEqual([
        { beadId: "standup", startUtc: "2026-04-01T15:00:00Z", endUtc: "2026-04-01T15:15:00Z" },
      ]);
      expect(
        await dispatch(store, "move_commitment", {
          beadId: "ghost",
          newStartUtc: "2026-04-01T15:00:00Z",
        }),
      ).toMatchObject({ moved: false });
    } finally {
      await store.close();
    }
  });

  it("surfaces an unresolved quarantined conflict", async () => {
    const conn = await createConnection({
      host: config.host,
      port: PORT,
      user: config.user,
      database: DB,
    });
    await conn.query(
      `INSERT INTO calendar_conflict (calendar_id, bead_id, reason, local_payload, remote_payload,
         resolved, created_at, updated_at)
       VALUES (1, 'standup', 'local_delete_needs_human', '{}', '{}', 0, NOW(), NOW())`,
    );
    await conn.end();
    const store = await openDoltStore({ port: PORT, database: DB });
    try {
      expect(await dispatch(store, "list_quarantined", {})).toMatchObject({
        conflicts: [{ beadId: "standup", reason: "local_delete_needs_human" }],
        automaticResolution: false,
      });
    } finally {
      await store.close();
    }
  });
});

describe("the stdio entry point", () => {
  const callOnce = async (env: Record<string, string>, name: string, args: unknown) => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/mcp/entry.ts"],
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), ...env },
    });
    const client = new Client({ name: "dolt-store-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const res = (await client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      })) as { content: { text: string }[] };
      return JSON.parse(res.content[0].text) as { periods: { summary: string }[] };
    } finally {
      await client.close();
    }
  };

  it("keeps a write across server processes when a database is configured", async () => {
    const env = { CALENDAR_DB_PORT: String(PORT), CALENDAR_DB_NAME: DB };
    await callOnce(env, "propose_day", {
      ...PROPOSE,
      date: "2026-05-01",
      items: [{ summary: "planning", startLocal: "2026-05-01T10:00:00", minutes: 60 }],
    });
    const out = await callOnce(env, "query_period", {
      grain: "day",
      startUtc: "2026-05-01T00:00:00",
      zone: "America/New_York",
    });
    expect(out.periods.map((p) => p.summary)).toEqual(["planning"]);
  }, 30_000);
});

describe("store selection", () => {
  it("treats any CALENDAR_DB_* variable as a configured database", () => {
    expect(databaseConfigured({})).toBe(false);
    expect(databaseConfigured({ CALENDAR_DB_NAME: "x" })).toBe(true);
    expect(databaseConfigured({ CALENDAR_DB_PORT: "3399" })).toBe(true);
  });

  it("keeps the in-process store working with no database", async () => {
    const store = newStore();
    await dispatch(store, "propose_day", PROPOSE);
    const out = (await dispatch(store, "query_period", QUERY)) as { periods: unknown[] };
    expect(out.periods).toHaveLength(2);
  });
});
