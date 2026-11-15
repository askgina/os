// Creates the stack's secrets on first start and never changes them afterwards. Each trust
// domain gets its own volume, so the server cannot read the signer's key and the signer cannot
// read the keyring. The `approve` service's volume holds only a copy of one signer secret, which
// follows the signer's. Nothing is printed except file names and whether they were written.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SERVER = "/secrets/server";
const SIGNER = "/secrets/signer";
const APPROVE = "/secrets/approve";
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
// The key the server signs its notification webhook with. The operator copies it to the
// receiver; it is used only when NOTIFY_WEBHOOK_URL is set.
ensure(SERVER, "notify-webhook-secret", NODE_UID, () => randomBytes(32).toString("base64url"));
// The key that identifies this server to browsers' push services. Subscriptions are bound to
// it, so it is never replaced; it is used only when WEB_PUSH_ENABLED=1.
ensure(SERVER, "vapid-key.pem", NODE_UID, () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
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
// The `approve` service gets the confirm secret and nothing else. Its copy is not a secret of
// its own: whenever it is missing or differs, for example after a restore of the signer's
// volume, it is written again from the signer's.
const confirmSecret = readFileSync(join(SIGNER, "confirm-request-secret"));
const approveCopy = join(APPROVE, "confirm-request-secret");
if (existsSync(approveCopy) && !readFileSync(approveCopy).equals(confirmSecret)) {
  rmSync(approveCopy);
}
ensure(APPROVE, "confirm-request-secret", NODE_UID, () => confirmSecret);
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
