import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** Arbitrary constant; serializes concurrent migrations of the `os` schema. */
const MIGRATION_LOCK = 0x05_0a_77_02;

/**
 * Apply the SQL files in `migrations/` that have not run yet, in name order, each in its own
 * transaction. Safe to call on every start and from several processes at once.
 */
export async function migrateDatabase(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE SCHEMA IF NOT EXISTS os");
    await client.query(
      "CREATE TABLE IF NOT EXISTS os.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM os.migrations");
    const done = new Set(rows.map((row) => row.name));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const name of files) {
      if (done.has(name)) continue;

      // drizzle-kit separates statements with this marker.
      const statements = readFileSync(join(MIGRATIONS_DIR, name), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

      await client.query("BEGIN");

      try {
        for (const statement of statements) await client.query(statement);
        await client.query("INSERT INTO os.migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      applied.push(name);
    }

    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
