import { createConfirmClient } from "@askgina/os-protocol/signer";
import { createSignerFetch } from "@askgina/os-protocol/signer-transport";
import { serve } from "@hono/node-server";
import { createApproveApp, readPageFiles } from "./app.ts";
import { type ApproveConfig, ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";

const log = createLogger("approve");

let config: ApproveConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  log.error("refusing to start", {
    code: "config_invalid",
    reason: error instanceof ConfigError ? error.message : "unreadable configuration",
  });
  process.exit(1);
}

const app = createApproveApp({
  confirm: createConfirmClient({
    baseUrl: config.signerUrl,
    secret: config.signerSecret,
    // Mutual TLS to an `https:` signer, which must present the certificate issued for the host
    // name in SIGNER_URL; plain HTTP on one machine, as before.
    fetch:
      config.signerTls === null
        ? undefined
        : createSignerFetch(config.signerTls, new URL(config.signerUrl).hostname),
  }),
  files: readPageFiles(),
  approveOrigin: config.approveOrigin,
  log,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, () =>
  log.info("listening", { port: config.port }),
);

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  server.close(() => {
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
