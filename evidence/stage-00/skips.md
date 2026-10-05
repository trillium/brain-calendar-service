# S0 skip ledger (R13)

Sub-steps this stage deliberately did not perform, one line each, with a reason.
A skipped sub-step stays visible. A rule that keeps getting skipped is a rule that
wants a different mechanism, and this file feeds the rule->enforcer table at S9.

skip: @sentry/node was not installed. The errors module is classified partial but the service has no long-running process until S6; installing it now would trip Canon's own unused-deps rule.
skip: src/adapters, src/domain, src/ports, src/sync, src/mcp, src/cli were not created. S0 is the skeleton stage; any domain code in it is by definition wrong (plan S0 "deliberately does not cover").
skip: No Vitest test files were written. The exit test runs vitest against an empty suite, which is why vitest.config.ts sets passWithNoTests. S1 removes that flag with its first real test.
skip: accessibility.yml and e2e.yml were not created. Recorded not-applicable rather than created empty (plan profile, testing and ci rows).
skip: scripts/next-migration.sh was copied but not executed. There are no migrations yet; S1 is the first stage to reserve one.
skip: fast-check was not installed. It is a canon-extension request the plan has not yet made (plan section 9), and an unapproved dependency is not a build decision.
skip: zod was NOT installed even though it is the plan's declared boundary-validation library. Installing an unused dependency at S0 is precisely what the plan says would trip Canon's own unused-deps rule; fallow reported it as an unused dependency and confirmed the judgement. It lands with the first boundary-validated payload.
skip: The "unowned DELETE is unrepresentable" type from binding rule 10 is specified in canon-profile.json and AGENTS.md but has no code behind it yet. There is no writer at S0. The rule becomes real at S5 when the transport write path exists, and S5's tests are what will prove it.
