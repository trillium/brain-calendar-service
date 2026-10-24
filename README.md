# calendar-mcp-service

MCP-facing calendar and temporal-planning service. Beads/Dolt is the authoritative
planning layer; external calendars are two-way synced, not read-only inputs.

This is a greenfield scaffold. Nothing here talks to a calendar yet.

- Plan (11 stages, each with a command-gated exit condition): `brain-lg2t8`
- Canonical project status: `status-ho6`
- Guardrail review folded into the plan: `brain-ujyse`
- Run it yourself, and what it does not yet do: `docs/running-by-hand.md`

## Read this first

`AGENTS.md` is generated from `canon-profile.json` by `scripts/canon-audit.mjs`.
It is the machine-checked answer to: which Canon modules apply and why, what
enforces each binding rule, what each stage's exit command is, and what the
write path refuses. Editing it by hand fails `canon:audit`.

## Stage 0 exit test

```
pnpm install --frozen-lockfile && pnpm run type-check && pnpm run lint \
  && pnpm run test -- --run && pnpm run health && pnpm run canon:audit
```

## License

MIT. See `LICENSE`.
