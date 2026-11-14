import { readFileSync } from "node:fs";
import { MIN_SECRET_BYTES } from "@askgina/os-protocol/signer";
import { z } from "zod";

const Environment = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8788),
  /** The exact origin people open the confirmation page on, for example `https://approve.os.example.com`. */
  APPROVE_ORIGIN: z.string().min(1),
  /** For example `http://signer:8787`. */
  SIGNER_URL: z.url({ protocol: /^https?$/ }),
  /** The confirm-scope secret the signer shares with this service, base64. */
  APPROVE_SIGNER_SECRET_FILE: z.string().min(1),
});

export interface ApproveConfig {
  port: number;
  approveOrigin: string;
  signerUrl: string;
  /** Reaches the signer's two confirm routes and nothing else. This service holds no other secret. */
  signerSecret: Uint8Array;
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

  return {
    port: env.PORT,
    approveOrigin: env.APPROVE_ORIGIN,
    signerUrl: env.SIGNER_URL,
    signerSecret,
  };
}
