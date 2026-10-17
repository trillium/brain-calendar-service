#!/usr/bin/env tsx
// The stdio entry point. An MCP client spawns this.
//
// This is the composition root: it alone decides which Store backs the tools.
// A configured database (CALENDAR_DB_HOST / _PORT / _NAME) means Dolt, and a
// failure to reach it is fatal rather than a quiet fall back to an empty
// in-process store, which would look like it works and lose every write.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { databaseConfigured, openDoltStore } from "../adapters/dolt/store.js";
import { buildServer } from "./server.js";
import { newStore } from "./tools.js";

async function main(): Promise<void> {
  const store = databaseConfigured() ? await openDoltStore() : newStore();
  const { server } = buildServer(store);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`mcp entry failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
