import { createPrivateKey, X509Certificate } from "node:crypto";
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

/** Compose passes an unset variable as "": that is unset, not a value. */
const blankIsUnset = (value: unknown) => (value === "" ? undefined : value);

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
    blankIsUnset,
    z.coerce.number().int().min(0).max(7_776_000).default(DEFAULT_MIN_DESTROY_DELAY_SECONDS),
  ),
  SIGNER_MAX_DESTROY_DELAY_SECONDS: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(1).max(31_536_000).default(DEFAULT_MAX_DESTROY_DELAY_SECONDS),
  ),
  // The address to listen on. On its own host the signer listens on the private interface only.
  SIGNER_HOST: z.preprocess(blankIsUnset, z.string().min(1).default("0.0.0.0")),
  // Mutual TLS, for a signer on its own host: the signer's certificate and key, and the one
  // certificate each of its two clients presents. All four or none; none serves plain HTTP.
  SIGNER_TLS_CERT_FILE: z.preprocess(blankIsUnset, z.string().optional()),
  SIGNER_TLS_KEY_FILE: z.preprocess(blankIsUnset, z.string().optional()),
  SIGNER_TLS_CONTROL_CERT_FILE: z.preprocess(blankIsUnset, z.string().optional()),
  SIGNER_TLS_APPROVE_CERT_FILE: z.preprocess(blankIsUnset, z.string().optional()),
  // With TLS on, the main port needs a client certificate, so the container's health check uses
  // a plain listener on 127.0.0.1 that answers `GET /healthz` only. Not 8788: `approve` uses it.
  SIGNER_HEALTH_PORT: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(1).max(65_535).default(8789),
  ),
});

/**
 * The signer's side of mutual TLS, PEM. The control plane's certificate reaches control-scope
 * routes only, the `approve` service's confirm-scope routes only.
 */
export interface SignerTlsConfig {
  cert: Buffer;
  key: Buffer;
  control: Buffer;
  approve: Buffer;
}

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
  /** The address to listen on (`SIGNER_HOST`). */
  host: string;
  /** Mutual TLS when the signer runs on its own host; null serves plain HTTP, as on one machine. */
  tls: SignerTlsConfig | null;
  /** The plain loopback listener for the health check, used only with TLS. */
  healthPort: number;
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

function readPem(variable: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ConfigError(`${variable}: file cannot be read`);
  }
}

function readCertificate(variable: string, path: string): { pem: Buffer; der: Buffer } {
  const pem = readPem(variable, path);
  try {
    return { pem, der: new X509Certificate(pem).raw };
  } catch {
    throw new ConfigError(`${variable}: not a PEM certificate`);
  }
}

const TLS_VARIABLES = {
  cert: "SIGNER_TLS_CERT_FILE",
  control: "SIGNER_TLS_CONTROL_CERT_FILE",
  approve: "SIGNER_TLS_APPROVE_CERT_FILE",
} as const;

/**
 * Read the four TLS files and check them, so a wrong file stops boot instead of every
 * handshake: each certificate parses, the key is the signer's, and the three certificates are
 * distinct, since the signer tells its two clients apart by their certificates alone.
 */
function readTls(files: Record<keyof SignerTlsConfig, string>): SignerTlsConfig {
  const cert = readCertificate(TLS_VARIABLES.cert, files.cert);
  const control = readCertificate(TLS_VARIABLES.control, files.control);
  const approve = readCertificate(TLS_VARIABLES.approve, files.approve);
  const key = readPem("SIGNER_TLS_KEY_FILE", files.key);
  let matches: boolean;
  try {
    matches = new X509Certificate(cert.pem).checkPrivateKey(createPrivateKey(key));
  } catch {
    throw new ConfigError("SIGNER_TLS_KEY_FILE: not a PEM private key");
  }
  if (!matches) throw new ConfigError("SIGNER_TLS_KEY_FILE: not the key of SIGNER_TLS_CERT_FILE");
  if (control.der.equals(cert.der)) {
    throw new ConfigError(`${TLS_VARIABLES.control}: the signer's own certificate`);
  }
  if (approve.der.equals(cert.der)) {
    throw new ConfigError(`${TLS_VARIABLES.approve}: the signer's own certificate`);
  }
  if (control.der.equals(approve.der)) {
    throw new ConfigError(
      "SIGNER_TLS_APPROVE_CERT_FILE: the same certificate as SIGNER_TLS_CONTROL_CERT_FILE",
    );
  }
  return { cert: cert.pem, key, control: control.pem, approve: approve.pem };
}

export interface CertificateExpiry {
  variable: (typeof TLS_VARIABLES)[keyof typeof TLS_VARIABLES];
  /** Whole days until it expires; negative once it has. */
  daysLeft: number;
  expired: boolean;
}

/** When each of the three certificates expires, measured at `nowMs`, for the check at boot. */
export function certificateExpiry(tls: SignerTlsConfig, nowMs: number): CertificateExpiry[] {
  return (["cert", "control", "approve"] as const).map((name) => {
    const left = new X509Certificate(tls[name]).validToDate.getTime() - nowMs;
    return {
      variable: TLS_VARIABLES[name],
      daysLeft: Math.floor(left / 86_400_000),
      expired: left <= 0,
    };
  });
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
  const {
    SIGNER_TLS_CERT_FILE: cert,
    SIGNER_TLS_KEY_FILE: key,
    SIGNER_TLS_CONTROL_CERT_FILE: control,
    SIGNER_TLS_APPROVE_CERT_FILE: approve,
  } = env;
  let tls: SignerTlsConfig | null = null;
  if (cert !== undefined && key !== undefined && control !== undefined && approve !== undefined) {
    if (env.SIGNER_HEALTH_PORT === env.SIGNER_PORT) {
      throw new ConfigError("SIGNER_HEALTH_PORT: the same port as SIGNER_PORT");
    }
    tls = readTls({ cert, key, control, approve });
  } else if ((cert ?? key ?? control ?? approve) !== undefined) {
    // Half a TLS configuration would serve plain HTTP to a deployment that expects mutual TLS.
    throw new ConfigError("SIGNER_TLS_*: set all four or none");
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
    host: env.SIGNER_HOST,
    tls,
    healthPort: env.SIGNER_HEALTH_PORT,
  };
}
