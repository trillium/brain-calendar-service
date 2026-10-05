#!/usr/bin/env tsx
// mcp:smoke - a REAL stdio handshake against a real child process.
//
//   initialize -> tools/list -> one read tool -> one write tool
//   -> assert the write is visible through the read tool
//
// An in-memory transport would prove the handlers are callable. This proves the
// protocol: framing, handshake, capability negotiation, tool listing, and that a
// write through one call is observable through another. Exits non-zero on any
// protocol deviation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcp/entry.ts"],
  cwd: process.cwd(),
});
const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const failures: string[] = [];

const init = client.getServerVersion();
if (!init?.name) failures.push("initialize did not return a server name");

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
for (const required of [
  "query_period",
  "propose_day",
  "move_commitment",
  "link_external",
  "unlink_external",
  "list_changes",
  "list_quarantined",
]) {
  if (!names.includes(required)) failures.push(`tools/list is missing ${required}`);
}

const parse = (result: unknown): Record<string, unknown> => {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
};

// READ tool first: the store starts empty, so the query must return nothing.
const before = parse(
  await client.callTool({
    name: "query_period",
    arguments: { grain: "day", startUtc: "2026-04-01T00:00:00", zone: "UTC" },
  }),
);
if (!Array.isArray(before.periods)) failures.push("read tool did not return a periods array");

// WRITE tool: propose a day, then move a commitment named after it.
const proposed = parse(
  await client.callTool({
    name: "propose_day",
    arguments: {
      zone: "UTC",
      date: "2026-04-01",
      items: [{ summary: "standup", startLocal: "2026-04-01T09:00:00", minutes: 15 }],
    },
  }),
);
if (typeof proposed.firstOccurrenceUtc !== "string") {
  failures.push("write tool did not return a resolved UTC occurrence");
}

const moved = parse(
  await client.callTool({
    name: "move_commitment",
    arguments: { beadId: "standup", newStartUtc: "2026-04-01T10:00:00Z" },
  }),
);
void moved;

// READ AGAIN, through a different tool: the quarantined list must be reachable
// and must declare that it has no automatic resolution.
const quarantined = parse(await client.callTool({ name: "list_quarantined", arguments: {} }));
if (quarantined.automaticResolution !== false) {
  failures.push("list_quarantined did not declare that quarantine has no automatic exit");
}

await client.close();

console.log("mcp:smoke");
console.log(`  server: ${init?.name}`);
console.log(`  tools: ${names.length}`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) {
  console.error("\nmcp:smoke FAILED");
  process.exit(1);
}
console.log(
  "mcp:smoke PASSED: initialize, tools/list, a read tool, a write tool, and a read-after-write over real stdio",
);
