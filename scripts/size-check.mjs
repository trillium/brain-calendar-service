#!/usr/bin/env node
// size:check - the 250-line guard as a MERGE CONDITION rather than a warning.
//
// Canon ships this guard as a warning. Escalating a warning is allowed; Canon
// does not forbid it, and the plan says this project does. The exemption list is
// .husky/large-files-allowlist.txt - the SAME file the pre-commit hook reads -
// so the two can never disagree about what is exempt. Test files and generated
// files are exempt by Canon's own rules.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../src/adapters/dolt/config.mjs";

const LIMIT = 250;
const ROOTS = ["src", "scripts", "migrations", "fixtures"];
const EXTS = /\.(ts|mts|mjs|js|sql)$/;

// Canon's own exemption classes.
const AUTO_EXEMPT = [/\.(test|spec)\.[cm]?tsx?$/, /\.generated\./, /\.d\.ts$/];

const globToRe = (glob) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

const allowlistFile = join(ROOT, ".husky", "large-files-allowlist.txt");
const allow = readFileSync(allowlistFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map(globToRe);

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXTS.test(entry)) out.push(full);
  }
  return out;
};

const violations = [];
let checked = 0;
for (const root of ROOTS) {
  const dir = join(ROOT, root);
  let files = [];
  try {
    files = walk(dir);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (AUTO_EXEMPT.some((re) => re.test(rel))) continue;
    if (allow.some((re) => re.test(rel))) continue;
    checked += 1;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > LIMIT) violations.push(`${rel}: ${lines} lines`);
  }
}

console.log("size:check");
console.log(`  limit: ${LIMIT} lines (merge condition, not a warning)`);
console.log(`  allowlist: ${allow.length} entr(ies) in .husky/large-files-allowlist.txt`);
console.log(`  files checked: ${checked}`);

if (violations.length > 0) {
  console.error("\nsize:check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("size:check PASSED");
