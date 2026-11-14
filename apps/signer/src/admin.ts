import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { WorkspaceId } from "@askgina/os-protocol";
import { ConfigError, loadConfig, type SignerConfig } from "./config.ts";
import { createSigner, OwsVault } from "./index.ts";

/**
 * Operator commands that run on the signer host against the same SQLite file as the server:
 *
 *   node src/admin.ts recovery-code --workspace ws_…   print a one-time code (15 minutes)
 *   node src/admin.ts verify-log --workspace ws_…      check the decision log's hash chain
 *
 * Output is for the operator's terminal, so it goes to stdout as plain lines.
 */
const USAGE = "usage: admin.ts <recovery-code|verify-log> --workspace <ws_id>\n";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

process.umask(0o077);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { workspace: { type: "string" } },
});
const command = positionals[0];
const workspace = WorkspaceId.safeParse(values.workspace);
if ((command !== "recovery-code" && command !== "verify-log") || !workspace.success) {
  fail(USAGE);
}

let config: SignerConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  fail(error instanceof ConfigError ? error.message : "configuration cannot be read");
}
mkdirSync(config.vaultPath, { recursive: true, mode: 0o700 });
const signer = createSigner({
  sqlitePath: config.sqlitePath,
  vault: new OwsVault({ vaultPath: config.vaultPath, passphraseFile: config.passphraseFile }),
  relyingParty: config.relyingParty,
  requestSecret: config.requestSecret,
  tokenKey: config.tokenKey,
  maxIntentTtlSeconds: config.maxIntentTtlSeconds,
  maxAdminTtlSeconds: config.maxAdminTtlSeconds,
});
try {
  if (command === "recovery-code") {
    process.stdout.write(`${signer.issueRecoveryCode(workspace.data)}\n`);
  } else {
    const result = signer.verifyDecisionLog(workspace.data);
    process.stdout.write(
      result.ok ? "decision log ok\n" : `decision log broken at seq ${result.brokenAt}\n`,
    );
    process.exitCode = result.ok ? 0 : 1;
  }
} catch {
  fail("the workspace is unknown to this signer");
} finally {
  signer.close();
}
