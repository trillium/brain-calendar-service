# S10 skip ledger (R13)

skip: **S10's entry condition is not satisfied.** `pnpm run sync:soak-report
--since <N>d` exits non-zero because `evidence/soak/report.json` does not exist,
and nothing an unattended run can produce will create it: a soak means this
service running against a real external calendar for a defined period, which
needs live provider credentials this environment does not have. The stage's EXIT
condition does not include the soak, and it is green. This is recorded rather
than worked around, and `sync:soak-report` is built to fail loudly so a future
run cannot mistake an absent soak for a passed one.

skip: **No soak report was faked and no synthetic report was written.** A
fabricated `evidence/soak/report.json` would have turned the entry condition
green and made every later stage's evidence rest on invented numbers.

skip: **The rollback drill measures, it does not assert.** RTO (13-23 ms here)
and the dominant phase (checkout, 77-85%) are recorded as machine-dependent
observations. No threshold is asserted, because a rollback that is slower on
another machine is a fact, not a regression.

skip: **Two human-pausing actions are represented as the absence of a
capability rather than as a flag.** `mayDelete` is `false` for every phase and
`deletesFromProvider` is `false` in every rights record, so no phase transition
can grant delete; and `calendar_conflict` has no exit path. Both are decided by
the absence of code, so there is no decision left for an operator to get wrong.
The underlying human decisions themselves - destructive cleanup of pre-existing
external events, and per-item resolution of a quarantined conflict - remain
fenced and untouched.

skip: **The drill refuses to run against a store holding uncommitted rows**
rather than rolling back over them. That makes the exit command fail on a store
another suite left dirty, which is the correct trade: the drill is the thing
that discards uncommitted work, so it should be the thing that declines to.
Finding that refusal firing was how the shared-substrate defects below were
found — the suites, not the drill, were the writer.

skip: **The dirty check reads the `dolt_diff` summary, not the per-table row
diffs.** Dolt keeps a row-diff entry for a row that was inserted and deleted
inside the working set, so the row diffs stay non-empty after a suite that
round-trips a row, while the store is in fact identical to HEAD. It is also not
`dolt_status`, which stays permanently "modified" because an advanced
AUTO_INCREMENT counter is a working-set schema change.

skip: **`schema.test.ts` was moved off a hardcoded instant that another suite
commits.** It used `2027-01-01 00:00:00`, the exact instant S4's replay writes
into the shared `calendar_period` table, so the suite went red on any store
carrying that committed row. It now uses an instant outside every fixture range
in the repo.

skip: **`changedetection.test.ts` had its Dolt commits scoped to its own probe
table.** It ran `DOLT_ADD('.')` then `DOLT_COMMIT('-Am', ...)`, which stages and
commits *every* modified table in the store, so a parallel suite's uncommitted
rows were swept into its history and then deleted — leaving the store
permanently dirty and making `schema.test.ts` order-dependent. This is the S5
class of defect again, one level up: owning the substrate is not enough, the
commit has to be scoped to it too.

skip: **`scripts/start-local-dolt.sh` now runs `dolt init` from inside the data
directory.** `dolt init` also resolves against the current directory, and this
repo's root holds a `.dolt`, so a fresh clone could never start its own server
and the failure looked like a corrupt data directory.

skip: **The disposable store was rebuilt from scratch** (`rm -rf .local-dolt`,
restart, `db:migrate`) to clear months of cross-suite pollution committed by the
`-Am` bug. That is why the recorded checkpoint row count is 0 rather than the 1
the polluted store held. This is the S5 order-dependence class again, fixed at the cause
rather than papered over.

skip: **`pnpm run test -- src/sync/rollout --run` does not narrow to the rollout
suite.** Vitest runs all 104 tests. Recorded because a reader may assume only
the rollout suite ran; it is a stricter gate than intended, not a looser one.

skip: **`.cspell/project-words.txt` gained one word, `uids`.** The plural of the
existing `uid`, needed by `BackfillResult.createdUids`.