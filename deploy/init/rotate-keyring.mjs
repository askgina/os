// Changes the server's keyring, the file with the key-encryption keys that wrap every data key
// in the database. The server mounts the keyring read-only, so this runs in the `init` service,
// which is the only one that can write it:
//
//   docker compose run --rm init node /init/rotate-keyring.mjs add
//   docker compose run --rm init node /init/rotate-keyring.mjs prune --confirm-rewrapped
//
// `add` puts a new random key in the keyring and makes it the active one. Old keys stay, because
// existing data keys are still wrapped under them until the server's rewrap command has run.
// `prune` removes every key except the active one. Run it only after rewrap reported no failures:
// a data key that is still wrapped under a removed key can never be read again.
//
// With several server replicas, a replica restarted after `add` wraps new data keys under a key
// the others do not have yet, and they fail every read of those keys until they restart too. So
// there the rotation has two phases: `add --inactive` puts the new key in without activating it;
// once every replica restarted with it, `activate <id>` makes it the active one, and every replica
// restarts again before rewrap.
//
// Nothing is printed except key ids. deploy/README.md has the whole procedure.
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const KEYRING = "/secrets/server/keyring.json";

// The user the server runs as in its image.
const NODE_UID = 1000;

function fail(message) {
  process.stdout.write(`${JSON.stringify({ event: "keyring.error", message })}\n`);
  process.exit(1);
}

function read() {
  let keyring;

  try {
    keyring = JSON.parse(readFileSync(KEYRING, "utf8"));
  } catch {
    // The file's text is key material: never quote the parser's message.
    fail("the keyring file is missing or is not valid JSON");
  }

  const hasActiveKey =
    typeof keyring?.active === "string" &&
    typeof keyring?.keys === "object" &&
    keyring.keys !== null &&
    typeof keyring.keys[keyring.active] === "string";

  if (!hasActiveKey) fail("the keyring file does not have an active key");

  return keyring;
}

function write(keyring) {
  // Write beside the file and rename, so a crash never leaves a half-written keyring.
  const temporary = `${KEYRING}.tmp`;
  writeFileSync(temporary, JSON.stringify(keyring), { mode: 0o400, flag: "w" });
  chownSync(temporary, NODE_UID, NODE_UID);
  renameSync(temporary, KEYRING);
  chmodSync(KEYRING, 0o400);
}

const [command, flag] = process.argv.slice(2);

const keyring = read();

if (command === "add") {
  if (flag !== undefined && flag !== "--inactive") fail("add takes only --inactive");

  const numbers = Object.keys(keyring.keys)
    .map((id) => /^k([0-9]+)$/.exec(id)?.[1])
    .filter((digits) => digits !== undefined)
    .map(Number);

  const id = `k${Math.max(0, ...numbers) + 1}`;
  keyring.keys[id] = randomBytes(32).toString("base64");

  if (flag === undefined) keyring.active = id;
  write(keyring);
  process.stdout.write(
    `${JSON.stringify({
      event: "keyring.added",
      added: id,
      active: keyring.active,
      keys: Object.keys(keyring.keys),
    })}\n`,
  );
} else if (command === "activate") {
  if (flag === undefined || !Object.hasOwn(keyring.keys, flag)) {
    fail("activate needs the id of a key in the keyring, as add printed it");
  }

  const previous = keyring.active;
  keyring.active = flag;

  if (previous !== flag) write(keyring);
  process.stdout.write(
    `${JSON.stringify({ event: "keyring.activated", active: flag, previous, keys: Object.keys(keyring.keys) })}\n`,
  );
} else if (command === "prune") {
  if (flag !== "--confirm-rewrapped") {
    fail(
      "prune removes old keys for good; pass --confirm-rewrapped after rewrap reported no failures",
    );
  }

  const removed = Object.keys(keyring.keys).filter((id) => id !== keyring.active);
  write({ active: keyring.active, keys: { [keyring.active]: keyring.keys[keyring.active] } });
  process.stdout.write(
    `${JSON.stringify({ event: "keyring.pruned", active: keyring.active, removed })}\n`,
  );
} else {
  fail("usage: rotate-keyring.mjs add [--inactive] | activate <id> | prune --confirm-rewrapped");
}
