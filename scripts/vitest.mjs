// `pnpm run test -- <filter> --run` must run only <filter>.
//
// pnpm hands the script a literal `--` ahead of the caller's arguments, and
// vitest treats everything after a bare `--` as free text rather than a file
// filter, so a scoped command silently ran the whole suite. The separator is
// dropped here; every other argument reaches vitest untouched.

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((arg, i) => !(arg === "--" && i === 0));
const bin = new URL("../node_modules/vitest/vitest.mjs", import.meta.url).pathname;
const result = spawnSync(process.execPath, [bin, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
