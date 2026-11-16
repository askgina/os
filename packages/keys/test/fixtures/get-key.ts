// A separate process asking for one data key, for the cross-process tests. Prints the key in hex
// so the test can compare what independent processes received; test keys only.
import pg from "pg";
import { DataKeyStore, LocalKeyring } from "../../src/index.ts";

const { DATABASE_URL, KEYRING_FILE, SCOPE, KEY_ID } = process.env;

if (!DATABASE_URL || !KEYRING_FILE || !SCOPE || !KEY_ID) throw new Error("fixture env missing");

if (SCOPE !== "run" && SCOPE !== "workspace") {
  throw new Error(`fixture SCOPE must be run or workspace, not ${SCOPE}`);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

const store = new DataKeyStore({
  pool,
  provider: LocalKeyring.fromFile(KEYRING_FILE),
  cacheTtlMs: 0,
});

const key = await store.getOrCreate(SCOPE, KEY_ID);

process.stdout.write(`${Buffer.from(key).toString("hex")}\n`);

await pool.end();
