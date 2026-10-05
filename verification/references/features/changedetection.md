# Change detection over Dolt history and diff

## What it is
Which rows changed between a stored cursor commit and HEAD, using the
`DOLT_DIFF(from, 'HEAD', table)` table function. RFC 5546 semantics live here in
application code, never in Dolt, whose merge is cell-wise and has no custom merge
functions.

## How to drive it
```sh
pnpm run test -- src/sync/changedetection --run
pnpm run sync:replay fixtures/replay-a --rounds 5
```

## What it should produce
A changed-then-reverted row producing **zero** writes; a non-temporal-only change
producing **zero** calendar writes; a cursor hash absent from history producing a
typed `full_resync_required` rather than a silent empty diff. The replay must
reach a fixpoint with zero duplicates by UID, by private bead id, and by
normalised payload hash.

## What breaks if it breaks
The sync engine either writes events nobody edited, or stops writing entirely
while reporting success. The absent-hash case is the dangerous one: it looks
exactly like "nothing changed".
