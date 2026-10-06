# Rollout and migration

## What it is
The four rollout phases (`shadow` -> `backfill` -> `pull-only` ->
`bidirectional`), a backfill that is idempotent from the first run, and a
rollback drill that measures a real rollback against the disposable Dolt store.

## How to drive it
```sh
pnpm run rollout:dry-run --scenario backfill
pnpm run rollout:rollback-drill
pnpm run test -- src/sync/rollout --run
pnpm run sync:soak-report --since 3d   # S10 entry condition; needs a real soak
```

## What it should produce
The dry-run creating 25 events and then creating **zero** on the second pass.
The drill printing a measured RTO, an RPO in rows, and which phase dominated —
and exiting 0 only after counting the store's rows for real. `sync:soak-report`
exits **non-zero** with no soak report, which is the correct result today.

## What breaks if it breaks
A backfill that is not idempotent becomes a duplicate-event incident on the
first retry, and the second run is exactly where that shows up. A rollback drill
that cannot fail is a belief: it once "passed" while comparing a hardcoded row
count to itself, and it once hung forever because the connection was never
closed. The drill now refuses to run against uncommitted rows rather than
discarding another suite's work.

## Not decided here
Deleting external events this service did not create, and resolving an
individual quarantined conflict, are both human decisions and are represented as
the *absence* of a capability (`mayDelete` is `false` for every phase) rather
than as a flag.