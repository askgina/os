import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { ConfigError, loadConfig, type SignerConfig } from "./config.ts";
import { createSigner, OwsVault } from "./index.ts";
import { createLogger } from "./log.ts";

// Everything the signer writes (SQLite, the vault) is readable by its own user only.
process.umask(0o077);
const log = createLogger("signer");

let config: SignerConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  log.error("refusing to start", {
    code: "config_invalid",
    reason: error instanceof ConfigError ? error.message : "unreadable configuration",
  });
  process.exit(1);
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
  log,
});

const server = serve({ fetch: signer.app.fetch, port: config.port, hostname: "0.0.0.0" }, () =>
  log.info("listening", { port: config.port }),
);

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  // Requests in flight finish; each one commits or rolls back its own SQLite transaction.
  server.close(() => {
    signer.close();
    log.info("stopped", {});
    process.exit(0);
  });
  setTimeout(() => {
    log.error("forced exit", { code: "shutdown_timeout" });
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
