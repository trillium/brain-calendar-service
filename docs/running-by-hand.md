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

**2. Prove the MCP server speaks the protocol.** No credentials. It needs the Dolt
server from step 3 running; it creates and drops its own throwaway database.
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
The write is read back through two different tools, against a real Dolt database
(see [L1](#l1-no-tool-reads-or-writes-the-database)).

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
  observed provider calls: none
  dolt head unchanged: true

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

As of this commit the only operation that writes to a calendar is the live
`sync:once` push, which creates and updates events on one registered calendar and
has only run against the fake gog. See [L3](#l3-the-push-path-exists-but-has-only-run-against-a-fake-gog-partly-resolved).

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

{"proposed":true,"date":"2026-04-01","zone":"America/New_York","firstOccurrenceUtc":"2026-04-01T13:00:00.000Z","items":1}

{"grain":"day","zone":"America/New_York","periods":[{"grain":"day","startUtc":"2026-04-01T13:00:00Z","endUtc":"2026-04-01T13:15:00Z","summary":"standup"}]}
```
09:00 in New York on 1 April 2026 resolved to 13:00Z, correct for EDT, and the
`query_period` call in a second process read it back from Dolt. These two calls
ran against a throwaway database; run against the default one, `mcp:call` writes
to `brain_calendar_service` (set `CALENDAR_DB_NAME` to point it elsewhere), and
each write is a Dolt commit.

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
| A Google account signed in through `gog auth add` | **human-supplied** | not done |
| The calendar id to point at | **human-supplied** | not done |
| Permission to write to that calendar | **human-supplied** | not done |

Provider credentials never enter this repo: the gog CLI owns Google OAuth and
token storage. The provider reads `GOG_ACCOUNT` (the address passed to gog as
`-a`) and optionally `GOG_BIN`; the other environment variables read are
`CALENDAR_DB_HOST`, `CALENDAR_DB_PORT`, `CALENDAR_DB_NAME`, `CALENDAR_DB_USER`,
`CALENDAR_DB_PASSWORD`, and `CANON_ROOT`. See [L4](#l4-there-is-no-credential-plumbing).

## What this does not prove

Found by running it, not by reading the tests. Each of these is invisible to the
104 green tests.

### L1: no tool reads or writes the database (RESOLVED)

Fixed: the tools now go through the `Store` port in `src/mcp/store.ts`, whose only
implementation is `src/adapters/dolt/mcp-store.ts`. Periods live in
`calendar_period`, links in `calendar_binding` and quarantine in
`calendar_conflict`, in the database named by `CALENDAR_DB_*`. Every write is
committed to Dolt history so change detection sees it. `src/mcp/persistence.test.ts`
runs each step in a fresh server process to prove state survives the process.
`mcp:smoke` now runs against a throwaway database so reruns start empty.

The original finding, kept for the record: the tools read and write an in-process
`Store` that starts empty, so `query_period` always returned `"periods":[]`.

### L2: `list_changes` fails on every input (RESOLVED)

Fixed in `4edba70`: the handler now parses its arguments against the object
schema. Original finding: any object failed with `Invalid input`, because the
handler parsed the whole arguments object against a schema for a single string.

### L3: the push path exists but has only run against a fake gog (PARTLY RESOLVED)

`sync:once` without `--dry-run` now resolves `--calendar` through the
`calendar_calendar` registry (`pnpm run calendar:register --remote-id <id> --name
<label>`), builds the gog provider from `GOG_ACCOUNT` (and `GOG_BIN`), creates or
updates one event per changed `calendar_period` on that registered calendar only,
records a `calendar_binding` with a minted ownership token as a Dolt commit, and
advances the cursor only after every push succeeded. Nothing is ever deleted. It
is proven against `fixtures/gog/fake-gog.mjs` only; pull from the provider and
self-echo handling are not built, so an edit made on the provider is not read back.
A calendar with no cursor is baselined to the current Dolt head on its first live
run, so a period must be proposed after that first run to be pushed.

### L4: the gog provider has never run against a live account

Credentials are gog's job, so there is no token code to write here. What is
missing is a login: `gog auth list` showed no stored tokens, so the provider is
proven only against `fixtures/gog/fake-gog.mjs`. Run `gog auth add` for a
dedicated test calendar, then check the real JSON shapes against the fake's.

### L5: running the test suite dirties tracked files

`src/domain/rfc5546/emit-artifact.test.ts` rewrites
`evidence/stage-02/artifact.json` in a different format from the committed copy.
After `pnpm run test -- --run`:
```
 M evidence/stage-02/artifact.json
```
and `pnpm run lint` then exits 1 on that file. Restore it with
`git checkout -- evidence/stage-02/artifact.json` before committing. Other suites
have left `.dolt/noms/journal.idx` modified the same way.

### L6: scoped test commands do not narrow

`pnpm run test -- src/adapters/gog --run` runs all 104 tests, not the 18 in
that directory. pnpm forwards the `--`, and vitest then treats the filter as
free text:
```
$ npx vitest -- src/adapters/gog --run   ->  Test Files 10, Tests 104
$ npx vitest   src/adapters/gog --run     ->  Test Files  1, Tests  18
```
This is recorded in `evidence/stage-10/skips.md`. It makes every scoped stage
gate in `canon-profile.json` a whole-suite run: stricter than intended, not
looser. `npx vitest <path> --run` is the form that narrows.

## More tests worth running

All six were run on this branch and all six passed.

```sh
pnpm run test -- --run                              # 104 tests, 10 files
pnpm run db:verify                                  # 6 tables, 51 columns, 15 indexes
pnpm run sync:measure --scenario realistic --assert-under 250
pnpm run sync:replay fixtures/replay-a --rounds 5
pnpm run sync:converge --scenario loop --rounds 5
pnpm run rollout:dry-run --scenario backfill
pnpm run rollout:rollback-drill
```

What each one actually showed:

- `sync:measure` names a winner rather than a total: it prints a per-subcommand
  breakdown and which gog subcommand dominated, against a budget of 250. It
  counts gog invocations against a fake gog executable; set `GOG_BIN` and
  `GOG_ACCOUNT` to measure a real one.
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
A soak needs the credential work in L4 and an apply path in L3 before it can be
run at all; supplying credentials alone will not make this command pass.

## To finish this

In order, and none of them are a task for this document:

1. ~~Fix `list_changes` (L2).~~ Done.
2. ~~Give the tools a real store (L1).~~ Done: the tools read and write Dolt.
3. ~~Build the push apply path (L3).~~ Done against the fake gog; pull is next.
4. Log gog in for a test calendar and verify the provider live (L4).
5. Only then point it at a calendar a human has named, and soak it.