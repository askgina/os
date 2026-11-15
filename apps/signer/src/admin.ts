import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { ApproverCredential, MandateId, WalletId, WorkspaceId } from "@askgina/os-protocol";
import { ConfigError, loadConfig, type SignerConfig } from "./config.ts";
import { SignerFailure } from "./errors.ts";
import {
  createSigner,
  exportOwsWalletSecret,
  OwsVault,
  SchemaTooNewError,
  type Signer,
} from "./index.ts";
import { LIFECYCLE_ACTIONS } from "./lifecycle.ts";
import { MANDATE_ACTIONS } from "./mandates.ts";

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
 *     and revoke every live mandate
 *   node src/admin.ts list-mandates --workspace ws_…
 *     the workspace's mandates: ids, status, times and use counts
 *   node src/admin.ts revoke-mandate --mandate mnd_…
 *   node src/admin.ts revoke-mandate --all --workspace ws_…
 *     end one mandate, or every live mandate of a workspace, with reason `operator`
 *   node src/admin.ts export-wallet --workspace ws_… --wallet wal_… --out <absolute path>
 *     write the wallet's mnemonic to a new file readable by this user only, for an operator
 *     taking its funds out of the system; the only way a key ever leaves the signer host
 *
 * Whoever can run these on the signer host is the root of trust: `enroll-approver` adds a key
 * that can approve anything the workspace's thresholds allow. Each command prints one JSON line.
 */
const USAGE =
  "usage: admin.ts enroll-approver --workspace <ws_id> --user <usr_id> --credential-id=<b64url> --public-key=<b64url>\n" +
  "       admin.ts verify-log --workspace <ws_id>\n" +
  "       admin.ts fence\n" +
  "       admin.ts list-mandates --workspace <ws_id>\n" +
  "       admin.ts revoke-mandate --mandate <mnd_id>\n" +
  "       admin.ts revoke-mandate --all --workspace <ws_id>\n" +
  "       admin.ts export-wallet --workspace <ws_id> --wallet <wal_id> --out <absolute path>\n";

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
        mandate: { type: "string" },
        all: { type: "boolean" },
        wallet: { type: "string" },
        out: { type: "string" },
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
const mandate = MandateId.safeParse(values.mandate);
const wallet = WalletId.safeParse(values.wallet);
const exportTo =
  command === "export-wallet" &&
  workspace.success &&
  wallet.success &&
  values.out !== undefined &&
  isAbsolute(values.out)
    ? values.out
    : null;
// Exactly one of the two forms: one mandate by id, or every live mandate of one workspace.
const revokeOne =
  command === "revoke-mandate" &&
  mandate.success &&
  values.all !== true &&
  values.workspace === undefined;
const revokeAll =
  command === "revoke-mandate" &&
  values.all === true &&
  workspace.success &&
  values.mandate === undefined;
const usable =
  command === "fence" ||
  revokeOne ||
  revokeAll ||
  exportTo !== null ||
  ((command === "enroll-approver" || command === "verify-log" || command === "list-mandates") &&
    workspace.success);
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
    maxMandateSeconds: config.maxMandateSeconds,
    maxLiveMandatesPerWallet: config.maxLiveMandatesPerWallet,
    maxTxAttempts: config.maxTxAttempts,
    repriceWindowSeconds: config.repriceWindowSeconds,
    minDestroyDelaySeconds: config.minDestroyDelaySeconds,
    maxDestroyDelaySeconds: config.maxDestroyDelaySeconds,
  });
} catch (error) {
  fail(error instanceof SchemaTooNewError ? "schema_too_new" : "database");
}
try {
  if (command === "fence") {
    print({ ok: true, action: "fence-set-by-operator", fenceAt: signer.fence() });
  } else if (exportTo !== null && workspace.success && wallet.success) {
    // Checked before the key is read; the write below refuses a file created meanwhile.
    if (existsSync(exportTo)) fail("out_exists");
    const exported = await signer.exportWalletByOperator(workspace.data, wallet.data, (walletId) =>
      exportOwsWalletSecret(
        { vaultPath: config.vaultPath, passphraseFile: config.passphraseFile },
        walletId,
      ),
    );
    try {
      writeFileSync(exportTo, `${exported.secret}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      fail("out_unwritable");
    }
    // Identifiers only: never the secret.
    print({
      ok: true,
      action: LIFECYCLE_ACTIONS.export,
      workspaceId: workspace.data,
      walletId: wallet.data,
      address: exported.address,
      out: exportTo,
    });
  } else if (revokeOne && mandate.success) {
    print({
      ok: true,
      action: MANDATE_ACTIONS.revokeByOperator,
      revoked: signer.revokeMandateByOperator(mandate.data),
    });
  } else if (revokeAll && workspace.success) {
    print({
      ok: true,
      action: MANDATE_ACTIONS.revokeByOperator,
      workspaceId: workspace.data,
      revoked: signer.revokeWorkspaceMandatesByOperator(workspace.data),
    });
  } else if (command === "list-mandates" && workspace.success) {
    // Identifiers, status, times and counts: never the purpose or the recipients.
    print({
      ok: true,
      workspaceId: workspace.data,
      mandates: signer.listWorkspaceMandates(workspace.data).map((state) => ({
        mandateId: state.mandate.id,
        walletId: state.mandate.walletId,
        agentId: state.mandate.agentId,
        status: state.status,
        notBefore: state.mandate.notBefore,
        notAfter: state.mandate.notAfter,
        grantedAt: state.grantedAt,
        revokedAt: state.revokedAt,
        revokedReason: state.revokedReason,
        uses: state.usage.uses,
        maxUses: state.mandate.maxUses,
      })),
    });
  } else if (approver?.success && workspace.success) {
    signer.enrollApproverByOperator(workspace.data, approver.data);
    print({
      ok: true,
      action: "enroll-approver-by-operator",
      workspaceId: workspace.data,
      userId: approver.data.userId,
      credentialId: approver.data.credentialId,
    });
  } else if (command === "verify-log" && workspace.success) {
    const result = signer.verifyDecisionLog(workspace.data);
    print({ ok: result.ok, workspaceId: workspace.data, brokenAt: result.brokenAt });
    process.exitCode = result.ok ? 0 : 1;
  }
} catch (error) {
  // `not_found`: unknown workspace or mandate; `conflict`: the credential is already enrolled.
  fail(error instanceof SignerFailure ? error.code : "internal");
} finally {
  signer.close();
}
