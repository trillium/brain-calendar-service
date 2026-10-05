# Recurrence and timezones

## What it is
Expansion over ical.js's recurrence rule only, with all timezone arithmetic done
by a **pinned** offset table rather than the host's tzdata. rrule.js is not used:
its two RFC deviations break the Google wire format.

## How to drive it
```sh
pnpm run build:timezones
pnpm run build:timezones:check
pnpm run test -- src/domain/recurrence --run
```

## What it should produce
37 tests green across four named cases: 09:00 weekly across both US DST
boundaries; an all-day event in a zone whose transition happens at midnight; a
monthly-on-the-31st series; and a RECURRENCE-ID overlay patching exactly one
occurrence. `build:timezones:check` must report the pinned table byte-identical
to a fresh build.

## What breaks if it breaks
Wrong times in a real calendar, silently. The pin exists so a host tzdata update
cannot change what a calendar displays — if the pin is bypassed, that guarantee
is gone and nothing will report it.
