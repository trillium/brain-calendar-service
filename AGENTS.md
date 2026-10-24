# GENERATED FILE - do not edit by hand.

This file is the machine-checked profile of which Canon modules apply, what
enforces each binding rule, what each stage's exit command is, and what the write
path refuses. Editing it by hand fails canon:audit; change canon-profile.json or
the generator instead.

Plan: brain-lg2t8. Profile artifact: canon-profile.json. Amendment ids in
brackets refer to the guardrail review brain-ujyse.

## Canon profile

| Module | Status | Reason |
|---|---|---|
| `linting` | **conformant** | Applies verbatim. biome.json copied byte-identical from modules/linting/biome.json with one declared escalation: noExplicitAny warn -> error, because the plan's own rule 1 made 'no any' load-bearing and Canon ships it too weak to stop it. |
| `hooks` | **partial** | Copied verbatim, minus the Next.js-16 middleware.ts/proxy.ts guard, which is guarded by a version check that no-ops here. Emoji guard, gitleaks, and the pnpm lock-file guard all retained. |
| `spellcheck` | **conformant** | cspell over *.{md,mdx,ts,tsx}; project dictionary carries ical, icaljs, caldav, rrule, recurrence, dtstamp, uid, rdates, exdate, dolt, beads, tzid, vtimezone, freebusy, ics, vcs. |
| `codebase-health` | **conformant** | Highest-value module for this project. Circular dependencies and boundary violations as errors is exactly the constraint that stops the sync engine and the transport from entangling. Duplication threshold 8% retained. |
| `codebase-health/duplication` | **conformant, stricter intent** | Threshold 8% semantic retained; the project targets 0% duplication across adapter implementations. The adapter exemption is recorded as an ignore entry carrying a reason, not as a convention (plan rule 6). |
| `testing` | **partial** | Vitest applies and is the primary gate. React Testing Library, jest-dom, Playwright and axe-core are NOT APPLICABLE (headless service) and are deliberately not installed, which would trip Canon's own unused-deps rule. Node-environment project replaces Canon's jsdom baseline; see conflict C5. |
| `ci` | **partial** | Four parallel fast jobs retained; the build job is retargeted per conflict C2 because there is no next build to run. accessibility.yml and e2e.yml are recorded not-applicable rather than created empty. |
| `migration-allocator` | **partial** | Reservation discipline retained; directory re-pointed from supabase/migrations to migrations/ per conflict C4, which the module's own Conflicts clause sanctions. |
| `auth` | **not applicable** | Conflict C3. The service delegates all provider authentication to the gog CLI (Google OAuth lives there), and has no end users; there is no login page and no session proxy. |
| `database` | **not applicable** | Conflict C1. Canon mandates Supabase Postgres server-side; the approved architecture makes Dolt/Beads authoritative and explicitly rejected a second source of truth. Replaced by Dolt schema migrations plus a generated Dolt row-type file (pnpm run gen:dolt-types). At S1 the migration allocator was re-pointed, the schema declared in src/adapters/dolt/schema.mjs, and db:verify + a 10-test round-trip suite run against a real (disposable) Dolt server. |
| `styling` | **not applicable** | No UI in the service. Tailwind, shadcn, CVA and lucide apply in full to a future operator UI, which is a separate project. |
| `theming` | **not applicable** | Same as styling. next-themes needs a React tree this service does not have. |
| `feedtack` | **not applicable** | Same as styling. Worth a stage of its own later if an operator UI is built; the Plan My Day lineage in project-g8dq makes that a real future want, but not now. |
| `email` | **not applicable** | No transactional email. resend and react-email are not installed. |
| `analytics` | **not applicable** | Service, not product surface. posthog is not installed; product analytics belong to a UI, if any. |
| `errors` | **partial** | @sentry/nextjs is not applicable; plain @sentry/node for the daemon is, and lands when a long-running process exists (S6). Source maps and env-aware config apply as written. |
| `utilities` | **conformant** | Zod is load-bearing here, not decorative: every MCP tool input, every external provider payload and every patch_json exception must validate at the boundary. It is NOT installed yet - installing an unused dependency at S0 is exactly what trips Canon's own unused-deps rule - and it lands with the first boundary-validated payload. date-fns is display-only at the edges; ical.js owns all recurrence and timezone arithmetic (conflict C6). |

## Rule -> enforcer

