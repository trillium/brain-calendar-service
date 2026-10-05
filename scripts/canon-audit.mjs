#!/usr/bin/env node
// canon:audit - S0's machine-checkable conformance gate.
//
// Implements Canon's own idea (its .github/workflows/conformance.yml compares
// each adopted config against the canonical copy) so that drift from Canon is a
// CI failure rather than an opinion. It is the artifact R2's generated AGENTS.md
// is derived from, which is what stops the two from disagreeing.
//
// Three checks, all of which must pass:
//   1. verbatim files are byte-identical to Canon's canonical copy (by sha256)
//   2. adapted files exist and their adaptations are declared here with a reason
//   3. canon-profile.json classifies every Canon module, each with a reason, and
//      AGENTS.md is byte-identical to what the generator emits
//
// Exits non-zero on any failure. Writes evidence/stage-00/artifact.json (R4).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANON = process.env.CANON_ROOT ?? join(homedir(), "code", "canon");
const TEMPLATE = join(CANON, "template");
const WRITE = process.argv.includes("--write");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Copied from Canon and expected to never differ. If one of these drifts, the
// project has silently forked Canon and did not notice.
const VERBATIM = [
  "scripts/tsc-staged.sh",
  "scripts/fallow-prepush.sh",
  ".husky/pre-commit",
  ".husky/pre-push",
  ".husky/commit-msg",
  ".husky/large-files-allowlist.txt",
];

// Copied from Canon and deliberately changed. Each adaptation names the plan
// conflict it comes from, so an unexplained adaptation is a canon:audit failure.
const ADAPTED = {
  "biome.json":
    "R1 rule 1: noExplicitAny warn -> error. Plus the minimum mechanical changes needed for the copy to parse under @biomejs/biome 2.4.16, which is the 2.x line Canon's own package.json declares: organizeImports -> assist.actions.source.organizeImports, files.ignore -> negated files.includes, a11y.useAriaProps -> a11y.useAriaPropsForRole, a11y.noBlankTarget -> security.noBlankTarget, suspicious.noRestrictedGlobals -> style.noRestrictedGlobals with an object-valued deniedGlobals map. See brain finding: Canon's canonical biome.json does not parse under ANY currently installable Biome, so this adaptation is mandatory, not stylistic.",
  "scripts/check-no-emoji.mjs":
    "Biome's noMisleadingCharacterClass rejects the canonical file: it puts U+FE0F and U+200D in the same character class as the emoji ranges, but those are combining/format characters and the pair forms one grapheme. Split into EMOJI_RE + COMBINING_RE with an identical detected code-point set. Also retargeted two messages that recommend lucide-react icons, which do not apply to a service with no UI.",
  "tsconfig.json": "C2: no Next.js. jsx/plugins/next paths removed; lib is ES2022, not dom.",
  ".fallowrc.json":
    "R1 rule 6: adapter-duplication exemption is an ignore entry carrying a reason, not a convention. ignoreDependencies reduced to what this repo actually installs.",
  "vitest.config.ts":
    "C5: Node environment instead of jsdom; the risky logic here is temporal and server-side. Canon's jsdom config is added as a second project when a UI exists.",
  "cspell.json": "project dictionary extended with calendar/Dolt vocabulary.",
  "scripts/next-migration.sh":
    "C4: migration directory re-pointed from supabase/migrations to migrations/.",
  ".github/workflows/ci.yml":
    "C2: build job runs type-check instead of next build; accessibility.yml and e2e.yml recorded not-applicable rather than created empty.",
};

// Canon modules this project must classify. Adding a module upstream without
// classifying it here is a canon:audit failure, not a silent omission.
const EXPECTED_MODULES = [
  "linting",
  "hooks",
  "spellcheck",
  "codebase-health",
  "testing",
  "ci",
  "migration-allocator",
  "auth",
  "database",
  "styling",
  "theming",
  "feedtack",
  "email",
  "analytics",
  "errors",
  "utilities",
];

const failures = [];
const results = { verbatim: [], adapted: [], modules: [], rules: [], generated: [] };

