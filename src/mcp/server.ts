// The MCP server. Tools over the domain layer only - never over adapters.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dispatch, newStore, type Store, TOOLS } from "./tools.js";

export const buildServer = (store: Store = newStore()) => {
  const server = new McpServer({ name: "brain-calendar-service", version: "0.0.0" });

  for (const tool of TOOLS) {
    // The four-argument form is the one that binds arguments; see tools.ts.
    server.tool(tool.name, tool.description, tool.schema.shape, async (args: unknown) =>
      structured(dispatch(store, tool.name, args)),
    );
  }

  return { server, store, toolNames: TOOLS.map((t) => t.name) };
};

const structured = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
