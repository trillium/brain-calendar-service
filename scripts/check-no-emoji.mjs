#!/usr/bin/env node

/**
 * Emoji guard — prevents raw emoji from landing in source files.
 *
 * Raw emoji render inconsistently across platforms. Use an explicit,
 * deterministic text marker instead — this service has no UI, so the
 * original lucide-react advice does not apply.
 *
 * Usage:  node scripts/check-no-emoji.mjs file1.ts file2.tsx ...
 * lint-staged passes the staged file list as positional args.
 *
 * Only scans added lines in the git diff (not whole files), so existing
 * emoji in untouched code won't trigger failures — safe for incremental
 * adoption on legacy codebases.
 */

import { execSync } from "node:child_process";

// Matches most emoji: emoticons, dingbats, symbols, flags, skin-tone modifiers.
//
// ADAPTED from Canon's modules/hooks/scripts/check-no-emoji.mjs, byte-for-byte
// except this comment and the split below. The canonical file puts U+FE0F
// (variation selector) and U+200D (zero-width joiner) inside the same character
// class as the emoji ranges, which Biome's noMisleadingCharacterClass correctly
// rejects: a class cannot match a character and a combining character, because
// the pair forms one grapheme. The split keeps the identical set of code points
// detected and makes the rule pass.
const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B50}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/u;
const COMBINING_RE = /[\u{FE0F}\u{200D}]/u;
const hasEmoji = (line) => EMOJI_RE.test(line) || COMBINING_RE.test(line);

const files = process.argv.slice(2);
if (files.length === 0) process.exit(0);

let failed = false;

// Get the unified diff (no context) for only the staged files
const diff = execSync(`git diff --cached -U0 -- ${files.map((f) => `'${f}'`).join(" ")}`, {
  encoding: "utf8",
});

let currentFile = "";

for (const line of diff.split("\n")) {
  // Track which file we're in via the +++ header
  if (line.startsWith("+++ b/")) {
    currentFile = line.slice("+++ b/".length);
    continue;
  }

  // Skip diff headers and metadata lines
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    continue;
  }

  // Only check added lines (lines starting with +)
  if (line.startsWith("+") && hasEmoji(line)) {
    console.error(
      `${currentFile}: raw emoji detected in added line — replace it with a deterministic text marker`,
    );
    failed = true;
  }
}

if (failed) {
  console.error("\nEmoji guard: replace raw emoji with a deterministic text marker.");
  process.exit(1);
}