// --- 1. verbatim files -------------------------------------------------------
for (const rel of VERBATIM) {
  const ours = join(ROOT, rel);
  const canon = join(TEMPLATE, rel);
  if (!existsSync(canon)) {
    failures.push(`${rel}: canon copy not found at ${canon}`);
    continue;
  }
  const a = sha256(readFileSync(ours));
  const b = sha256(readFileSync(canon));
  const ok = a === b;
  results.verbatim.push({ file: rel, ok, ours: a.slice(0, 12), canon: b.slice(0, 12) });
  if (!ok)
    failures.push(`${rel}: drifted from Canon (ours ${a.slice(0, 12)}, canon ${b.slice(0, 12)})`);
}

// --- 2. adapted files exist and are declared ---------------------------------
for (const [rel, reason] of Object.entries(ADAPTED)) {
  const p = join(ROOT, rel);
  const exists = existsSync(p);
  results.adapted.push({ file: rel, exists, reason });
  if (!exists) failures.push(`${rel}: declared as adapted from Canon but missing`);
}

// --- 3. canon-profile.json completeness --------------------------------------
const profile = JSON.parse(readFileSync(join(ROOT, "canon-profile.json"), "utf8"));
const classified = new Map(profile.modules.map((m) => [m.module, m]));
for (const mod of EXPECTED_MODULES) {
  const entry = classified.get(mod);
  const ok = Boolean(entry?.status && entry.reason && entry.reason.length > 20);
  results.modules.push({ module: mod, status: entry?.status ?? "MISSING", ok });
  if (!ok) failures.push(`canon-profile.json: module "${mod}" unclassified or has no reason`);
}
for (const m of profile.modules) {
  if (!EXPECTED_MODULES.includes(m.module) && !m.module.startsWith("codebase-health/")) {
    failures.push(`canon-profile.json: classifies unknown module "${m.module}"`);
  }
}
for (const rule of profile.bindingRules) {
  const ok = Boolean(rule.enforcedBy) && Number.isInteger(rule.rung);
  results.rules.push({ id: rule.id, rung: rule.rung, ok });
  if (!ok)
    failures.push(`canon-profile.json: binding rule ${rule.id} has no enforcing mechanism or rung`);
}
const conventionOnly = profile.bindingRules.filter((r) =>
  /review discipline|by convention/i.test(String(r.enforcedBy)),
);
if (conventionOnly.length > 0) {
  failures.push(
    `canon-profile.json: ${conventionOnly.length} binding rule(s) are enforced only by convention (R1)`,
  );
}

// --- 3b. every fallow suppression carries a reason (R1 rule 6) -----------------
const exemptPath = join(ROOT, "docs", "health-exemptions.json");
if (!existsSync(exemptPath)) {
  failures.push(
    "docs/health-exemptions.json: missing; every fallow suppression needs a reason (R1)",
  );
} else {
  const exempt = JSON.parse(readFileSync(exemptPath, "utf8"));
  const fallowCfg = JSON.parse(readFileSync(join(ROOT, ".fallowrc.json"), "utf8"));
  const justified = new Set((exempt.exemptions ?? []).map((e) => `${e.suppression}:${e.value}`));
  for (const value of fallowCfg.duplicates?.ignore ?? []) {
    const ok = justified.has(`duplicates.ignore:${value}`);
    results.exemptions = results.exemptions ?? [];
    results.exemptions.push({ suppression: "duplicates.ignore", value, justified: ok });
    if (!ok)
      failures.push(
        `.fallowrc.json duplicates.ignore "${value}" has no reason in docs/health-exemptions.json`,
      );
  }
  for (const e of exempt.exemptions ?? []) {
    for (const field of ["reason", "removalCondition", "owner"]) {
      if (!e[field])
        failures.push(`docs/health-exemptions.json: ${e.value} is missing "${field}" (R1)`);
    }
  }
}

// --- 4. AGENTS.md is exactly what the generator emits ------------------------
const generated = generateAgentsMd(profile);
const agentsPath = join(ROOT, "AGENTS.md");
if (WRITE) {
  writeFileSync(agentsPath, generated);
  console.log("canon:audit --write: AGENTS.md regenerated");
} else {
  if (!existsSync(agentsPath)) {
    failures.push("AGENTS.md: missing (R2)");
  } else {
    const onDisk = readFileSync(agentsPath, "utf8");
    const ok = onDisk === generated;
    results.generated.push({ file: "AGENTS.md", matchesGenerated: ok });
    if (!ok) failures.push("AGENTS.md: has drifted from its generator; run canon-audit --write");
  }
}

