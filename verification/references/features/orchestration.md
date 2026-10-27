# Orchestration and quarantine

## What it is
One cycle for one calendar: read the cursor, detect changed rows on both sides,
resolve each pair, plan, then apply. Quarantine is the only sink for undecidable
edits and has **no exit path**.

## How to drive it
```sh
pnpm run sync:once --calendar cal-1 --dry-run --json | tee /tmp/plan.json
pnpm run sync:verify-plan /tmp/plan.json
pnpm run sync:once --calendar cal-1
```

## What it should produce
The dry-run plan carrying observations — row deltas read back from the store, each
observed table's Dolt working-set hash, the provider calls made, the Dolt head
before and after — all showing nothing happened. The live path exits 0 with
`conflicts_quarantined=0` on a clean calendar.

## What breaks if it breaks
Either the dry-run is not actually inert (and the first real run writes to a
real calendar), or a calendar with no cursor silently diffs nothing and reports
success forever.
