# MCP over HTTP, and who may call it

There are two ways in to the same seven tools.

| Entry | Transport | Who can call it | Auth |
|---|---|---|---|
| `src/mcp/entry.ts` | stdio | the parent process that spawned it | none needed: the client owns the process |
| `src/mcp/http-entry.ts` (`pnpm run mcp:http`) | Streamable HTTP, stateless | anything that can reach the port | **bearer token, required** |

The HTTP entry exists so an always-on host can
serve the tools to a voice assistant that is not a child process.

## The token

One shared secret, checked on every request to `/mcp`.

```sh
umask 077 && mkdir -p ~/.config/brain-calendar \
  && openssl rand -hex 32 > ~/.config/brain-calendar/mcp-token
MCP_AUTH_TOKEN_FILE=~/.config/brain-calendar/mcp-token pnpm run mcp:http
```

- `MCP_AUTH_TOKEN_FILE` (preferred) names a file readable only by its owner. The
  server refuses a file that group or others can read.
- `MCP_AUTH_TOKEN` is the inline form. Use it for tests; a launchd plist or shell
  history is a worse home for a secret than a 0600 file.
- Setting both is an error. A token under 32 characters or with whitespace in it is
  an error. No token at all is an error: the process exits 78 before it opens a socket.
- The token is compared in constant time and is never logged or echoed in an error.

Clients send `Authorization: Bearer <token>`. A missing or wrong token gets
`401` with `WWW-Authenticate: Bearer realm="mcp"`, decided before the request body
is read, so an unauthenticated caller never reaches a tool.

## Network exposure

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` | `127.0.0.1` | interface to bind; loopback only unless you change it |
| `MCP_HTTP_PORT` | `3398` | port |

The token authenticates; it does not encrypt. Anything beyond loopback needs TLS in
front of it (a tunnel or a reverse proxy). The server speaks plain HTTP itself.

`GET /healthz` answers `{"ok":true}` without a token and says nothing about the
store. Every other path is `404`.

## What this does not do

- One token, no per-user identity, no scopes: whoever holds it can call every tool,
  including `propose_day` and `move_commitment`. That matches a single-operator service.
- No rotation machinery. Rotate by writing a new file and restarting the process.
- No rate limiting.
- It does not change what the tools can do. They still never call gog or any
  provider; only the sync scripts do.

## Checked by

`src/mcp/auth.test.ts` (token parsing and comparison) and `src/mcp/http.test.ts`
(a real socket: 401 without or with a wrong token, 200 on `/healthz`, and a
full authenticated client that proposes a day and finds it in Dolt).