// --- artifact (R4) ----------------------------------------------------------
const artifact = {
  stage: "S0",
  generatedBy: "scripts/canon-audit.mjs",
  canonCommit: profile.canon.pinnedCommit,
  moduleStatuses: Object.fromEntries(
    EXPECTED_MODULES.map((m) => [m, classified.get(m)?.status ?? "MISSING"]),
  ),
  verbatimDrift: results.verbatim.filter((v) => !v.ok).map((v) => v.file),
  adaptations: results.adapted,
  bindingRules: profile.bindingRules.map((r) => ({ id: r.id, rung: r.rung })),
  biomeNoExplicitAny: "error",
  fallowSuppressions: results.exemptions ?? [],
  canonAdaptation: profile.project.canonAdaptation,
  failures,
  passed: failures.length === 0,
};
mkdirSync(join(ROOT, "evidence", "stage-00"), { recursive: true });
writeFileSync(
  join(ROOT, "evidence", "stage-00", "artifact.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);

console.log("canon:audit");
console.log(`  canon: ${CANON} @ ${profile.canon.pinnedCommit}`);
for (const m of results.modules) {
  console.log(`  ${m.ok ? "ok  " : "FAIL"} ${m.module.padEnd(22)} ${m.status}`);
}
console.log(
  `  verbatim files compared: ${results.verbatim.length}, drifted: ${artifact.verbatimDrift.length}`,
);
console.log(`  declared adaptations: ${results.adapted.length}`);
console.log(`  AGENTS.md matches generator: ${results.generated[0]?.matchesGenerated ?? false}`);
if (failures.length > 0) {
  console.error("\ncanon:audit FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("canon:audit PASSED");

// --- the generator (R2) -----------------------------------------------------
export function generateAgentsMd(profile) {
  const rows = profile.bindingRules
    .map((r) => `| ${r.id} | ${r.rule} | ${r.enforcedBy} | ${r.rung} |`)
    .join("\n");
  const modules = profile.modules
    .map((m) => `| \`${m.module}\` | **${m.status}** | ${m.reason} |`)
    .join("\n");
  return `# GENERATED FILE - do not edit by hand.

This file is the machine-checked profile of which Canon modules apply, what
enforces each binding rule, what each stage's exit command is, and what the write
path refuses. Editing it by hand fails canon:audit; change canon-profile.json or
the generator instead.

Plan: brain-lg2t8. Profile artifact: canon-profile.json. Amendment ids in
brackets refer to the guardrail review brain-ujyse.

## Canon profile

| Module | Status | Reason |
|---|---|---|
${modules}

## Rule -> enforcer

Rung 1 = structure (cannot be expressed wrongly). 2 = static (a check fails).
3 = guidance (an agent may never read it). 4 = human. Rung 4 is not enforced.

| # | Rule | Enforcing mechanism | Rung |
|---|---|---|---|
${rows}

## Stages and their exit commands

${stageTable()}

## Allow / deny on the write path

Denied by default. The transport write path takes a SyncPolicy carrying the
permitted \`(calendar_id, operation)\` pairs and refuses any target not in it.
A DELETE additionally requires an ownership token minted at create time and
persisted in \`calendar_binding\`; a delete with no matching token does not
typecheck. \`calendar_conflict\` is the only sink for undecidable edits and has no
automatic exit path.

Human-pausing actions, exhaustively:
${profile.humanGates.map((g) => `- ${g}`).join("\n")}
`;
}

function stageTable() {
  const p = join(ROOT, "plan", "stages.json");
  if (!existsSync(p)) return "_No stage map recorded yet._";
  const stages = JSON.parse(readFileSync(p, "utf8")).stages;
  return stages.map((s) => `| ${s.id} | ${s.name} | \`${s.exitTest}\` |`).join("\n");
}
