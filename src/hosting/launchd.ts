// launchd job definitions for running the service on an always-on Mac.
//
// Pure functions: they turn a HostConfig into plist text and touch no disk and no
// launchd. scripts/launchd-gen.mts writes the files; installing them is a human
// step documented in docs/hosting.md.
//
// argv[0] is /usr/bin/env or bash, never a bare program name: launchd resolves a
// bare name against its own PATH, not the job's, so `pnpm` would not be found.
// env and bash both read the job's PATH, which is built from HostConfig.binDirs.
//
// Three kinds of job:
//   dolt  the service's own Dolt server, restarted if it dies
//   mcp   the bearer-protected HTTP MCP entry, restarted if it dies
//   sync  one job per calendar, run on an interval (not kept alive)
//
// Secrets never appear in a plist. The MCP token is a file path; gog's keyring
// variables are sourced from a file at run time. A plist is readable by anyone
// who can read the user's LaunchAgents directory, so a value placed in one is
// effectively public to that machine.

import { isAbsolute, join } from "node:path";

export interface HostConfig {
  /** Label namespace, e.g. `com.example.brain-calendar`. Reverse-DNS, no spaces. */
  readonly labelPrefix: string;
  /** Absolute path of the repo checkout the jobs run in. */
  readonly repoDir: string;
  /** Absolute directory holding node, pnpm, dolt and gog; becomes the jobs' PATH. */
  readonly binDirs: readonly string[];
  /** Absolute path of the Dolt data directory. */
  readonly doltDataDir: string;
  readonly doltPort: number;
  readonly mcpPort: number;
  /** Absolute path of the 0600 file holding the MCP bearer token. */
  readonly mcpTokenFile: string;
  /** Absolute path of the file that exports gog's keyring variables. */
  readonly gogEnvFile: string;
  /** The Google account address passed to gog. */
  readonly gogAccount: string;
  readonly logDir: string;
  /** Registered calendar ids to sync, one job each. */
  readonly calendars: readonly string[];
  readonly syncIntervalSeconds: number;
  /** Sync jobs only READ and plan unless this is true. */
  readonly live: boolean;
}

interface Job {
  readonly label: string;
  readonly fileName: string;
  readonly plist: string;
}

export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostConfigError";
  }
}

const MIN_INTERVAL_SECONDS = 60;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const CALENDAR_ID = /^(cal-)?[1-9][0-9]{0,17}$/;

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const str = (value: string): string => `<string>${escapeXml(value)}</string>`;

const dict = (entries: Record<string, string>): string =>
  `<dict>${Object.entries(entries)
    .map(([k, v]) => `<key>${escapeXml(k)}</key>${str(v)}`)
    .join("")}</dict>`;

interface PlistSpec {
  readonly label: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly workingDirectory: string;
  readonly stdout: string;
  readonly stderr: string;
  /** `keepAlive` for servers; an interval in seconds for periodic jobs. */
  readonly schedule: "keepAlive" | number;
}

const renderPlist = (spec: PlistSpec): string => {
  const schedule =
    spec.schedule === "keepAlive"
      ? "<key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>"
      : `<key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>${spec.schedule}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(spec.label)}
  <key>ProgramArguments</key>
  <array>${spec.args.map(str).join("")}</array>
  <key>WorkingDirectory</key>${str(spec.workingDirectory)}
  <key>EnvironmentVariables</key>${dict(spec.env)}
  ${schedule}
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key>${str(spec.stdout)}
  <key>StandardErrorPath</key>${str(spec.stderr)}
</dict>
</plist>
`;
};

const requireAbsolute = (name: string, value: string): void => {
  if (!isAbsolute(value)) throw new HostConfigError(`${name} must be an absolute path: ${value}`);
};

