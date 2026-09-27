import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closePool, getPool } from "../store/db.ts";

const schemaPath = resolve(import.meta.dir, "../store/schema.sql");

async function main() {
  const sql = readFileSync(schemaPath, "utf8");
  const pool = getPool();
  console.log("[migrate] applying", schemaPath);
  await pool.query(sql);
  console.log("[migrate] ok");

  const hypertables = await pool.query(
    `SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`,
  );
  console.log(
    "[migrate] hypertables:",
    hypertables.rows.map((r) => r.hypertable_name).join(", "),
  );

  const tables = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
  );
  console.log(
    "[migrate] tables:",
    tables.rows.map((r) => r.tablename).join(", "),
  );

  await closePool();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
