import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssetLabels, ChainLabels, MANDATE_MAX_SECONDS } from "@askgina/os-protocol";
import { MIN_SECRET_BYTES } from "@askgina/os-protocol/signer";
import { z } from "zod";
import { DEFAULT_MAX_TX_ATTEMPTS, DEFAULT_REPRICE_WINDOW_SECONDS } from "./attempts.ts";
import {
  DEFAULT_MAX_DESTROY_DELAY_SECONDS,
  DEFAULT_MIN_DESTROY_DELAY_SECONDS,
} from "./lifecycle.ts";
import { DEFAULT_MAX_LIVE_MANDATES_PER_WALLET, DEFAULT_MAX_MANDATE_SECONDS } from "./mandates.ts";

const Environment = z.object({
  SIGNER_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  SIGNER_DATA_DIR: z.string().min(1),
  SIGNER_HMAC_SECRET_FILE: z.string().min(1),
  SIGNER_CONFIRM_SECRET_FILE: z.string().min(1),
  SIGNER_KEY_FILE: z.string().min(1),
  SIGNER_VAULT_PASSPHRASE_FILE: z.string().min(1),
  WEBAUTHN_RP_ID: z.string().min(1),
  SIGNER_APPROVAL_ORIGIN: z.string().min(1),
  SIGNER_RETURN_ORIGIN: z.string().min(1),
  SIGNER_CHAINS_FILE: z.string().min(1),
  SIGNER_ASSETS_FILE: z.string().min(1),
  // Both ceilings default to the longest lifetime the protocol allows, so a policy that is valid
  // by its schema is usable; an operator lowers them to shorten how long an approval can wait.
  SIGNER_MAX_INTENT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
  SIGNER_MAX_ADMIN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
  // The longest life the signer grants a mandate, at most the protocol's 30 days. One misleading
  // grant can spend its worst case until it ends, so the default is seven days.
  SIGNER_MAX_MANDATE_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .max(MANDATE_MAX_SECONDS)
    .default(DEFAULT_MAX_MANDATE_SECONDS),
  SIGNER_MAX_LIVE_MANDATES_PER_WALLET: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MAX_LIVE_MANDATES_PER_WALLET),
  // Attempts per approval, the first signature included: every reprice and cancel is one more
  // signature of the approval at its one account nonce.
  SIGNER_MAX_TX_ATTEMPTS: z.coerce.number().int().min(2).max(64).default(DEFAULT_MAX_TX_ATTEMPTS),
  // How long after the first signature the control plane may get a reprice with no person; after
  // that only a cancel, with passkeys, is signed. 0 refuses every reprice.
  SIGNER_REPRICE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(604_800)
    .default(DEFAULT_REPRICE_WINDOW_SECONDS),
  // The shortest and longest delay from a retirement or deletion envelope's `issuedAt` to its
  // `destroyAfter`. An empty value is unset: 0 is a valid minimum, so Compose passing an unset
  // variable as "" must not silently remove the delay.
  SIGNER_MIN_DESTROY_DELAY_SECONDS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(7_776_000).default(DEFAULT_MIN_DESTROY_DELAY_SECONDS),
  ),
  SIGNER_MAX_DESTROY_DELAY_SECONDS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(31_536_000).default(DEFAULT_MAX_DESTROY_DELAY_SECONDS),
  ),
});

