# MCP surface

## What it is
Seven tools over the **domain layer only** — no adapter is reachable from here,
which is the point. Every argument is validated with Zod at the boundary.

## How to drive it
```sh
pnpm run test -- src/mcp --run
pnpm run mcp:smoke
```

## What it should produce
A real stdio handshake against a child process: initialize, tools/list, a read
tool **with arguments**, a write tool, and a read-after-write. The acceptance test
is the argument-bearing call returning success — **not** a clean handshake.

## What breaks if it breaks
The most dangerous break here is silent. `registerTool(name, {inputSchema}, cb)`
type-checks, reads as the modern API, publishes an empty schema and delivers zero
arguments; a zero-argument tool still works, so a handshake-only smoke test
passes while every real call fails. Use the four-argument `tool()` form. See
`src/mcp/tools.ts` for the full note.
