#!/usr/bin/env tsx
// The always-on entry point: the same tools as entry.ts, over bearer-protected
// Streamable HTTP. This is the composition root for the hosted service, so it is
// where the token is loaded and where startup fails closed.
//
//   MCP_AUTH_TOKEN_FILE=~/.config/brain-calendar/mcp-token pnpm run mcp:http
//
// MCP_HTTP_HOST defaults to 127.0.0.1 and MCP_HTTP_PORT to 3398. Putting it on a
// network interface is a deliberate act: set MCP_HTTP_HOST, and front it with TLS.

import { createDoltStore } from "../adapters/dolt/mcp-store.js";
import { AuthConfigError, loadAuthToken } from "./auth.js";
import { createMcpHttpServer } from "./http.js";

const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_HTTP_PORT ?? 3398);

const main = (): void => {
  const token = loadAuthToken(process.env);
  const store = createDoltStore();
  const server = createMcpHttpServer({ store, token });
  const stop = (): void => {
    server.close(() => void store.close().then(() => process.exit(0)));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  server.listen(port, host, () => {
    process.stderr.write(`brain-calendar MCP listening on http://${host}:${port}/mcp\n`);
  });
};

try {
  main();
} catch (error) {
  if (error instanceof AuthConfigError) {
    process.stderr.write(`mcp:http refused to start: ${error.message}\n`);
    process.exit(78);
  }
  throw error;
}
