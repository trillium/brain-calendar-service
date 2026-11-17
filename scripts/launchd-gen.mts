#!/usr/bin/env tsx
// launchd:gen - write the launchd plists for an always-on host. Writes files only;
// it never runs launchctl and never touches ~/Library/LaunchAgents. Installing is a
// human step (docs/hosting.md).
//
//   pnpm run launchd:gen --out ~/brain-calendar-launchd --account me@example.com \
//     --token-file ~/.config/brain-calendar/mcp-token --calendar 1 [--live]
//
// Without --live the sync jobs run `sync:once --dry-run`: they read the calendar and
// write nothing. --live is the switch that lets a job write to a calendar.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildJobs, type HostConfig } from "../src/hosting/launchd.ts";

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const all = (name: string) =>
  args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1] as string] : []));
const one = (name: string, fallback?: string): string => {
  const found = all(name)[0] ?? fallback;
  if (found === undefined) {
    console.error(`launchd:gen: --${name} is required`);
    process.exit(2);
  }
  return found;
};

const home = homedir();
const nodeBin = dirname(process.execPath);
const config: HostConfig = {
  labelPrefix: one("label-prefix", "com.brain-calendar"),
  repoDir: resolve(one("repo", process.cwd())),
  binDirs: all("bin-dir").length > 0 ? all("bin-dir") : [nodeBin, "/opt/homebrew/bin"],
  doltDataDir: resolve(
    one("dolt-data-dir", join(home, "Library/Application Support/brain-calendar/dolt")),
  ),
  doltPort: Number(one("dolt-port", "3399")),
  mcpPort: Number(one("mcp-port", "3398")),
  mcpTokenFile: resolve(one("token-file")),
  gogEnvFile: resolve(one("gog-env-file", join(home, ".config/gog/env"))),
  gogAccount: one("account"),
  logDir: resolve(one("log-dir", join(home, "Library/Logs/brain-calendar"))),
  calendars: all("calendar"),
  syncIntervalSeconds: Number(one("interval", "300")),
  live: has("live"),
};

const out = resolve(one("out"));
mkdirSync(out, { recursive: true });
for (const job of buildJobs(config)) {
  writeFileSync(join(out, job.fileName), job.plist);
  console.log(`wrote ${join(out, job.fileName)}`);
}
console.log(config.live ? "sync jobs: LIVE (they write)" : "sync jobs: dry-run (read-only)");