export interface SignerConfig {
  port: number;
  dataDir: string;
  sqlitePath: string;
  vaultPath: string;
  passphraseFile: string;
  requestSecret: Uint8Array;
  confirmSecret: Uint8Array;
  tokenKey: Uint8Array;
  /** The RP ID passkeys were registered under. */
  rpId: string;
  /** The confirmation page's origin: the one origin an approval may be made at. */
  approvalOrigin: string;
  returnOrigin: string;
  chains: ChainLabels;
  assets: AssetLabels;
  maxIntentTtlSeconds: number;
  maxAdminTtlSeconds: number;
  maxMandateSeconds: number;
  maxLiveMandatesPerWallet: number;
  maxTxAttempts: number;
  repriceWindowSeconds: number;
  minDestroyDelaySeconds: number;
  maxDestroyDelaySeconds: number;
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

function readJson(variable: string, path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`${variable}: file cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`${variable}: not JSON`);
  }
}

// Origins are compared as exact strings, so they must be written in their canonical form.
function parseOrigin(variable: string, origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ConfigError(`${variable}: not an origin`);
  }
  if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
    throw new ConfigError(`${variable}: not a canonical http or https origin`);
  }
  return parsed;
}

/**
 * The chains file is the one the control plane reads, which also holds RPC endpoints and
 * explorer links. The signer keeps only each chain's id, name and native coin (an object schema
 * drops the other keys), then checks those as labels.
 */
const ChainsFileEntries = z.array(
  z.object({ chainId: z.unknown(), name: z.unknown(), nativeSymbol: z.unknown() }),
);

function readChainLabels(path: string): ChainLabels {
  const entries = ChainsFileEntries.safeParse(readJson("SIGNER_CHAINS_FILE", path));
  const labels = ChainLabels.safeParse(entries.success ? entries.data : null);
  if (!labels.success) {
    throw new ConfigError("SIGNER_CHAINS_FILE: not a list of chains with a name and native coin");
  }
  return labels.data;
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
  const confirmSecret = readSecret("SIGNER_CONFIRM_SECRET_FILE", env.SIGNER_CONFIRM_SECRET_FILE);
  if (confirmSecret.byteLength < MIN_SECRET_BYTES) {
    throw new ConfigError(`SIGNER_CONFIRM_SECRET_FILE: fewer than ${MIN_SECRET_BYTES} bytes`);
  }
  // The same secret for both would let whoever holds the confirm secret call every route.
  if (Buffer.from(confirmSecret).equals(Buffer.from(requestSecret))) {
    throw new ConfigError("SIGNER_CONFIRM_SECRET_FILE: the same secret as SIGNER_HMAC_SECRET_FILE");
  }
  if (env.SIGNER_MAX_DESTROY_DELAY_SECONDS < env.SIGNER_MIN_DESTROY_DELAY_SECONDS) {
    throw new ConfigError(
      "SIGNER_MAX_DESTROY_DELAY_SECONDS: less than SIGNER_MIN_DESTROY_DELAY_SECONDS",
    );
  }
  const tokenKey = readSecret("SIGNER_KEY_FILE", env.SIGNER_KEY_FILE);
  if (tokenKey.byteLength !== 32) throw new ConfigError("SIGNER_KEY_FILE: not 32 bytes");

  const rpId = env.WEBAUTHN_RP_ID;
  // The confirmation page must share the RP ID so enrolled passkeys work there: its host is the
  // RP ID itself (another port) or a name under it.
  const approval = parseOrigin("SIGNER_APPROVAL_ORIGIN", env.SIGNER_APPROVAL_ORIGIN);
  if (approval.hostname !== rpId && !approval.hostname.endsWith(`.${rpId}`)) {
    throw new ConfigError("SIGNER_APPROVAL_ORIGIN: its host is not WEBAUTHN_RP_ID or under it");
  }
  // The return origin is the control plane's. An approval page on the control plane's own origin
  // would protect nothing: the signer would accept assertions the control plane's page made.
  parseOrigin("SIGNER_RETURN_ORIGIN", env.SIGNER_RETURN_ORIGIN);
  if (env.SIGNER_RETURN_ORIGIN === env.SIGNER_APPROVAL_ORIGIN) {
    throw new ConfigError("SIGNER_RETURN_ORIGIN: the same origin as SIGNER_APPROVAL_ORIGIN");
  }

  const assets = AssetLabels.safeParse(readJson("SIGNER_ASSETS_FILE", env.SIGNER_ASSETS_FILE));
  if (!assets.success) {
    throw new ConfigError("SIGNER_ASSETS_FILE: not a list of tokens with a symbol and decimals");
  }

  return {
    port: env.SIGNER_PORT,
    dataDir: env.SIGNER_DATA_DIR,
    sqlitePath: join(env.SIGNER_DATA_DIR, "signer.sqlite"),
    vaultPath: join(env.SIGNER_DATA_DIR, "vault"),
    passphraseFile: env.SIGNER_VAULT_PASSPHRASE_FILE,
    requestSecret,
    confirmSecret,
    tokenKey,
    rpId,
    approvalOrigin: env.SIGNER_APPROVAL_ORIGIN,
    returnOrigin: env.SIGNER_RETURN_ORIGIN,
    chains: readChainLabels(env.SIGNER_CHAINS_FILE),
    assets: assets.data,
    maxIntentTtlSeconds: env.SIGNER_MAX_INTENT_TTL_SECONDS,
    maxAdminTtlSeconds: env.SIGNER_MAX_ADMIN_TTL_SECONDS,
    maxMandateSeconds: env.SIGNER_MAX_MANDATE_SECONDS,
    maxLiveMandatesPerWallet: env.SIGNER_MAX_LIVE_MANDATES_PER_WALLET,
    maxTxAttempts: env.SIGNER_MAX_TX_ATTEMPTS,
    repriceWindowSeconds: env.SIGNER_REPRICE_WINDOW_SECONDS,
    minDestroyDelaySeconds: env.SIGNER_MIN_DESTROY_DELAY_SECONDS,
    maxDestroyDelaySeconds: env.SIGNER_MAX_DESTROY_DELAY_SECONDS,
  };
}
