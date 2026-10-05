// db:migrate - apply this project's Dolt migrations to its OWN store.
//
// Deliberately not a bd command and deliberately not touching the bd-owned
// schema (decision-4wh). Each migration file was numbered by
// scripts/next-migration.sh --reserve, which is Canon's flock-based allocator
// and the mechanism that makes parallel agents safe against each other.
//
// Applied migrations are recorded in dolt history, not in a local bookkeeping
// file. A migration that is not committed is not applied, and a store whose
// history was GC'd re-applies, which is the correct behaviour rather than a
// silent skip.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "mysql2/promise";
import { config, ROOT } from "../src/adapters/dolt/config.mjs";

const migrationsDir = join(ROOT, "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Connect without a database: it may not exist yet. This is the whole reason
// CREATE DATABASE cannot live in the same connection as the migration.
const bootstrap = await createConnection({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
});
try {
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\``);
} finally {
  await bootstrap.end();
}

const conn = await createConnection({ ...config, multipleStatements: true });
try {
  await conn.query(`USE \`${config.database}\``);

  const [log] = await conn.query("SELECT message FROM dolt_log");
  const applied = new Set(log.map((r) => r.message));

  for (const file of files) {
    const name = file.replace(/^\d+_/, "").replace(/\.sql$/, "");
    const marker = `migration: ${name}`;
    if (applied.has(marker)) {
      console.log(`skip   ${file} (already in dolt history)`);
      continue;
    }
    console.log(`apply  ${file}`);
    await conn.query(readFileSync(join(migrationsDir, file), "utf8"));
    await conn.query("CALL DOLT_ADD('.')");
    await conn.query("CALL DOLT_COMMIT('-m', ?)", [marker]);
  }

  const [tables] = await conn.query("SHOW TABLES");
  console.log(`db:migrate done against ${config.database}: ${tables.length} tables`);
} finally {
  await conn.end();
}
