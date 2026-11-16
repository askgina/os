// Creates the stack's secrets on first start and never changes them afterwards. Each trust
// domain gets its own volume, so the server cannot read the signer's key and the signer cannot
// read the keyring. The `approve` service's volume holds only a copy of one signer secret, which
// follows the signer's. Nothing is printed except file names and whether they were written.
//
//   node init.mjs                    one machine: every trust domain (compose.yaml)
//   node init.mjs --domain=signer    the signer's host (deploy/split/signer.compose.yaml)
//   node init.mjs --domain=control   the control plane's host (deploy/split/control.compose.yaml)
//
// On split hosts, /import is the operator's directory of files made or copied for this host:
// the peer certificates from deploy/split/make-peer-certs.sh and, on the control host, the
// signer's request secret. They are installed into this host's volumes and follow /import
// whenever they differ, so a renewed certificate takes effect at the next start. The confirm
// secret, the token key and the vault passphrase never leave the signer's host.
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

const IMPORT = "/import";

// Users the services run as: `node` in node:26-slim and `postgres` in postgres:18-alpine.
const NODE_UID = 1000;

const POSTGRES_UID = 70;

const DOMAINS = ["all", "control", "signer"];

const domainArgument = process.argv.slice(2).find((arg) => arg.startsWith("--domain="));

const domain = domainArgument === undefined ? "all" : domainArgument.slice("--domain=".length);

if (!DOMAINS.includes(domain)) {
  process.stderr.write(`${JSON.stringify({ event: "refused", reason: "unknown --domain" })}\n`);
  process.exit(2);
}

const control = domain === "all" || domain === "control";

const signer = domain === "all" || domain === "signer";

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

/** A copy that is not a secret of its own: written again whenever it is missing or differs. */
function follow(dir, name, uid, bytes) {
  const path = join(dir, name);

  if (existsSync(path) && !readFileSync(path).equals(bytes)) rmSync(path);
  ensure(dir, name, uid, () => bytes);
}

/** A file the operator put in /import for this host. Its absence stops the start. */
function imported(name) {
  const path = join(IMPORT, name);

  if (!existsSync(path)) {
    process.stderr.write(`${JSON.stringify({ event: "missing", file: path })}\n`);
    process.exit(1);
  }

  return readFileSync(path);
}

if (control) {
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
}

if (domain === "all") {
  // The request secret is shared: generate it once and copy it, so both sides always agree.
  // If only one volume was lost, the surviving copy is reused rather than replaced.
  ensure(SERVER, "signer-request-secret", NODE_UID, () => {
    const other = join(SIGNER, "signer-request-secret");

    return existsSync(other) ? readFileSync(other) : b64();
  });
  ensure(SIGNER, "signer-request-secret", NODE_UID, () =>
    readFileSync(join(SERVER, "signer-request-secret")),
  );
} else if (domain === "signer") {
  // The signer's host makes the request secret; the operator copies it to the control host.
  ensure(SIGNER, "signer-request-secret", NODE_UID, () => b64());
} else {
  // The control host never makes a request secret of its own, which the signer would refuse:
  // it takes the signer's from /import, and follows it when the signer's host made a new one.
  // Once installed, /import may drop it.
  const copied = join(IMPORT, "signer-request-secret");

  if (existsSync(copied)) {
    follow(SERVER, "signer-request-secret", NODE_UID, readFileSync(copied));
  } else {
    ensure(SERVER, "signer-request-secret", NODE_UID, () => imported("signer-request-secret"));
  }
}

if (signer) {
  // The confirm secret lets the `approve` service reach the signer's confirm routes and
  // nothing else, so it is never the request secret.
  ensure(SIGNER, "confirm-request-secret", NODE_UID, () => b64());
  // The `approve` service gets the confirm secret and nothing else. Its copy is not a secret of
  // its own: whenever it is missing or differs, for example after a restore of the signer's
  // volume, it is written again from the signer's.
  follow(
    APPROVE,
    "confirm-request-secret",
    NODE_UID,
    readFileSync(join(SIGNER, "confirm-request-secret")),
  );
  ensure(SIGNER, "token-key", NODE_UID, () => b64());
  ensure(SIGNER, "vault-passphrase", NODE_UID, () => b64());
}

if (control) {
  ensure(DB, "postgres-password", POSTGRES_UID, () => {
    const other = join(SERVER, "postgres-password");

    return existsSync(other) ? readFileSync(other) : randomBytes(32).toString("hex");
  });
  // The server runs as a different user than Postgres, so it gets its own copy.
  ensure(SERVER, "postgres-password", NODE_UID, () => readFileSync(join(DB, "postgres-password")));
}

// Mutual TLS between the hosts (deploy/split/make-peer-certs.sh). Each side holds its own key
// and exactly the certificates it trusts.
if (domain === "signer") {
  for (const name of ["signer.crt", "signer.key", "control.crt", "approve.crt"]) {
    follow(SIGNER, name, NODE_UID, imported(name));
  }

  for (const name of ["approve.crt", "approve.key", "signer.crt"]) {
    follow(APPROVE, name, NODE_UID, imported(name));
  }
} else if (domain === "control") {
  for (const name of ["control.crt", "control.key", "signer.crt"]) {
    follow(SERVER, name, NODE_UID, imported(name));
  }
}

if (signer) {
  // The signer's data volume starts out owned by root; the signer runs as `node`.
  const SIGNER_DATA = "/data/signer";
  chownSync(SIGNER_DATA, NODE_UID, NODE_UID);
  chmodSync(SIGNER_DATA, 0o700);
}