Rung 1 = structure (cannot be expressed wrongly). 2 = static (a check fails).
3 = guidance (an agent may never read it). 4 = human. Rung 4 is not enforced.

| # | Rule | Enforcing mechanism | Rung |
|---|---|---|---|
| 1 | strict TypeScript, no explicit any | tsconfig strict + biome noExplicitAny=error | 2 |
| 2 | no file over 250 lines outside the allowlist | .husky/pre-commit size guard (warn), size:check at S9 (merge condition) | 2 |
| 3 | no file over 100 columns | biome formatter lineWidth=100 | 2 |
| 4 | cyclomatic <= 10, cognitive <= 15 | fallow .fallowrc.json health | 2 |
| 5 | zero circular dependencies, zero boundary violations | fallow circular-dependencies=error, boundary-violations=error | 2 |
| 6 | duplication below 8%, adapter code held to a much lower bar | fallow duplicates.threshold=8 plus a suppression declared in .fallowrc.json and justified with a reason, a removal condition and an owner in docs/health-exemptions.json | 2 |
| 7 | one convention commit per stage, description <= 100 chars | .husky/commit-msg | 2 |
| 8 | nothing built before its stage entry condition; a stage is done when its exit command exits 0 and its evidence artifact is committed | stage template entry check + evidence/stage-NN artifact asserted by the next stage's suite | 2 |
| 9 | no silent degradation: every caught error is a typed state that fails its stage unless allowlisted with reason, expiry and approval | scripts/degradation-allowlist.json | 2 |
| 10 | deny-by-default write path: SyncPolicy allowlist, ownership token required for DELETE, quarantine with no automatic exit | type structure; unowned delete is unrepresentable | 1 |
| HUMAN-ONLY | irreversible actions pause for a human | stage template stop list (4 named actions) | 4 |

## Stages and their exit commands

| S0 | Canon profile, repo skeleton, conformance baseline | `pnpm install --frozen-lockfile && pnpm run type-check && pnpm run lint && pnpm run test -- --run && pnpm run health && pnpm run canon:audit` |
| S1 | Dolt data model and schema migrations | `pnpm run db:migrate && pnpm run db:verify && pnpm run test -- src/adapters/dolt/schema.test.ts --run` |
| S2 | RFC 5546 conflict and sequence semantics as pure functions | `pnpm run test -- src/domain/rfc5546 --run && pnpm run test -- src/domain/rfc5546/properties --run` |
| S3 | Recurrence with exceptions, and the timezone build step | `pnpm run build:timezones && pnpm run test -- src/domain/recurrence --run` |
| S4 | Bidirectional change detection over Dolt history and diff | `pnpm run test -- src/sync/changedetection --run && pnpm run sync:replay fixtures/replay-a --rounds 5` |
| S5 | Loop and duplicate prevention, proven by convergence | `pnpm run sync:converge --scenario loop --rounds 5` |
| S6 | External provider adapters, starting with Google through the gog CLI | `pnpm run test -- src/adapters/gog --run && pnpm run sync:measure --scenario realistic --assert-under <budget>` |
| S7 | Sync orchestration and quarantine | `pnpm run sync:once --calendar <id> --dry-run --json | tee /tmp/plan.json && pnpm run sync:verify-plan /tmp/plan.json` |
| S8 | The TypeScript MCP interface | `pnpm run test -- src/mcp --run && pnpm run mcp:smoke` |
| S9 | Repository-health convergence and unattended-work readiness | `pnpm run size:check && pnpm run health && pnpm run type-check && pnpm run lint && pnpm run test -- --run` |
| S10 | Migration and rollout | `pnpm run rollout:dry-run --scenario backfill && pnpm run rollout:rollback-drill && pnpm run test -- src/sync/rollout --run` |

## Allow / deny on the write path

Denied by default. The transport write path takes a SyncPolicy carrying the
permitted `(calendar_id, operation)` pairs and refuses any target not in it.
A DELETE additionally requires an ownership token minted at create time and
persisted in `calendar_binding`; a delete with no matching token does not
typecheck. `calendar_conflict` is the only sink for undecidable edits and has no
automatic exit path.

Human-pausing actions, exhaustively:
- Destructive cleanup of pre-existing external events.
- Any write to a calendar outside the SyncPolicy allowlist.
- A schema migration against the fleet-shared Dolt server.
- Resolution of a specific quarantined conflict.
