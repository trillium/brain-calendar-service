# What stands between origin/main and LIVE

Written 2026-11-16 against `origin/main` at `cbeece5`. "Live" means: the service runs
unattended on an always-on Mac, syncs a calendar the owner names through gog, and an MCP
client can call its tools over an authenticated endpoint.

## Where main already is

Already on `origin/main` and verified this pass (199 tests, 18 files, green on a clean
checkout against a disposable Dolt): the gog provider, the calendar registry, push apply,
pull of remote time edits with self-echo drop, Dolt-backed MCP tools, `list_changes`
fixed (L2), scoped test commands that narrow (L6) and a test run that leaves tracked files
alone (L5). Verified live once, on 2026-10-26, against a throwaway calendar (6 rounds, see
`docs/running-by-hand.md` L3). Nothing has been pointed at an existing calendar.

## The old macbook-only main

`macbook-local-main-20261116` has 19 commits and shares no history with `origin/main`. Diffed
by tree. Only one fix was still needed and not on main:

| Macbook item | Verdict |
|---|---|
| F3: open-ended RRULE walked 1000 occurrences past the pinned timezone table and threw | **ported** (`fm/task-bcs-live-gh-rrule-bound`) |
| `list_changes` "Invalid input" (L2, task-5uvan) | already fixed on main (`4edba70`) and covered through a real server by `persistence.test.ts`; nothing to port |
| L5 test hygiene, L6 scoped tests, DB-backed MCP store (L1) | already on main, in a different form; the stale doc text is corrected here |
| CalDAV transport, Google API v3 reader, OAuth plumbing, `rollout-checklist.md` | superseded: all calendar I/O is gog now, so no OAuth client code is wanted |

Not found: the task records `task-5uvan` and `task-stl82` (they live in the macbook's
stores), so their wording was not available. L3/L4 on the macbook were read as the
runbook's own L3/L4.

## Done, as PR-ready branches (one concern each)

| Branch | What |
|---|---|
| `fm/task-bcs-live-gh-rrule-bound` | F3 port, with the macbook's tests |
| `fm/task-bcs-live-gh-prepush-hook` | the pre-push hook called `fallow dead-code`, which fallow 1.9 no longer has, so **every push failed**; now `fallow check` |
| `fm/task-bcs-live-gh-mcp-auth` | `pnpm run mcp:http`: Streamable HTTP MCP entry that refuses to start without a token and answers 401 without it; `docs/mcp-auth.md` |
| `fm/task-bcs-live-gh-hosting` (stacked on mcp-auth) | `pnpm run launchd:gen` plist generator (dolt, mcp, one sync job per calendar; read-only dry-run by default; no secret in any plist), `docs/hosting.md` |
| `fm/task-bcs-live-gh-soak` | `pnpm run gog:preflight`, `SOAK_REPORT_PATH`, `docs/soak.md` |
| `fm/task-bcs-live-gh` | this document and the stale-doc corrections |

## Needs the owner (genuinely)

1. **gog on the always-on host has no OAuth client and no token.** On the host this was
   written on, `gog:preflight` reports `MISSING-CLIENT` (`gog auth credentials` never run)
   and `gog auth list --check` says "No tokens stored". The intent is to reuse the existing
   calendar application's Google credentials, with no new client or account; gog still needs
   that client JSON imported (`gog auth credentials <credentials.json>`) and one browser
   consent (`gog auth add <address>`). Only the owner can do either. This is the one item
   that blocks the soak.
2. **Name the calendar and grant write permission** (the SyncPolicy allowlist). Until then
   generated sync jobs are read-only dry-runs.
3. **Dolt: own server or the fleet one.** The hosting design uses the service's own Dolt.
   A migration against the fleet-shared Dolt is human-paused by `AGENTS.md`.
4. **Install on the host**: `launchctl bootstrap` the generated plists, keep the Mac awake,
   and (if a client is off-box) choose the TLS tunnel. Steps are in `docs/hosting.md`.
5. **Register the MCP endpoint with the voice assistant** (`pi mcp add` or its URL form):
   it writes the assistant's configuration, which is a human decision.
6. **Merge the PRs**, in order: mcp-auth before hosting (hosting is stacked on it).

## Can be done by an agent, not done here

- A longer soak on the host once item 1 is cleared: run `docs/soak.md` end to end
  (needs a live gog, so it was prepared and not faked).
- Alerting on a failed sync, a Dolt backup, and a deploy/update script (listed as known
  gaps in `docs/hosting.md`).
- An integration test that runs `mcp:http` as a child process with the real token flow
  (the unit and socket tests cover the logic; the process was driven by hand).

## Verified and not verified

Verified: 199 baseline tests; each branch's suite, lint, type-check, health and spellcheck
(full suite 225 tests on mcp-auth, 210 on soak); the HTTP server's 401 and 200 paths and its
startup refusals by driving the real process with curl; every generated plist with
`plutil -lint`; the env-sourcing wrapper; and the preflight's real output on a host with no
credentials. Not verified: anything against real Google, an actual `launchctl` install,
`pnpm run canon:audit` (it needs a Canon checkout, `CANON_ROOT`, not present on this host),
and the macbook's task records.
