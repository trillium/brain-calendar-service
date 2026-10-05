# Verification skill — brain-calendar-service

**Read one feature file for the change under test, not this whole file.** A wiki
is fine for humans; agents pay for every token they reread. This exists so a run
with a cold context knows what the features are and how to reach them.

Six sections, always in this order: Launch, Doctor, Drive, Evidence, Cleanup, Helpers.

---

## Launch

```sh
bash scripts/start-local-dolt.sh start   # disposable Dolt on 127.0.0.1:3399
```

Nothing else needs starting. There is no provider, no credential, and no network
in any of these steps. The disposable Dolt server is deliberately not the
fleet-shared one on 3307.

## Doctor

```sh
pnpm run type-check && pnpm run lint && pnpm run health && pnpm run canon:audit
pnpm run db:verify        # the live store matches the declared schema
pnpm run size:check       # the 250-line guard, as a merge condition
```

`canon:audit` failing means this repo has silently drifted from Canon. That is a
CI failure by design, not an opinion.

## Drive

One file per domain area under `references/features/`, each with four headings:
what it is, how to drive it, what it should produce, what breaks if it breaks.
Start at `references/features/README.md` — it is the regression sweep order.

Whole-plan gate, when you need everything at once:

```sh
pnpm run test -- --run && pnpm run sync:converge --scenario loop --rounds 5 \
  && pnpm run mcp:smoke && pnpm run sync:measure --scenario realistic
```

## Evidence

Each stage commits a diffable artifact under `evidence/stage-NN/`. **An exit code
is not evidence.** Read the artifact, and read the numbers it carries — not just
the pass.

The two artifacts worth trusting most are `evidence/stage-02/artifact.json` (the
RFC 5546 decision table and the totals behind it) and
`evidence/stage-03/artifact.json` (the timezone gate, including the premise it
falsified).

## Cleanup

```sh
bash scripts/start-local-dolt.sh stop
rm -rf .local-dolt   # the disposable store; nothing outside this repo is touched
```

If a Dolt run leaves the shared server mid-transaction, that is a defect to
report, not something to clean up from here. Never touch the fleet-shared server.

## Helpers

| helper | what it is |
|---|---|
| `pnpm run canon:audit --write` | regenerates `AGENTS.md` from `canon-profile.json` |
| `pnpm run build:timezones:check` | proves the pinned timezone table is byte-identical to a fresh build |
| `pnpm run gen:dolt-types` | regenerates row types from the declared schema |
| `pnpm run db:server` / `:stop` | the disposable Dolt server |
| `pnpm run sync:once --calendar cal-1 --dry-run --json` | one cycle, planned, written nowhere |

## Drift rule

Any change touching a domain area updates that area's feature file **in the same
commit**. A feature map that drifts is worse than none, because it sends an agent
confidently in the wrong direction.
