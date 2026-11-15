/**
 * Forwards the control plane's signed notification webhook to an ntfy topic. It verifies each
 * delivery's signature and timestamp, publishes a fixed text once per delivery id, and holds no
 * credential of the control plane's: only the webhook's signing secret, and an ntfy token if the
 * topic needs one. Settings are listed in `src/config.ts` and the README.
 */
import { createBridge } from "./bridge.ts";
import { readConfig, type SidecarConfig } from "./config.ts";

function say(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`);
}

/** The settings, or a message naming the wrong one and exit code 1. */
function load(): SidecarConfig {
  try {
    return readConfig(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const config = load();

const server = createBridge(config, { log: say });
server.listen(config.port, () => {
  say({
    message: "listening",
    port: config.port,
    ntfy: config.ntfyUrl,
    linkOrigin: config.linkOrigin,
  });
});

function stop(): void {
  server.close(() => process.exit(0));
  // Requests in flight end within the ntfy timeout; do not wait on idle keep-alive sockets.
  server.closeIdleConnections();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
