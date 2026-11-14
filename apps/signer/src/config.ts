import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_SECRET_BYTES } from "@askgina/os-protocol/signer";
import type { RelyingParty } from "@askgina/os-protocol/webauthn";
import { z } from "zod";

const Environment = z.object({
  SIGNER_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  SIGNER_DATA_DIR: z.string().min(1),
  SIGNER_HMAC_SECRET_FILE: z.string().min(1),
  SIGNER_KEY_FILE: z.string().min(1),
  SIGNER_VAULT_PASSPHRASE_FILE: z.string().min(1),
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_ORIGINS: z.string().min(1),
  // Both ceilings default to the longest lifetime the protocol allows, so a policy that is valid
  // by its schema is usable; an operator lowers them to shorten how long an approval can wait.
  SIGNER_MAX_INTENT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
  SIGNER_MAX_ADMIN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
});

export interface SignerConfig {
  port: number;
  dataDir: string;
  sqlitePath: string;
  vaultPath: string;
  passphraseFile: string;
  requestSecret: Uint8Array;
  tokenKey: Uint8Array;
  relyingParty: RelyingParty;
  maxIntentTtlSeconds: number;
  maxAdminTtlSeconds: number;
}

/** A configuration problem. The message names the variable, never its value. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

// Secrets are files holding base64 text, so they never appear in the process environment.
function readSecret(variable: string, path: string): Uint8Array {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigError(`${variable}: file cannot be read`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new ConfigError(`${variable}: not base64`);
  return new Uint8Array(Buffer.from(text, "base64"));
}

function parseOrigins(raw: string): string[] {
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError("WEBAUTHN_ORIGINS: not a list of origins");
    }
    // Origins are compared as exact strings, so they must be written in their canonical form.
    if (parsed.origin !== origin) throw new ConfigError("WEBAUTHN_ORIGINS: not canonical origins");
  }
  if (origins.length === 0) throw new ConfigError("WEBAUTHN_ORIGINS: empty");
  return origins;
}

export function loadConfig(environment: NodeJS.ProcessEnv): SignerConfig {
  const parsed = Environment.safeParse(environment);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`missing or invalid: ${names.join(", ")}`);
  }
  const env = parsed.data;
  const requestSecret = readSecret("SIGNER_HMAC_SECRET_FILE", env.SIGNER_HMAC_SECRET_FILE);
  if (requestSecret.byteLength < MIN_SECRET_BYTES) {
    throw new ConfigError(`SIGNER_HMAC_SECRET_FILE: fewer than ${MIN_SECRET_BYTES} bytes`);
  }
  const tokenKey = readSecret("SIGNER_KEY_FILE", env.SIGNER_KEY_FILE);
  if (tokenKey.byteLength !== 32) throw new ConfigError("SIGNER_KEY_FILE: not 32 bytes");
  return {
    port: env.SIGNER_PORT,
    dataDir: env.SIGNER_DATA_DIR,
    sqlitePath: join(env.SIGNER_DATA_DIR, "signer.sqlite"),
    vaultPath: join(env.SIGNER_DATA_DIR, "vault"),
    passphraseFile: env.SIGNER_VAULT_PASSPHRASE_FILE,
    requestSecret,
    tokenKey,
    relyingParty: { id: env.WEBAUTHN_RP_ID, origins: parseOrigins(env.WEBAUTHN_ORIGINS) },
    maxIntentTtlSeconds: env.SIGNER_MAX_INTENT_TTL_SECONDS,
    maxAdminTtlSeconds: env.SIGNER_MAX_ADMIN_TTL_SECONDS,
  };
}
