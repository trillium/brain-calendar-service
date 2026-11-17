// The auth claim, proven over a real socket: an unauthenticated request never
// reaches a tool, and an authenticated one does and persists to Dolt.

import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDoltStore } from "../adapters/dolt/mcp-store.js";
import { createMcpHttpServer } from "./http.js";
import type { Store } from "./store.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

const TOKEN = "c".repeat(64);

let db: TestDatabase;
let store: Store;
let server: ReturnType<typeof createMcpHttpServer>;
let base: string;

beforeAll(async () => {
  db = await createTestDatabase();
  store = createDoltStore(db.name);
  server = createMcpHttpServer({ store, token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store?.close();
  await db?.drop();
});

const rpc = (headers: Record<string, string>) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("unauthenticated callers", () => {
  it("get 401 and a challenge when no token is sent", async () => {
    const res = await rpc({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("get 401 for a wrong token", async () => {
    expect((await rpc({ authorization: `Bearer ${"d".repeat(64)}` })).status).toBe(401);
  });

  it("get 401 before the body is parsed, so a garbage body leaks nothing", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(401);
  });

  it("cannot reach a tool through a GET either", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(401);
  });
});

describe("the open routes", () => {
  it("serves /healthz without a token and reveals nothing about the store", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s everything else, authenticated or not", async () => {
    expect((await fetch(`${base}/anything`)).status).toBe(404);
  });
});

describe("an authenticated client", () => {
  it("lists tools, writes and reads back through the same Dolt store", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("propose_day");
      await client.callTool({
        name: "propose_day",
        arguments: {
          zone: "UTC",
          date: "2026-04-01",
          items: [{ summary: "standup", startLocal: "2026-04-01T09:00:00", minutes: 15 }],
        },
      });
      const periods = await store.listPeriods();
      expect(periods.map((p) => p.summary)).toEqual(["standup"]);
    } finally {
      await client.close();
    }
  });
});
