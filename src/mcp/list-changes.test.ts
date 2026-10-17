// L2: list_changes failed with "Invalid input" on every input because the handler
// parsed the whole arguments object against a schema for a single string.
//
// tools.test.ts calls handlers directly, which is how that went unnoticed. These
// tests call the tool through a real MCP client and server pair, so the argument
// travels the same wire path a client's call does.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { newStore } from "./tools.js";

const connect = async () => {
  const store = newStore();
  store.periods.push(
    {
      grain: "day",
      startUtc: "2026-04-01T09:00:00Z",
      endUtc: "2026-04-01T09:15:00Z",
      summary: "a",
    },
    {
      grain: "day",
      startUtc: "2026-04-01T10:00:00Z",
      endUtc: "2026-04-01T10:15:00Z",
      summary: "b",
    },
  );
  const { server } = buildServer(store);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "list-changes-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
};

const call = async (client: Client, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name: "list_changes", arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, text: res.content[0].text };
};

describe("list_changes over the MCP surface", () => {
  it("accepts an empty argument object and lists every change", async () => {
    const out = await call(await connect(), {});
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text).map((c: { beadId: string }) => c.beadId)).toEqual(["a", "b"]);
  });

  it("narrows to one bead when beadId is given", async () => {
    const out = await call(await connect(), { beadId: "b" });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text)).toEqual([
      { beadId: "b", startUtc: "2026-04-01T10:00:00Z", endUtc: "2026-04-01T10:15:00Z" },
    ]);
  });

  it("still rejects a malformed beadId rather than coercing it", async () => {
    const out = await call(await connect(), { beadId: "" });
    expect(out.isError).toBe(true);
  });
});
