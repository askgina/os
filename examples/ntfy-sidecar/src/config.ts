import { readFileSync } from "node:fs";
import type { BridgeConfig } from "./bridge.ts";

/** The control plane refuses a shorter webhook secret; so does the sidecar. */
const MIN_SECRET_LENGTH = 32;

/** ntfy's own rule for a topic name. */
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

export interface SidecarConfig extends BridgeConfig {
  port: number;
}

/** A setting's value, with an empty one read as unset, as Compose passes `${VAR:-}`. */
function setting(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === undefined || value === "" ? undefined : value;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = setting(env, name);

  if (value === undefined) throw new Error(`${name} is required`);

  return value;
}

/**
 * Read the sidecar's settings from `env` and the files they name. Throws with the setting's name
 * when one is missing or wrong, so the sidecar refuses to start instead of dropping deliveries.
 *
 *   NOTIFY_WEBHOOK_SECRET_FILE  file holding the control plane's notify-webhook-secret
 *   NTFY_URL                    the ntfy server, for example https://ntfy.example.com
 *   NTFY_TOPIC                  the topic to publish to
 *   NTFY_TOKEN_FILE             optional file holding an ntfy access token; empty means none
 *   NTFY_INCLUDE_LINK           1 to open the request's page when the notification is tapped
 *   PUBLIC_ORIGIN               the control plane's PUBLIC_ORIGIN, required with links: a link
 *                               on any other origin is left out
 *   PORT                        where to listen (default 8080)
 */
export function readConfig(env: Record<string, string | undefined>): SidecarConfig {
  const portText = setting(env, "PORT") ?? "8080";
  const port = Number(portText);

  if (!/^\d+$/.test(portText) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a port number");
  }

  const secret = readFileSync(required(env, "NOTIFY_WEBHOOK_SECRET_FILE"), "utf8").trim();

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `NOTIFY_WEBHOOK_SECRET_FILE must hold at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  const ntfyText = required(env, "NTFY_URL");

  if (!URL.canParse(ntfyText)) throw new Error("NTFY_URL must be an http or https URL");
  const ntfy = new URL(ntfyText);

  if (ntfy.protocol !== "https:" && ntfy.protocol !== "http:") {
    throw new Error("NTFY_URL must be an http or https URL");
  }

  if (ntfy.username !== "" || ntfy.password !== "" || ntfy.search !== "" || ntfy.hash !== "") {
    throw new Error("NTFY_URL must carry no credentials, query or fragment; use NTFY_TOKEN_FILE");
  }

  const topic = required(env, "NTFY_TOPIC");

  if (!TOPIC.test(topic)) {
    throw new Error("NTFY_TOPIC must be 1 to 64 letters, digits, '-' or '_'");
  }

  const tokenFile = setting(env, "NTFY_TOKEN_FILE");
  const tokenText = tokenFile === undefined ? "" : readFileSync(tokenFile, "utf8").trim();

  const includeLink = setting(env, "NTFY_INCLUDE_LINK") ?? "0";

  if (includeLink !== "0" && includeLink !== "1") {
    throw new Error("NTFY_INCLUDE_LINK must be 0 or 1");
  }

  let linkOrigin: string | null = null;

  if (includeLink === "1") {
    const origin = required(env, "PUBLIC_ORIGIN");
    const url = URL.canParse(origin) ? new URL(origin) : null;

    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new Error("PUBLIC_ORIGIN must be the control plane's http or https origin");
    }

    linkOrigin = url.origin;
  }

  return {
    port,
    secret,
    ntfyUrl: `${ntfy.origin}${ntfy.pathname.replace(/\/+$/, "")}`,
    topic,
    token: tokenText === "" ? null : tokenText,
    linkOrigin,
  };
}
