# Loop and duplicate prevention

## What it is
The mechanics above the transport: a deny-by-default write policy where an
out-of-policy write is unrepresentable and an unowned delete cannot be expressed;
an operation journal keyed by idempotency key; a retry policy that never retries a
non-idempotent write; and the loop breaker that drops a verbatim provider echo.

## How to drive it
```sh
pnpm run sync:converge --scenario loop --rounds 5
pnpm run test -- src/sync/loop --run
```

## What it should produce
`converged: true`, a fixpoint round, no residual duplicates, and — on every idle
round — a non-zero `selfEchoDropped`. If an idle round reports zero drops and
zero writes, the loop breaker is not seeing its own writes.

## What breaks if it breaks
The same events are created nightly. This is the stage that exists because a sync
system without a proof of convergence is indistinguishable from one that
duplicates events.
