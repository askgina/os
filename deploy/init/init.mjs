// Creates the stack's secrets on first start and never changes them afterwards. Each trust
// domain gets its own volume, so the server cannot read the signer's key and the signer cannot
// read the keyring. Nothing is printed except file names and whether they were created.
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVER = "/secrets/server";
const SIGNER = "/secrets/signer";
const DB = "/secrets/db";
// Users the services run as: `node` in node:26-slim and `postgres` in postgres:18-alpine.
const NODE_UID = 1000;
const POSTGRES_UID = 70;

const b64 = () => randomBytes(32).toString("base64");

function ensure(dir, name, uid, make) {
  const path = join(dir, name);
  let created = false;
  if (!existsSync(path)) {
    // Write to a temporary name and rename, so a crash never leaves a half-written secret that a
    // later run would keep.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, make(), { mode: 0o400, flag: "w" });
    renameSync(tmp, path);
    created = true;
  }
  chownSync(path, uid, uid);
  chmodSync(path, 0o400);
  chownSync(dir, uid, uid);
  chmodSync(dir, 0o700);
  process.stdout.write(`${JSON.stringify({ event: "secret", file: `${dir}/${name}`, created })}\n`);
}

ensure(SERVER, "keyring.json", NODE_UID, () =>
  JSON.stringify({ active: "k1", keys: { k1: b64() } }),
);
// The request secret is shared: generate it once and copy it, so both sides always agree.
// If only one volume was lost, the surviving copy is reused rather than replaced.
ensure(SERVER, "signer-request-secret", NODE_UID, () => {
  const other = join(SIGNER, "signer-request-secret");
  return existsSync(other) ? readFileSync(other) : b64();
});
ensure(SIGNER, "signer-request-secret", NODE_UID, () =>
  readFileSync(join(SERVER, "signer-request-secret")),
);
// The confirm secret lets the `approve` service reach the signer's two confirmation routes and
// nothing else, so it is never the request secret.
ensure(SIGNER, "confirm-request-secret", NODE_UID, () => b64());
ensure(SIGNER, "token-key", NODE_UID, () => b64());
ensure(SIGNER, "vault-passphrase", NODE_UID, () => b64());
ensure(DB, "postgres-password", POSTGRES_UID, () => {
  const other = join(SERVER, "postgres-password");
  return existsSync(other) ? readFileSync(other) : randomBytes(32).toString("hex");
});
// The server runs as a different user than Postgres, so it gets its own copy.
ensure(SERVER, "postgres-password", NODE_UID, () => readFileSync(join(DB, "postgres-password")));

// The signer's data volume starts out owned by root; the signer runs as `node`.
const SIGNER_DATA = "/data/signer";
chownSync(SIGNER_DATA, NODE_UID, NODE_UID);
chmodSync(SIGNER_DATA, 0o700);
