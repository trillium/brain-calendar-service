// A throwaway Dolt database per test file, so the MCP tests exercise the real
// store without touching the working set of the shared development database.
// The server is the same disposable one the rest of the suite uses.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "mysql2/promise";
import { config, ROOT } from "../adapters/dolt/config.mjs";

export interface TestDatabase {
  readonly name: string;
  drop(): Promise<void>;
}

const server = {
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
};

export const createTestDatabase = async (): Promise<TestDatabase> => {
  const name = `mcp_test_${process.pid}_${randomBytes(3).toString("hex")}`;
  const conn = await createConnection({ ...server, multipleStatements: true });
  try {
    await conn.query(`CREATE DATABASE \`${name}\``);
    await conn.query(`USE \`${name}\``);
    const dir = join(ROOT, "migrations");
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await conn.query(readFileSync(join(dir, file), "utf8"));
    }
  } finally {
    await conn.end();
  }
  return {
    name,
    drop: async () => {
      const c = await createConnection(server);
      try {
        await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await c.end();
      }
    },
  };
};

/** A direct connection to the test database, for assertions that bypass the store under test. */
export const openDirect = (database: string) =>
  createConnection({ ...config, database, dateStrings: true });
