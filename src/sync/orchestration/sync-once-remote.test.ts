// sync:once's remote read, end to end: the real script, a real disposable Dolt,
// and a loopback server standing in for Google (token endpoint AND Calendar API).
// It proves the plan's providerCalls are what the wire carried, not a label, and
// that a read cannot write: the fake records every method it is sent.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config, ROOT as REPO } from "../../adapters/dolt/config.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const TSX = join(ROOT, "node_modules/.bin/tsx");

let server: Server;
let base: string;
const requests: { method: string; path: string }[] = [];
let scratch: string;

// Its own database: sync:once counts rows before and after, so a sibling test
// file writing to the shared one mid-run would look like a dry-run that wrote.
const DB = `sync_once_remote_${process.pid}`;
let admin: Connection;

beforeAll(async () => {
  admin = await createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });
  await admin.query(`CREATE DATABASE \`${DB}\``);
  const conn = await createConnection({ ...config, database: DB, multipleStatements: true });
  await conn.query(
    readFileSync(join(REPO, "migrations", "1_calendar_service_initial_schema.sql"), "utf8"),
  );
  await conn.query("CALL DOLT_ADD('.')");
  await conn.query("CALL DOLT_COMMIT('--allow-empty', '-m', 'schema')");
  await conn.end();
  scratch = mkdtempSync(join(tmpdir(), "sync-once-remote-"));
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: (req.url ?? "").split("?")[0] });
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      res.end(JSON.stringify({ access_token: "test-access-placeholder", expires_in: 3600 }));
      return;
    }
    if (!(req.url ?? "").startsWith("/calendar/v3/")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { errors: [{ reason: "notFound" }] } }));
      return;
    }
    const at = (hour: number) => ({
      dateTime: `2026-10-01T${String(hour).padStart(2, "0")}:00:00Z`,
    });
    res.end(
      JSON.stringify({
        items: [1, 2, 3].map((n) => ({
          id: `e${n}`,
          summary: "fixture",
          start: at(8 + n),
          end: at(9 + n),
        })),
      }),
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin?.end();
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(scratch, { recursive: true, force: true });
});

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

// Async on purpose: the fake Google lives in THIS process, so a blocking spawn
// would starve it and the child's requests would never be answered.
const run = (script: string, args: string[], extraEnv: Record<string, string>): Promise<Ran> =>
  new Promise((done) => {
    execFile(
      TSX,
      [join(ROOT, script), ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          CALENDAR_DB_HOST: config.host,
          CALENDAR_DB_PORT: String(config.port),
          CALENDAR_DB_NAME: DB,
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: number } | null)?.code;
        done({ status: error ? (typeof code === "number" ? code : 1) : 0, stdout, stderr });
      },
    );
  });

const CREDENTIALS = {
  CALENDAR_OAUTH_CLIENT_ID: "test-client-id-placeholder",
  CALENDAR_OAUTH_CLIENT_SECRET: "test-client-secret-placeholder",
  CALENDAR_OAUTH_REFRESH_TOKEN: "test-refresh-token-placeholder",
};

describe("sync:once --dry-run with a remote read", () => {
  it("records the requests that were sent, counts the events, and verifies as inert", async () => {
    requests.length = 0;
    const once = await run(
      "scripts/sync-once.mts",
      ["--calendar", "cal-1", "--dry-run", "--json"],
      {
        ...CREDENTIALS,
        CALENDAR_OAUTH_TOKEN_URL: `${base}/token`,
        CALENDAR_GOOGLE_BASE_URL: `${base}/calendar/v3`,
      },
    );
    expect(once.status, once.stderr).toBe(0);
    const plan = JSON.parse(once.stdout.slice(once.stdout.indexOf("{")));
    expect(plan.observations.remoteOccurrences).toBe(3);
    expect(plan.observations.providerCalls).toEqual([{ method: "GET", status: 200 }]);

    // The wire agrees with the plan: one token exchange, one calendar GET, nothing else.
    expect(requests).toEqual([
      { method: "POST", path: "/token" },
      { method: "GET", path: "/calendar/v3/calendars/primary/events" },
    ]);

    const file = join(scratch, "plan.json");
    writeFileSync(file, once.stdout);
    const verify = await run("scripts/sync-verify-plan.mts", [file], {});
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain("observed provider calls: GET");
    expect(verify.stdout).toContain("remote read: 3 event(s)");
    expect(verify.stdout).toContain("PASSED");
  });

  it("without credentials reads nothing and says so, rather than inventing calls", async () => {
    requests.length = 0;
    const once = await run(
      "scripts/sync-once.mts",
      ["--calendar", "cal-1", "--dry-run", "--json"],
      {},
    );
    expect(once.status, once.stderr).toBe(0);
    const plan = JSON.parse(once.stdout.slice(once.stdout.indexOf("{")));
    expect(plan.observations.remoteOccurrences).toBeNull();
    expect(plan.observations.providerCalls).toEqual([]);
    expect(once.stderr).toContain("remote read skipped");
    expect(requests).toEqual([]);
  });

  it("fails without printing a secret when the provider refuses the read", async () => {
    const once = await run(
      "scripts/sync-once.mts",
      ["--calendar", "cal-1", "--dry-run", "--json"],
      {
        ...CREDENTIALS,
        CALENDAR_OAUTH_TOKEN_URL: `${base}/token`,
        CALENDAR_GOOGLE_BASE_URL: `${base}/nothing-here`,
      },
    );
    expect(once.status).not.toBe(0);
    expect(once.stderr).toContain("HTTP 404, notFound");
    for (const secret of Object.values(CREDENTIALS)) {
      expect(once.stdout + once.stderr).not.toContain(secret);
    }
    expect(once.stdout + once.stderr).not.toContain("test-access-placeholder");
  });
});
