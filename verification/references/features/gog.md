# gog provider and Google limits

## What it is
Transport only - never recurrence. The provider shells out to the gog CLI
(`gog calendar events|raw|create|update|delete`, JSON output) for every calendar
read and write, behind the `CalendarProvider` interface. The account address is
configuration (`GOG_ACCOUNT`), never a literal. Google's silent
private-property limits are enforced **before** gog is invoked, as is Google's
two-valued delete. There is no CalDAV transport and no direct Google API client.

## How to drive it
```sh
pnpm run test -- src/adapters/gog --run
pnpm run sync:measure --scenario realistic --assert-under 250
```
Tests run against `fixtures/gog/fake-gog.mjs`, a stand-in executable, so no
account is needed. Set `GOG_BIN` and `GOG_ACCOUNT` to measure a real gog.

## What it should produce
Contract tests green against the fake executable: argv shape, JSON validation,
exit-code failures surfaced as `GogError`, writes refused outside the
`SyncPolicy` without gog being spawned. `sync:measure` prints a per-subcommand
breakdown and names what dominated it.

## What breaks if it breaks
A private-property key over 44 characters is dropped by Google **without an
error**. That marker is what makes writes idempotent, so a dropped key means
duplicate events with nothing to report it.

## Known limitation
Live behaviour has been verified once, against one throwaway Google calendar;
see L4 in [running-by-hand.md](../../../docs/running-by-hand.md) for what that
run showed and what reproducing it needs. The default `sync:measure` runs
against the fake.
