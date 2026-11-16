import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

/**
 * The Postgres server that tests may create databases on. `bun run services:up` starts one at
 * the default address; CI and other setups point `TEST_POSTGRES_URL` at their own.
 */
export const TEST_POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres";

export interface TestDatabase {
  /** Connection string of the new, empty database. */
  url: string;
  /** Remove the database. Close every pool that uses it first. */
  drop(): Promise<void>;
}

/** Create an empty database with a unique name, so test files never see each other's rows. */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const name = `test_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_POSTGRES_URL });

  try {
    await admin.connect();
  } catch (cause) {
    throw new Error(
      `cannot reach the test Postgres at ${new URL(TEST_POSTGRES_URL).host}; run \`bun run services:up\` or set TEST_POSTGRES_URL`,
      { cause },
    );
  }

  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;

  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: TEST_POSTGRES_URL });
      await client.connect();

      try {
        // A `pg` pool reports itself ended before its connections have finished closing.
        // Dropping the database under one of those makes the server end it with a FATAL
        // message, which surfaces as an unhandled error in the test process. Give closing
        // connections a moment to leave; FORCE then removes whatever a test really leaked.
        const deadline = Date.now() + 5_000;

        for (;;) {
          const { rows } = await client.query<{ open: number }>(
            "SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1",
            [name],
          );

          if ((rows[0]?.open ?? 0) === 0 || Date.now() > deadline) break;
          await delay(25);
        }

        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
