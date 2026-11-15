import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { ApproverCredential, WorkspaceId } from "@askgina/os-protocol";
import { ConfigError, loadConfig, type SignerConfig } from "./config.ts";
import { SignerFailure } from "./errors.ts";
import { createSigner, OwsVault, SchemaTooNewError, type Signer } from "./index.ts";

/**
 * Operator commands that run on the signer host against the same SQLite file as the server:
 *
 *   node src/admin.ts enroll-approver --workspace ws_… --user usr_…
 *       --credential-id <base64url> --public-key <base64url COSE key>
 *     add an approver without passkey assertions, after every passkey was lost
 *   node src/admin.ts verify-log --workspace ws_…
 *     check the decision log's hash chain and its recorded head
 *   node src/admin.ts fence
 *     after restoring a backup, before the signer serves: refuse every envelope issued until now
 *
 * Whoever can run these on the signer host is the root of trust: `enroll-approver` adds a key
 * that can approve anything the workspace's thresholds allow. Each command prints one JSON line.
 */
const USAGE =
  "usage: admin.ts enroll-approver --workspace <ws_id> --user <usr_id> --credential-id <b64url> --public-key <b64url>\n" +
  "       admin.ts verify-log --workspace <ws_id>\n" +
  "       admin.ts fence\n";

function print(line: object): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function fail(code: string, exitCode = 2): never {
  print({ ok: false, code });
  process.exit(exitCode);
}

process.umask(0o077);
function readArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        workspace: { type: "string" },
        user: { type: "string" },
        "credential-id": { type: "string" },
        "public-key": { type: "string" },
      },
    });
  } catch {
    process.stderr.write(USAGE);
    fail("usage");
  }
}
const { positionals, values } = readArgs();
const command = positionals[0];
const workspace = WorkspaceId.safeParse(values.workspace);
const usable =
  command === "fence" ||
  ((command === "enroll-approver" || command === "verify-log") && workspace.success);
if (!usable) {
  process.stderr.write(USAGE);
  fail("usage");
}
const approver =
  command === "enroll-approver"
    ? ApproverCredential.safeParse({
        userId: values.user,
        credentialId: values["credential-id"],
        publicKey: values["public-key"],
      })
    : null;
if (approver && !approver.success) {
  process.stderr.write(USAGE);
  fail("usage");
}

let config: SignerConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  process.stderr.write(
    `${error instanceof ConfigError ? error.message : "configuration cannot be read"}\n`,
  );
  fail("config");
}
mkdirSync(config.vaultPath, { recursive: true, mode: 0o700 });
let signer: Signer;
try {
  signer = createSigner({
    sqlitePath: config.sqlitePath,
    vault: new OwsVault({ vaultPath: config.vaultPath, passphraseFile: config.passphraseFile }),
    rpId: config.rpId,
    requestSecret: config.requestSecret,
    confirmSecret: config.confirmSecret,
    approvalOrigin: config.approvalOrigin,
    returnOrigin: config.returnOrigin,
    chains: config.chains,
    assets: config.assets,
    tokenKey: config.tokenKey,
    maxIntentTtlSeconds: config.maxIntentTtlSeconds,
    maxAdminTtlSeconds: config.maxAdminTtlSeconds,
  });
} catch (error) {
  fail(error instanceof SchemaTooNewError ? "schema_too_new" : "database");
}
try {
  if (command === "fence") {
    print({ ok: true, action: "fence-set-by-operator", fenceAt: signer.fence() });
  } else if (approver?.success && workspace.success) {
    signer.enrollApproverByOperator(workspace.data, approver.data);
    print({
      ok: true,
      action: "enroll-approver-by-operator",
      workspaceId: workspace.data,
      userId: approver.data.userId,
      credentialId: approver.data.credentialId,
    });
  } else if (workspace.success) {
    const result = signer.verifyDecisionLog(workspace.data);
    print({ ok: result.ok, workspaceId: workspace.data, brokenAt: result.brokenAt });
    process.exitCode = result.ok ? 0 : 1;
  }
} catch (error) {
  // `not_found`: unknown workspace; `conflict`: the credential is already enrolled.
  fail(error instanceof SignerFailure ? error.code : "internal");
} finally {
  signer.close();
}
