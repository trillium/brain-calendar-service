// The HTTP face of the MCP server: Streamable HTTP, stateless, bearer-protected.
//
// Stateless on purpose. Every request builds its own server and transport over
// the one shared Store, so there is no session table to leak or to restart, and a
// launchd restart loses nothing. The only unauthenticated route is GET /healthz,
// which reports liveness and nothing about the store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerMatches } from "./auth.js";
import { buildServer } from "./server.js";
import type { Store } from "./store.js";

interface HttpOptions {
  readonly store: Store;
  readonly token: string;
}

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1_000_000;

const send = (res: ServerResponse, status: number, body: unknown, headers = {}): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError("request body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const handleMcp = async (store: Store, req: IncomingMessage, res: ServerResponse) => {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    const tooLarge = error instanceof RangeError;
    send(res, tooLarge ? 413 : 400, { error: tooLarge ? "body too large" : "body is not JSON" });
    return;
  }
  const { server } = buildServer(store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
};

export const createMcpHttpServer = ({ store, token }: HttpOptions): Server =>
  createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }
    if (path !== MCP_PATH) {
      send(res, 404, { error: "not found" });
      return;
    }
    // Checked before the body is read: an unauthenticated caller costs one header compare.
    if (!bearerMatches(req.headers.authorization, token)) {
      send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="mcp"' });
      return;
    }
    handleMcp(store, req, res).catch((error: unknown) => {
      // The message goes to stderr (launchd's log); the client only learns it failed.
      process.stderr.write(`mcp http: ${error instanceof Error ? error.message : error}\n`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });
