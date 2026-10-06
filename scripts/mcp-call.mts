#!/usr/bin/env tsx
// mcp:call -- ONE real tool call against the real stdio server.
//
//   pnpm run mcp:call -- <tool_name> '<json arguments>'
//   pnpm run mcp:call -- list_quarantined
//
// The server runs in a child process exactly as an MCP client runs it, so this
// is the same path a real client takes: spawn, initialize, tools/list, call,
// exit code. It prints the tool's JSON result and nothing else, so it can be
// pasted into a conversation.
//
//   pnpm run mcp:call -- tools      list the tool surface and exit
//
// Exits 0 when the call returned a result, 1 when the transport failed or the
// tool refused its arguments, and 2 on a usage error. A tool that answers with a
// refusal in its RESULT (for example moved:false) still exits 0: it answered,
// and the answer is the result. A tool that refuses its ARGUMENTS returns an
// MCP error result rather than throwing, and that is a failed call.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// pnpm forwards the `--` separator itself on some versions, so drop it rather
// than making the caller remember which form this repo's runner prefers.
const argv = process.argv.slice(2).filter((a, i) => !(a === "--" && i === 0));
const [tool, rawArgs] = argv;
if (!tool) {
  console.error("usage: mcp:call <tool_name|'tools'> ['<json arguments>']");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcp/entry.ts"],
  cwd: process.cwd(),
});
const client = new Client({ name: "mcp-call", version: "0.0.0" });
await client.connect(transport);

if (tool === "tools") {
  const { tools } = await client.listTools();
  for (const t of tools) {
    const required = (t.inputSchema.required as string[] | undefined) ?? [];
    console.log(`${t.name.padEnd(18)} ${t.description}  args: [${required.join(", ")}]`);
  }
  await client.close();
  process.exit(0);
}

let args: unknown = {};
if (rawArgs) {
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    console.error(`mcp:call: arguments are not JSON: ${(error as Error).message}`);
    await client.close();
    process.exit(2);
  }
}

let text: string;
let isError = false;
try {
  const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
  text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "{}";
  isError = (result as { isError?: boolean }).isError === true;
} catch (error) {
  console.error(`mcp:call ${tool} failed: ${(error as Error).message}`);
  await client.close();
  process.exit(1);
}

console.log(text);
// A tool that refuses its arguments returns an error result rather than
// throwing. That is still a failure of the call, so it must not exit 0.
await client.close();
process.exit(isError ? 1 : 0);
