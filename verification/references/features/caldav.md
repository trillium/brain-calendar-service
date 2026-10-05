# CalDAV transport and Google limits

## What it is
Transport only — never recurrence, never a provider decision. RFC 6578
sync-collection including the invalid-token fallback, Google's silent
private-property limits enforced **before** sending, and Google's two-valued
delete.

## How to drive it
```sh
pnpm run test -- src/adapters/caldav --run
pnpm run sync:measure --scenario realistic --assert-under 250
```

## What it should produce
Contract tests green against a real local fixture server, including a 403 on a
stale token followed by a successful re-run with an empty token. `sync:measure`
must print a per-method breakdown and name what dominated it.

## What breaks if it breaks
A private-property key over 44 characters is dropped by Google **without an
error**. That marker is what makes writes idempotent, so a dropped key means
duplicate events with nothing to report it.

## Known limitation
`sync:measure` models the CTag+ETag cost shape; it does not measure Google. The
budget is derived from the model plus 2× headroom per `decision-kax`.
