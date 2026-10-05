// db:verify - assert the live store matches the schema this repo claims.
//
// S1's exit condition is deliberately not mockable: a schema that only exists
// in a fixture proves nothing, because the whole risk at this stage is that Dolt
// and MySQL-compatible SQL disagree about something. So this asserts against a
// REAL Dolt server, every column and every index by name, and additionally
// asserts the load-bearing columns the plan singles out - the ones whose absence
// would silently break the conflict, cursor, and ownership semantics later.

import { createConnection } from "mysql2/promise";
import { config } from "../src/adapters/dolt/config.mjs";
import { LOAD_BEARING_COLUMNS, TABLE_NAMES, TABLES } from "../src/adapters/dolt/schema.mjs";

const failures = [];
const checked = { tables: 0, columns: 0, indexes: 0 };

const conn = await createConnection(config);
try {
  const [tableRows] = await conn.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = ?",
    [config.database],
  );
  const present = new Set(tableRows.map((r) => r.table_name ?? r.TABLE_NAME));

  for (const name of TABLE_NAMES) {
    if (!present.has(name)) {
      failures.push(`missing table ${name}`);
      continue;
    }
    checked.tables += 1;

    const [cols] = await conn.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
      [config.database, name],
    );
    const columnNames = new Set(cols.map((r) => r.column_name ?? r.COLUMN_NAME));
    for (const col of TABLES[name].columns) {
      if (!columnNames.has(col)) failures.push(`${name}: missing column ${col}`);
      else checked.columns += 1;
    }
    for (const col of LOAD_BEARING_COLUMNS[name] ?? []) {
      if (!columnNames.has(col)) {
        failures.push(`${name}: load-bearing column ${col} is missing`);
      }
    }

    const [idx] = await conn.query("SHOW INDEX FROM ??", [name]);
    const indexNames = new Set(idx.map((r) => r.Key_name ?? r.KEY_NAME));
    for (const key of TABLES[name].indexes) {
      if (!indexNames.has(key)) failures.push(`${name}: missing index ${key}`);
      else checked.indexes += 1;
    }
  }

  for (const name of present) {
    if (!TABLE_NAMES.includes(name)) failures.push(`unexpected table ${name} in the store`);
  }
} finally {
  await conn.end();
}

console.log("db:verify");
console.log(`  database: ${config.database}`);
console.log(`  tables checked:   ${checked.tables}/${TABLE_NAMES.length}`);
console.log(`  columns checked:  ${checked.columns}`);
console.log(`  indexes checked:  ${checked.indexes}`);

if (failures.length > 0) {
  console.error("\ndb:verify FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("db:verify PASSED");
