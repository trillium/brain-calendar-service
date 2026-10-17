# Running the service by hand

Every command below was executed on this branch. Output is copied from the real
run, not reconstructed. Anything that could not be executed here is marked
**UNVERIFIED** and says why.

Read [What this does not prove](#what-this-does-not-prove) before treating a
green run as a working calendar service. It is not one yet, and the reasons are
specific.

## Prerequisites

Already on this machine, verified:

| Tool | Version |
|---|---|
| node | v24.12.0 |
| pnpm | 10.33.0 |
| dolt | 2.1.10 |

No account, key, or login of any kind is needed for anything in the smoke path.

## The smoke path

Six commands, from a fresh clone. Run them in `~/dev/brain-calendar-service`.

**1. Install.**
```sh
pnpm install --frozen-lockfile
```
```
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 561ms using pnpm v10.33.0
```

**2. Prove the MCP server speaks the protocol.** No database, no credentials.
```sh
pnpm run mcp:smoke
```
```
mcp:smoke
  server: brain-calendar-service
  tools: 7
mcp:smoke PASSED: initialize, tools/list, a read tool, a write tool, and a read-after-write over real stdio
```
This spawns the server as a child process and drives it as a real client does.
Treat the last sentence as unproven; see [L1](#l1-no-tool-reads-or-writes-the-database).

**3. Start this project's own Dolt server.** It is disposable and on port 3399,
not the fleet-shared server on 3307.
```sh
bash scripts/start-local-dolt.sh start
```
```
Disposable Dolt listening on 127.0.0.1:3399 (pid 74847)
```

**4. Create and check the store.**
```sh
pnpm run db:migrate && pnpm run db:verify
```
```
skip   1_calendar_service_initial_schema.sql (already in dolt history)
db:migrate done against brain_calendar_service: 6 tables

db:verify
  database: brain_calendar_service
  tables checked:   6/6
  columns checked:  51
  indexes checked:  15
db:verify PASSED
```
On a genuinely fresh store step 4 says `apply` instead of `skip`. Both are fine.

**5. Produce a sync plan and prove it did nothing.**
```sh
pnpm run sync:once --calendar cal-1 --dry-run --json | tee /tmp/plan.json && pnpm run sync:verify-plan /tmp/plan.json
```
```
sync:verify-plan
  push: 0  pull: 0  quarantined: 2
  observed row deltas: {"calendar_period":0,"calendar_binding":0}
  observed provider calls: PROPFIND,REPORT
  git head unchanged: true

sync:verify-plan PASSED: the plan is well-formed AND was not executed
```
On a store with no cursor, `quarantined: 2` is the honest answer, not a failure:
both temporal tables report `no cursor recorded yet`, and the code says so rather
than reporting an empty diff.

**6. Make the first real change, and verify it independently.**
```sh
pnpm run sync:once --calendar cal-1
```
This is the one command in the whole service that writes a durable row. Before
it, `calendar_sync_cursor` is empty; after it, there is one row. Check with a
query that has nothing to do with the script that wrote it:
```sh
node --input-type=module -e '
import { createConnection } from "mysql2/promise";
const c = await createConnection({host:"127.0.0.1",port:3399,database:"brain_calendar_service",user:"root",password:""});
const [r] = await c.query("SELECT calendar_id, last_synced_commit_hash FROM calendar_sync_cursor");
console.log(JSON.stringify(r)); await c.end();'
```
```
[{"calendar_id":1,"last_synced_commit_hash":"svm2qlftdtqr3i9jto8jdub6m1jn1f7r"}]
```
Run that same query before step 6 and it prints `[]`. That difference is the
evidence. Do not take the script's own exit code for it.

Stop the server when you are done:
```sh
bash scripts/start-local-dolt.sh stop
```

## The minimal real calendar operation

As of this commit no operation creates, moves, or deletes an event on a real
calendar. The apply step exists ([L3](#l3-the-apply-step-exists-but-has-no-real-provider)),
but the only `CalendarProvider` it has ever run against is an in-memory fake.

The closest thing that genuinely happens today, and the one worth running first,
is step 6 above: it registers a calendar with the store by writing its sync
cursor, so every later run has a baseline to diff against instead of demanding a
full resync. You can see the difference by hand. On a fresh store, step 5 reports
`"reason": "no cursor recorded yet"` twice. After step 6, run step 5 again and
both entries are gone.

## Calling one tool, on its own

`mcp:call` runs exactly one tool against the real stdio server and prints its
JSON, so it can be pasted into a conversation.
```sh
pnpm run mcp:call -- tools
pnpm run mcp:call -- propose_day '{"zone":"America/New_York","date":"2026-04-01","items":[{"summary":"standup","startLocal":"2026-04-01T09:00:00","minutes":15}]}'
pnpm run mcp:call -- query_period '{"grain":"day","startUtc":"2026-04-01T00:00:00","zone":"America/New_York"}'
```
```
query_period       Query a day, week or month of the plan.  args: [grain, startUtc, zone]
propose_day        Propose a structured day.  args: [zone, date, items]
move_commitment    Move or reschedule a commitment.  args: [beadId, newStartUtc]
link_external      Link a durable record to an external event.  args: [beadId, calendarId, externalUid]
unlink_external    Remove a link to an external event.  args: [beadId, calendarId]
list_changes       Report changes made through a planning interface.  args: []
list_quarantined   Surface quarantined conflicts.  args: []

{"date":"2026-04-01","zone":"America/New_York","firstOccurrenceUtc":"2026-04-01T13:00:00.000Z","items":1}

{"grain":"day","zone":"America/New_York","periods":[]}
```
The `propose_day` line is real work: 09:00 in New York on 1 April 2026 resolved to
13:00Z, correct for EDT. The `query_period` line right below it is the problem.

## Using it from a voice assistant

Register the same stdio entry as an MCP server so it becomes a set of tools you
can ask for by name.
```sh
pi mcp add -l brain-calendar --cwd ~/dev/brain-calendar-service -- npx tsx src/mcp/entry.ts
pi mcp list
```
**UNVERIFIED.** This was not run, because it writes to the Pi MCP configuration
and that is a human decision, not a worker's to take. What was verified is the
half it depends on: `src/mcp/entry.ts` serves a correct handshake under a real
MCP client, because `mcp:call` and `mcp:smoke` both spawn it exactly the way a
client does.

## Credentials and setup

| Needed for | Who supplies it | Status |
|---|---|---|
| node, pnpm, dolt | already installed | verified |
| Disposable Dolt on 3399 | you, with `db:server` | verified |
| A Google or CalDAV account to sync | **human-supplied** | not done |
| Google OAuth client id and secret | **human-supplied** | not wired |
| The calendar id to point at | **human-supplied** | not done |
| Permission to write to that calendar | **human-supplied** | not done |

The second half of that table is not a credentials problem. The token plumbing
now exists (`src/adapters/caldav/auth.ts`, see
[L4](#l4-credential-plumbing-exists-and-has-never-met-a-real-account)) and reads:

| Variable | Meaning |
|---|---|
| `CALENDAR_OAUTH_CLIENT_ID` | OAuth client id |
| `CALENDAR_OAUTH_CLIENT_SECRET` | OAuth client secret |
| `CALENDAR_OAUTH_REFRESH_TOKEN` | the long-lived refresh token |
| `CALENDAR_OAUTH_TOKEN_URL` | optional; defaults to Google's https token endpoint |
| `CALENDAR_OAUTH_FILE` | optional path to a JSON file holding the same fields |

The file must be **outside the repository** and mode **0600**, or loading refuses.
A file is also where a refreshed access token (and a rotated refresh token) is
saved; with environment variables alone, tokens live in memory only. Do not put
any of these in the repo. Nothing in `sync:once` calls this yet, because there is
no provider for it to authorise.

## What this does not prove

Found by running it, not by reading the tests. Each of these was invisible to the
104 green tests that existed when they were found. L1, L2, L3, L4, L5 and L6 are
now addressed below; what each fix does and does not prove is stated with it.

### L1: the MCP tools now read and write Dolt (fixed)

`src/mcp/entry.ts` is the composition root. When any of `CALENDAR_DB_HOST`,
`CALENDAR_DB_PORT` or `CALENDAR_DB_NAME` is set, the tools are backed by
`src/adapters/dolt/store.ts` over `calendar_period` and `calendar_conflict`.
With none set, they fall back to the in-process store, which starts empty and
forgets everything when the process exits. A configured database that cannot be
reached is a fatal start-up error, never a quiet fall back.

```sh
bash scripts/start-local-dolt.sh start && pnpm run db:migrate
CALENDAR_DB_PORT=3399 pnpm run mcp:call -- propose_day '{"zone":"UTC","date":"2026-04-01","items":[{"summary":"standup","startLocal":"2026-04-01T09:00:00","minutes":15}]}'
CALENDAR_DB_PORT=3399 pnpm run mcp:call -- query_period '{"grain":"day","startUtc":"2026-04-01T00:00:00","zone":"UTC"}'
```
The second command is a different process and returns what the first wrote.
`propose_day` previously wrote nothing at all; it now stores one period per
item, resolved to UTC in the given zone. `src/mcp/dolt-store.test.ts` proves it
against the disposable Dolt on 3399 (its own database per run), including a
write made by one spawned stdio server being read by the next.

Limits that remain: `query_period` matches on the UTC date of the start and
ignores `grain`; a commitment is named by its summary (at most 64 characters),
and two items starting at the same instant in one grain replace each other
(`uq_period_grain_start`). `link_external` and `unlink_external` still only
validate and echo; they record no binding. The default port is 3399, never the
fleet server on 3307.

### L2: `list_changes` failed on every input (fixed)

The handler parsed the whole arguments object against a schema for a single
string. It now parses against the declared `ListChanges` object schema, and
`beadId`, which the schema already declared optional, now narrows the result.
`src/mcp/list-changes.test.ts` calls the tool through a real MCP client and
server pair (in-memory transport), and both of its read tests fail without the
fix. Over stdio, `pnpm run mcp:call -- list_changes '{}'` is expected to return
`[]` on an empty store, rather than "Invalid input".

### L3: the apply step exists, but has no real provider

`sync:once` without `--dry-run` now applies the plan (`src/sync/apply/`):

- A push of a `calendar_period` row becomes an INSERT if its bead has no binding
  and an UPDATE if it has one. INSERT is keyed on a uid derived from the bead, so
  a replay after a crash returns the existing event instead of duplicating it. A
  new binding gets an ownership token.
- A pull writes the remote times and sequence onto the bound bead, in Dolt only.
  An event that no bead is bound to is skipped, not invented.
- Both are checked against the `SyncPolicy`. `sync:once` runs under INSERT and
  UPDATE only; anything else is `refused` and the provider is not called.
- A local deletion is **never** carried out. It is quarantined in
  `calendar_conflict` as `local_delete_needs_human`, once, and the provider
  interface has no delete method to call. This holds even if a policy permits
  DELETE. Destructive cleanup of external events is still a human decision.
- Local writes are committed to Dolt, and the cursor advances to that commit only
  if every entry was applied or skipped. A `failed` or `refused` entry holds the
  cursor back so it is planned again. Apply refuses to start over uncommitted
  edits to its tables, because committing them would advance the cursor past
  changes that were never pushed.
- Reported row deltas are now measured (after minus before) rather than the
  constant 0 the script used to print.

`src/sync/apply/apply.test.ts` proves this against a real disposable Dolt on
3399 (each run builds and drops its own database) and an **in-memory fake
provider**. Convergence is asserted: planning again after a clean apply finds
nothing to do.

**What is still missing.** `configuredProvider()` returns `null`: no
`CalendarProvider` for a real calendar is written. So `sync:once` with changes to
apply exits 1 with "no CalendarProvider is configured. Nothing was written",
before any write. That is deliberate. Applying to a stand-in would record
bindings and ownership tokens for events that exist nowhere. A clean calendar
(nothing to apply) still succeeds. **UNVERIFIED:** everything about how a real
CalDAV or Google endpoint behaves under INSERT/UPDATE (ETag and `If-Match`
semantics, uid collisions, rate limits). The pull path is exercised only with a
hand-built plan, because `buildSyncPlan` compares a remote against a copy of
itself and so currently never plans a pull from `sync:once`'s own inputs, which
is also why `sync:once` passes it no remote changes.

### L4: credential plumbing exists and has never met a real account

`src/adapters/caldav/auth.ts` loads the client id, secret and refresh token from
the environment variables above or a 0600 file outside the repo, exchanges the
refresh token for an access token, caches it with a 60 s expiry skew, shares one
refresh between concurrent callers, and persists the refreshed token atomically
at 0600. `fetchTransport` takes an optional authorization source, sends
`Authorization: Bearer ...`, and on a 401 refreshes once and retries once. A 403
is not retried; it remains the sync-token signal. A revoked refresh token
(`invalid_grant`) raises `TokenRefreshError` with `reconsentRequired: true`.
Errors name the missing variable and never print a secret or a response body. A
token endpoint that is plain http to a non-loopback host is refused.

`src/adapters/caldav/auth.test.ts` runs it against a fake token endpoint and a
fake resource server on loopback. Every credential in it is an invented
placeholder.

**UNVERIFIED, all of it against a real account:** that Google accepts this
refresh request as written, the real token response and error shapes beyond
`invalid_grant`, refresh-token rotation, how a real CalDAV endpoint answers a
401, and the OAuth consent flow itself. No mint-from-scratch flow exists; a human
obtains the first refresh token and supplies it.

### L5: running the test suite no longer dirties tracked files (fixed)

`emit-artifact.test.ts` used to rewrite `evidence/stage-02/artifact.json`. It now
writes to a scratch directory and fails if the result differs from the committed
copy, so drift is caught rather than overwritten. To regenerate the committed
evidence on purpose: `pnpm run evidence:emit`.
`src/mcp/test-hygiene.test.ts` runs that suite and asserts `git status` is
unchanged. The tracked `.dolt/` files at the repo root were not modified by any
run on this branch, but no test guards them.

### L6: scoped test commands now narrow (fixed)

`pnpm run test` is `scripts/vitest.mjs`, which drops the literal `--` pnpm
forwards and passes the rest to vitest, so `pnpm run test -- src/adapters/caldav --run`
runs only that directory (2 files, 38 tests) instead of the whole suite. The
stage gates in `canon-profile.json` are therefore real scoped runs now.
`src/mcp/test-hygiene.test.ts` asserts a scoped run executes one file.

## More tests worth running

All six were run on this branch and all six passed.

```sh
pnpm run test -- --run                              # 149 tests, 15 files
pnpm run db:verify                                  # 6 tables, 51 columns, 15 indexes
pnpm run sync:measure --scenario realistic --assert-under 250
pnpm run sync:replay fixtures/replay-a --rounds 5
pnpm run sync:converge --scenario loop --rounds 5
pnpm run rollout:dry-run --scenario backfill
pnpm run rollout:rollback-drill
```

What each one actually showed:

- `sync:measure` named a winner rather than a total: `REPORT dominated on bytes:
  100.0%`, measured 43 requests per sync against a budget of 250. The model is
  CTag plus ETag; it does not measure Google.
- `sync:replay` reached a fixpoint at round 2 with 0 duplicates, and alternated
  1 write, 0 writes, 1 write, 0, 0 across five rounds.
- `sync:converge` wrote 2 events in round 1, dropped both as self-echo in round
  2, and stayed at 0 for the rest.
- `rollout:dry-run` created 25 rows then created 0 on the second run, which is
  what idempotent backfill is supposed to look like.
- `rollout:rollback-drill` returned the store to 0 rows at a measured 13 ms RTO,
  12 rows of RPO.

And the gate that is still open, run to show it failing honestly:
```sh
pnpm run sync:soak-report --since 7d     # exits 1
```
```
  rounds: 0
  conflicts per round: none
  quarantined: 0
sync:soak-report FAILED: no soak report exists.
```
That non-zero exit is correct and should stay that way until a real soak exists.
A soak needs a real `CalendarProvider` (L3) as well as real credentials (L4); the
plumbing for both now exists, but supplying credentials alone will not make this
command pass.

## To finish this

In order, and none of them are a task for this document:

1. Give the tools a real store: read `calendar_period` from Dolt instead of an
   empty in-process array, and write through it (L1).
2. Write a real `CalendarProvider` (CalDAV `PUT` with `If-None-Match: *` for
   create and `If-Match` for update, over `fetchTransport` with the token source)
   and return it from `configuredProvider()` (L3).
3. Supply real credentials and run it against a calendar you do not mind
   changing, which turns every UNVERIFIED above into a finding (L3, L4).