const validateHostConfig = (c: HostConfig): void => {
  if (!LABEL.test(c.labelPrefix)) throw new HostConfigError(`bad labelPrefix: ${c.labelPrefix}`);
  for (const [name, value] of Object.entries({
    repoDir: c.repoDir,
    doltDataDir: c.doltDataDir,
    mcpTokenFile: c.mcpTokenFile,
    gogEnvFile: c.gogEnvFile,
    logDir: c.logDir,
  })) {
    requireAbsolute(name, value);
  }
  if (c.binDirs.length === 0) throw new HostConfigError("binDirs must name at least one directory");
  for (const dir of c.binDirs) requireAbsolute("binDirs entry", dir);
  if (!c.gogAccount.includes("@")) throw new HostConfigError("gogAccount must be an address");
  if (c.syncIntervalSeconds < MIN_INTERVAL_SECONDS) {
    throw new HostConfigError(`syncIntervalSeconds must be at least ${MIN_INTERVAL_SECONDS}`);
  }
  for (const id of c.calendars) {
    if (!CALENDAR_ID.test(id)) throw new HostConfigError(`bad calendar id: ${id}`);
  }
  if (c.doltPort === c.mcpPort) throw new HostConfigError("doltPort and mcpPort must differ");
};

const common = (c: HostConfig, name: string) => ({
  workingDirectory: c.repoDir,
  stdout: join(c.logDir, `${name}.out.log`),
  stderr: join(c.logDir, `${name}.err.log`),
});

const baseEnv = (c: HostConfig): Record<string, string> => ({
  PATH: [...c.binDirs, "/usr/bin", "/bin"].join(":"),
  CALENDAR_DB_HOST: "127.0.0.1",
  CALENDAR_DB_PORT: String(c.doltPort),
});

const doltJob = (c: HostConfig): Job => {
  const label = `${c.labelPrefix}.dolt`;
  return {
    label,
    fileName: `${label}.plist`,
    plist: renderPlist({
      label,
      args: [
        "/usr/bin/env",
        "dolt",
        "sql-server",
        "-H",
        "127.0.0.1",
        "-P",
        String(c.doltPort),
        "--data-dir",
        c.doltDataDir,
      ],
      env: baseEnv(c),
      ...common(c, "dolt"),
      schedule: "keepAlive",
    }),
  };
};

const mcpJob = (c: HostConfig): Job => {
  const label = `${c.labelPrefix}.mcp`;
  return {
    label,
    fileName: `${label}.plist`,
    plist: renderPlist({
      label,
      args: ["/usr/bin/env", "pnpm", "run", "--silent", "mcp:http"],
      env: {
        ...baseEnv(c),
        MCP_AUTH_TOKEN_FILE: c.mcpTokenFile,
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: String(c.mcpPort),
      },
      ...common(c, "mcp"),
      schedule: "keepAlive",
    }),
  };
};

// `exec "$@"` after sourcing the env file keeps the keyring variables out of the
// plist and out of the process arguments; bash is the interpreter so the
// `set -a` export form in ~/.config/gog/env behaves as documented.
const SOURCE_THEN_EXEC = 'set -a; . "$1"; set +a; shift; exec "$@"';

const syncJob = (c: HostConfig, calendar: string): Job => {
  const label = `${c.labelPrefix}.sync.${calendar.replace(/^cal-/, "")}`;
  const sync = ["pnpm", "run", "--silent", "sync:once", "--calendar", calendar];
  return {
    label,
    fileName: `${label}.plist`,
    plist: renderPlist({
      label,
      args: [
        "/bin/bash",
        "-c",
        SOURCE_THEN_EXEC,
        "bash",
        c.gogEnvFile,
        ...sync,
        ...(c.live ? [] : ["--dry-run"]),
      ],
      env: { ...baseEnv(c), GOG_ACCOUNT: c.gogAccount },
      ...common(c, `sync-${calendar.replace(/^cal-/, "")}`),
      schedule: c.syncIntervalSeconds,
    }),
  };
};

export const buildJobs = (config: HostConfig): Job[] => {
  validateHostConfig(config);
  return [
    doltJob(config),
    mcpJob(config),
    ...config.calendars.map((calendar) => syncJob(config, calendar)),
  ];
};
