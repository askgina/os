import { readFileSync } from "node:fs";
import { MIN_SECRET_BYTES } from "@askgina/os-protocol/signer";
import {
  readSignerTls,
  type SignerTls,
  type SignerTlsFile,
  SignerTlsFileError,
} from "@askgina/os-protocol/signer-transport";
import { z } from "zod";

/** An optional variable. Compose passes an unset variable as "": that is unset, not a value. */
const OptionalSetting = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const TLS_VARIABLES: Record<SignerTlsFile, string> = {
  cert: "APPROVE_TLS_CERT_FILE",
  key: "APPROVE_TLS_KEY_FILE",
  peerCert: "APPROVE_TLS_PEER_CERT_FILE",
};

const Environment = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8788),
  /** The exact origin people open the confirmation page on, for example `https://approve.os.example.com`. */
  APPROVE_ORIGIN: z.string().min(1),
  /** For example `http://signer:8787`, or `https://signer:8787` with the signer on its own host. */
  SIGNER_URL: z.url({ protocol: /^https?$/ }),
  /** The confirm-scope secret the signer shares with this service, base64. */
  APPROVE_SIGNER_SECRET_FILE: z.string().min(1),
  /**
   * Mutual TLS to a signer at an `https:` SIGNER_URL: this service's certificate and key, and
   * the one certificate it accepts from the signer (PEM, `deploy/split/make-peer-certs.sh`).
   */
  APPROVE_TLS_CERT_FILE: OptionalSetting,
  APPROVE_TLS_KEY_FILE: OptionalSetting,
  APPROVE_TLS_PEER_CERT_FILE: OptionalSetting,
});

export interface ApproveConfig {
  port: number;
  approveOrigin: string;
  signerUrl: string;
  /** Reaches the signer's two confirm routes and nothing else. This service holds no other secret. */
  signerSecret: Uint8Array;
  /** Mutual TLS to the signer, set exactly when SIGNER_URL is `https:`. */
  signerTls: SignerTls | null;
}

/** A configuration problem. The message names the variable, never its value. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function loadConfig(environment: NodeJS.ProcessEnv): ApproveConfig {
  const parsed = Environment.safeParse(environment);

  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(`missing or invalid: ${names.join(", ")}`);
  }

  const env = parsed.data;

  let origin: URL;

  try {
    origin = new URL(env.APPROVE_ORIGIN);
  } catch {
    throw new ConfigError("APPROVE_ORIGIN: not an origin");
  }

  // The signer compares the origin in each assertion as an exact string.
  if (origin.origin !== env.APPROVE_ORIGIN || !["http:", "https:"].includes(origin.protocol)) {
    throw new ConfigError("APPROVE_ORIGIN: not a canonical http or https origin");
  }

  // Secrets are files holding base64 text, so they never appear in the process environment.
  let text: string;

  try {
    text = readFileSync(env.APPROVE_SIGNER_SECRET_FILE, "utf8").trim();
  } catch {
    throw new ConfigError("APPROVE_SIGNER_SECRET_FILE: file cannot be read");
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new ConfigError("APPROVE_SIGNER_SECRET_FILE: not base64");
  }

  const signerSecret = new Uint8Array(Buffer.from(text, "base64"));

  if (signerSecret.byteLength < MIN_SECRET_BYTES) {
    throw new ConfigError(`APPROVE_SIGNER_SECRET_FILE: fewer than ${MIN_SECRET_BYTES} bytes`);
  }

  // A half-configured split fails here, not silently in clear text: an `https:` signer needs
  // all three files, and an `http:` one takes none.
  const {
    APPROVE_TLS_CERT_FILE: cert,
    APPROVE_TLS_KEY_FILE: key,
    APPROVE_TLS_PEER_CERT_FILE: peerCert,
  } = env;

  let signerTls: SignerTls | null = null;

  if (new URL(env.SIGNER_URL).protocol === "https:") {
    if (cert === undefined || key === undefined || peerCert === undefined) {
      throw new ConfigError("APPROVE_TLS_*: an https SIGNER_URL needs all three");
    }

    try {
      signerTls = readSignerTls({ cert, key, peerCert });
    } catch (error) {
      if (!(error instanceof SignerTlsFileError)) throw error;
      throw new ConfigError(`${TLS_VARIABLES[error.file]}: ${error.message}`);
    }
  } else if ((cert ?? key ?? peerCert) !== undefined) {
    throw new ConfigError("APPROVE_TLS_*: set only with an https SIGNER_URL");
  }

  return {
    port: env.PORT,
    approveOrigin: env.APPROVE_ORIGIN,
    signerUrl: env.SIGNER_URL,
    signerSecret,
    signerTls,
  };
}
