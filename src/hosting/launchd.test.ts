import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildJobs, type HostConfig, HostConfigError } from "./launchd.js";

const base: HostConfig = {
  labelPrefix: "com.example.bcs",
  repoDir: "/srv/bcs",
  binDirs: ["/opt/homebrew/bin"],
  doltDataDir: "/srv/bcs-data/dolt",
  doltPort: 3399,
  mcpPort: 3398,
  mcpTokenFile: "/srv/secrets/mcp-token",
  gogEnvFile: "/srv/secrets/gog-env",
  gogAccount: "me@example.com",
  logDir: "/srv/logs",
  calendars: ["7"],
  syncIntervalSeconds: 300,
  live: false,
};

const job = (config: HostConfig, suffix: string) => {
  const found = buildJobs(config).find((j) => j.label.endsWith(suffix));
  if (!found) throw new Error(`no job ${suffix}`);
  return found;
};

describe("the job set", () => {
  it("is dolt, mcp, and one sync job per calendar", () => {
    const labels = buildJobs({ ...base, calendars: ["7", "cal-9"] }).map((j) => j.label);
    expect(labels).toEqual([
      "com.example.bcs.dolt",
      "com.example.bcs.mcp",
      "com.example.bcs.sync.7",
      "com.example.bcs.sync.9",
    ]);
  });

  it("emits no sync job when no calendar is named", () => {
    expect(buildJobs({ ...base, calendars: [] })).toHaveLength(2);
  });

  it("names each file after its label", () => {
    for (const j of buildJobs(base)) expect(j.fileName).toBe(`${j.label}.plist`);
  });
});

describe("safety defaults", () => {
  it("sync jobs are read-only dry-runs unless live is set", () => {
    expect(job(base, ".sync.7").plist).toContain("<string>--dry-run</string>");
    expect(job({ ...base, live: true }, ".sync.7").plist).not.toContain("--dry-run");
  });

  it("never puts a secret in a plist: only the token file path, never its content", () => {
    const text = buildJobs(base)
      .map((j) => j.plist)
      .join("\n");
    expect(text).toContain("MCP_AUTH_TOKEN_FILE");
    expect(text).not.toMatch(/MCP_AUTH_TOKEN<|GOG_KEYRING_PASSWORD|KEYRING/);
  });

  it("binds the MCP server and Dolt to loopback", () => {
    expect(job(base, ".mcp").plist).toContain("<key>MCP_HTTP_HOST</key><string>127.0.0.1</string>");
    expect(job(base, ".dolt").plist).toContain("<string>-H</string><string>127.0.0.1</string>");
  });

  it("starts argv with env or bash, never a bare program launchd cannot find", () => {
    expect(job(base, ".dolt").plist).toContain("<array><string>/usr/bin/env</string>");
    expect(job(base, ".mcp").plist).toContain("<array><string>/usr/bin/env</string>");
    expect(job(base, ".sync.7").plist).toContain("<array><string>/bin/bash</string>");
  });

  it("sources gog's env file before exec, passing the path as an argument", () => {
    const plist = job(base, ".sync.7").plist;
    expect(plist).toContain("set -a; . &quot;$1&quot;; set +a; shift; exec &quot;$@&quot;");
    expect(plist).toContain("<string>/srv/secrets/gog-env</string>");
  });
});

describe("scheduling", () => {
  it("keeps servers alive and runs sync on an interval", () => {
    expect(job(base, ".dolt").plist).toContain("<key>KeepAlive</key><true/>");
    expect(job(base, ".mcp").plist).toContain("<key>KeepAlive</key><true/>");
    const sync = job(base, ".sync.7").plist;
    expect(sync).toContain("<key>StartInterval</key><integer>300</integer>");
    expect(sync).not.toContain("KeepAlive");
  });

  it("puts the bin dirs on the job's PATH", () => {
    expect(job(base, ".mcp").plist).toContain("/opt/homebrew/bin:/usr/bin:/bin");
  });
});

describe("validation", () => {
  it.each([
    ["a relative repo dir", { repoDir: "bcs" }],
    ["a relative token file", { mcpTokenFile: "token" }],
    ["a relative bin dir", { binDirs: ["bin"] }],
    ["no bin dirs", { binDirs: [] }],
    ["an account that is not an address", { gogAccount: "me" }],
    ["an interval under a minute", { syncIntervalSeconds: 5 }],
    ["a calendar id that is not an id", { calendars: ["1; rm -rf /"] }],
    ["a label with a space", { labelPrefix: "com.example bcs" }],
    ["the same port twice", { mcpPort: 3399 }],
  ])("rejects %s", (_name, override) => {
    expect(() => buildJobs({ ...base, ...override })).toThrow(HostConfigError);
  });

  it("escapes XML metacharacters so a path cannot break out of the plist", () => {
    const plist = job({ ...base, repoDir: '/srv/a&b"<c>' }, ".mcp").plist;
    expect(plist).toContain("/srv/a&amp;b&quot;&lt;c&gt;");
    expect(plist).not.toContain("a&b");
  });
});

describe.skipIf(process.platform !== "darwin")("plutil", () => {
  it("accepts every generated plist as well-formed", () => {
    const dir = mkdtempSync(join(tmpdir(), "launchd-"));
    for (const j of buildJobs({ ...base, calendars: ["7", "cal-9"], live: true })) {
      const file = join(dir, j.fileName);
      writeFileSync(file, j.plist);
      expect(execFileSync("plutil", ["-lint", file], { encoding: "utf8" })).toContain("OK");
    }
  });

  it("rejects a plist this test breaks on purpose, so the check can fail", () => {
    const file = join(mkdtempSync(join(tmpdir(), "launchd-")), "bad.plist");
    writeFileSync(file, job(base, ".mcp").plist.replace("</dict>\n</plist>", "</plist>"));
    expect(spawnSync("plutil", ["-lint", file]).status).not.toBe(0);
  });
});
