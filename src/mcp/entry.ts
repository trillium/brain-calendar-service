#!/usr/bin/env tsx
// The stdio entry point. An MCP client spawns this. It is the composition root:
// the only place the MCP layer is joined to the Dolt store (CALENDAR_DB_*).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDoltStore } from "../adapters/dolt/mcp-store.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const store = createDoltStore();
  const { server } = buildServer(store);
  server.server.onclose = () => void store.close();
  await server.connect(new StdioServerTransport());
}

void main();
