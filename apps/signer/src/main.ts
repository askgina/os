import { mkdirSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { ConfigError, certificateExpiry, loadConfig, type SignerConfig } from "./config.ts";
import { createSigner, OwsVault, SchemaTooNewError, type Signer } from "./index.ts";
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

if (config.tls !== null) {
  // Every client refuses an expired certificate, so the signer would be unreachable: stop here
  // with the reason instead. The days left are logged on every start, to renew in time.
  const expiry = certificateExpiry(config.tls, Date.now());
  log.info(
    "tls_expiry",
    Object.fromEntries(expiry.map(({ variable, daysLeft }) => [variable, daysLeft])),
  );
  const expired = expiry.find((certificate) => certificate.expired);

  if (expired !== undefined) {
    log.error("refusing to start", {
      code: "tls_certificate_expired",
      variable: expired.variable,
    });
    process.exit(1);
  }
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
    clientCertificates:
      config.tls === null
        ? undefined
        : { control: config.tls.control, approve: config.tls.approve },
    log,
  });
} catch (error) {
  // A database written by a newer signer: running older code on it could drop what it records
  // (the restore fence among it), so this image does not serve it.
  if (!(error instanceof SchemaTooNewError)) throw error;
  log.error("refusing to start", { code: "schema_too_new" });
  process.exit(1);
}

let server: ServerType;

let health: ServerType | null = null;

if (config.tls === null) {
  server = serve({ fetch: signer.app.fetch, port: config.port, hostname: config.host }, () =>
    log.info("listening", { port: config.port }),
  );
} else {
  // A client without one of the two trusted certificates fails the handshake and never reaches
  // the HTTP parser; the signer then binds the certificate to its scope.
  const { cert, key, control, approve } = config.tls;
  server = serve(
    {
      fetch: signer.app.fetch,
      port: config.port,
      hostname: config.host,
      createServer: createHttpsServer,
      serverOptions: {
        cert,
        key,
        ca: [control, approve],
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
    },
    () => log.info("listening", { port: config.port, tls: true }),
  );
  // The container's health check cannot present a client certificate, so it gets a plain
  // listener on loopback that answers the health check and nothing else.
  const healthApp = new Hono();
  healthApp.get("/healthz", () => signer.app.request("/healthz"));
  health = serve({ fetch: healthApp.fetch, port: config.healthPort, hostname: "127.0.0.1" }, () =>
    log.info("health listening", { port: config.healthPort }),
  );
}

let stopping = false;

function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  // Requests in flight finish; each one commits or rolls back its own SQLite transaction.
  health?.close();
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
