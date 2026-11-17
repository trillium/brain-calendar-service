# The soak run with gog

A soak is the service running real rounds against a real Google calendar through gog,
with every round recorded in the soak report. The 2026-10-26 run (6 rounds against one
throwaway calendar, see `docs/running-by-hand.md` L3) is the only live evidence so far.
This is the procedure to repeat it on the always-on host, and then to move to a calendar the
owner names. **It has not been run on the host this was written on**: gog is installed
there but has no OAuth client and no token, so `gog:preflight` stops at step 1.

## 1. Preflight (read only)

```sh
set -a; . ~/.config/gog/env; set +a        # gog's file-keyring variables, if used
export GOG_ACCOUNT=you@example.com
pnpm run gog:preflight
```

It runs `gog --version` and `gog -a $GOG_ACCOUNT --readonly calendar calendars`, and exits 0
only when gog can list calendars. Otherwise it names the fix:

| Output | Meaning | Fix |
|---|---|---|
| `MISSING-BINARY` | gog not on PATH | install gog, or set `GOG_BIN` |
| `MISSING-CLIENT` | gog has no OAuth client | `gog auth credentials <credentials.json>` with the existing calendar application's client; no new client is needed |
| `NOT-AUTHENTICATED` | client present, no token | `gog auth add <address>` (browser consent, owner only) |
| `UNREADABLE` / `FAILED` | gog answered oddly or errored | read the message |

## 2. A throwaway calendar, never an existing one

Dry-run first: gog's global `-n` prints the intended action and writes nothing.

```sh
gog -a "$GOG_ACCOUNT" -n calendar create-calendar bcs-soak-$(date +%Y%m%d)
gog -a "$GOG_ACCOUNT" --json calendar create-calendar bcs-soak-$(date +%Y%m%d)   # creates it
```

Note the calendar id it prints. This creates one new secondary calendar and nothing else.

## 3. Register it, plan it, check the plan wrote nothing

```sh
pnpm run calendar:register --remote-id <id> --name soak
pnpm run sync:once --calendar <id> --dry-run --json | tee /tmp/plan.json
pnpm run sync:verify-plan /tmp/plan.json      # must say PASSED, zero observed writes
```

## 4. Six live rounds

Keep the report out of the checkout: `export SOAK_REPORT_PATH=$HOME/soak-report.json`.
Without it, rounds append to the tracked `evidence/soak/report.json`.

| Round | Do | Expect |
|---|---|---|
| 1 | `pnpm run sync:once --calendar <id>` | baseline: pushes 0 |
| 2 | `pnpm run mcp:call -- propose_day '{...}'`, then `sync:once` | pushes 1, event appears once |
| 3 | `sync:once` | nothing pushed or pulled |
| 4 | `gog -a "$GOG_ACCOUNT" calendar update <id> <event id> --from=... --to=...`, then `sync:once` | pulls 1 |
| 5, 6 | `sync:once` | nothing; no conflicts, nothing quarantined |

A round that must skip something exits non-zero and holds the cursor.

## 5. Report and clean up

```sh
SOAK_REPORT_PATH=$HOME/soak-report.json pnpm run sync:soak-report --since 7d   # PASSED, 6 rounds
gog -a "$GOG_ACCOUNT" calendar delete-calendar <id>          # the throwaway only
```

`sync:soak-report` exits 1 when no report exists; that is correct and is never faked.

## 6. A named calendar

Only after the above, and only for a calendar the owner names: register it, add its
`(calendar_id, operation)` pairs to the SyncPolicy allowlist, run rounds by hand, then
install interval jobs (`docs/hosting.md`). Interval jobs generated without `--live` are
dry-runs and record no soak rounds; only live rounds do.
