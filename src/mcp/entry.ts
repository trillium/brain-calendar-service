#!/usr/bin/env tsx
// The stdio entry point. An MCP client spawns this.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const { server } = buildServer();
  await server.connect(new StdioServerTransport());
}

void main();
