# Rollout checklist: first real account

Verified on main at 16f740a (2026-10-17) against the disposable Dolt on port 3399
only. Every provider interaction so far ran against an in-memory fake; the real
provider is UNVERIFIED. The fleet Dolt (3307) was never touched.

Markers: **DONE-verified** (run, passed, this pass), **UNVERIFIED** (not run or
not provable without a real account), **NOT-BUILT** (code gap an agent can close
without credentials), **CAPTAIN-CREDENTIAL** (a captain gate; agents must not do it).

Work stops at the first CAPTAIN-CREDENTIAL step (step 9).

## Ordered steps

| # | Step | Marker | Evidence / command |
|---|---|---|---|
| 1 | Toolchain installed (node, pnpm, dolt) | DONE-verified | `pnpm install --frozen-lockfile` |
| 2 | Start disposable Dolt on 3399 | DONE-verified | `bash scripts/start-local-dolt.sh start` |
| 3 | Apply schema to the disposable store | DONE-verified | `pnpm run db:migrate` then `pnpm run db:verify` (51 columns, 15 indexes, PASSED) |
| 4 | Full test suite | DONE-verified | `pnpm run test -- --run`: 13 files, 141 tests passed |
| 5 | Backfill idempotence | DONE-verified | `pnpm run rollout:dry-run --scenario backfill`: run 1 created 25, run 2 created 0 |
| 6 | Rollback drill | DONE-verified | `pnpm run rollout:rollback-drill`: RTO 12 ms, 12 rows discarded, back to 0 rows. Run it on a clean store (see Known traps). |
| 7 | MCP tools read and write Dolt (limitation L1 in `running-by-hand.md`) | NOT-BUILT | `src/mcp/` holds an in-process `Store`; state does not survive a call |
| 8 | Real `CalendarProvider` returned from `configuredProvider()` (L3, L7) | READ built, WRITE NOT-BUILT | Google Calendar API v3 reader (`src/adapters/gcal/`) is built and fixture-tested; the writer is `null`, and only the in-memory fake has ever run a write |
| 9 | Google OAuth client id and secret | **CAPTAIN-CREDENTIAL** | env `CALENDAR_OAUTH_CLIENT_ID` / `_SECRET`, or a 0600 file outside the repo via `CALENDAR_OAUTH_FILE` |
| 10 | OAuth refresh token for the account | CAPTAIN-CREDENTIAL | `CALENDAR_OAUTH_REFRESH_TOKEN`; plumbing in `src/adapters/caldav/auth.ts` has never met a real account (L4) |
| 11 | Calendar id to sync | CAPTAIN-CREDENTIAL | pick one you do not mind changing |
| 12 | Explicit permission to write that calendar | CAPTAIN-CREDENTIAL | add the `(calendar_id, operation)` pairs to the SyncPolicy allowlist |
| 13 | `sync:once --dry-run` then `sync:verify-plan` against the real calendar (read-only) | UNVERIFIED | needs 8-12 |
| 14 | First real write, with ownership token minted at create | UNVERIFIED | needs 13 and a human-approved plan |
| 15 | Register with the voice assistant | CAPTAIN-CREDENTIAL | `pi mcp add -l brain-calendar --cwd ~/dev/brain-calendar-service -- npx tsx src/mcp/entry.ts`. Handshake itself is verified by `mcp:smoke`; registration is not done. |
| 16 | Run `db:migrate` against the fleet Dolt (3307) | CAPTAIN-CREDENTIAL | AGENTS.md: a schema migration against the fleet-shared Dolt pauses for a human |
| 17 | `pnpm run sync:soak-report` over real runs | UNVERIFIED | needs 14 |

Steps 7 and 8 do not need credentials and should be done before 9, so the first
real run tests the provider and not the plumbing.

## Known traps

1. The rollback drill refuses a dirty store by design. The test suite and the dry-run
   leave uncommitted rows in the disposable store, so the drill failed with
   `uncommitted rows in calendar_conflict` when run after them. Reset the disposable
   store (`call dolt_reset('--hard')` on 3399 only), then run the drill alone.
2. The test run no longer modifies tracked files. Regenerate evidence on purpose
   with `pnpm run evidence:emit`.
3. Never point `CALENDAR_DB_PORT` at 3307 for any of the above.

## Next captain actions (in order)

1. Approve building steps 7 and 8 (or have an agent build them first).
2. Supply the Google OAuth client id and secret (step 9) outside the repo.
3. Name the calendar id and grant write permission (steps 11-12).
4. Run the fleet Dolt migration and `pi mcp add` yourself (steps 15-16).
