// The MCP server. Tools over the domain layer only - never over adapters.
// The store is injected: this module has no default, so a server cannot be
// built over an accidental in-memory stand-in.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "./store.js";
import { dispatch, TOOLS } from "./tools.js";

export const buildServer = (store: Store) => {
  const server = new McpServer({ name: "brain-calendar-service", version: "0.0.0" });

  for (const tool of TOOLS) {
    // The four-argument form is the one that binds arguments; see tools.ts.
    server.tool(tool.name, tool.description, tool.schema.shape, async (args: unknown) =>
      structured(await dispatch(store, tool.name, args)),
    );
  }

  return { server, store, toolNames: TOOLS.map((t) => t.name) };
};

const structured = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
