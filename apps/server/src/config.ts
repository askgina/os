import { readFileSync } from "node:fs";
import { ChainId } from "@askgina/os-protocol";
import { z } from "zod";

/** One chain the control plane can read from and broadcast to. */
export const ChainConfig = z.strictObject({
  chainId: ChainId,
  name: z.string().min(1),
  /** JSON-RPC endpoint. May carry an API key, so the chains file is a secret. */
  rpcUrl: z.url(),
  nativeSymbol: z.string().min(1).max(12),
  /** Base URL of a block explorer; transaction links are `${explorerUrl}/tx/${hash}`. */
  explorerUrl: z.url().nullable().default(null),
  /** Blocks on top of a transaction before it counts as confirmed. */
  confirmations: z.number().int().min(1).max(64).default(1),
});
export type ChainConfig = z.infer<typeof ChainConfig>;

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const Environment = z.object({
  /**
   * The exact origin people open in their browser, for example `http://localhost:8080` or
   * `https://os.example.com`. Passkeys are bound to it: changing its host later means every
   * passkey must be registered again.
   */
  PUBLIC_ORIGIN: z.url(),
  /** Defaults to the host of `PUBLIC_ORIGIN`. */
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).default("Ask Gina OS"),

  HOST: z.string().default("0.0.0.0"),
  /** Serves the UI, the API and the MCP gateway. */
  PORT: integer(3000, 1, 65_535),
  /**
   * Serves the Workflow runtime's delivery routes on 127.0.0.1 only. Upstream leaves those
   * routes unauthenticated, so they are never mounted on the public listener.
   */
  INTERNAL_PORT: integer(3001, 1, 65_535),

  DATABASE_URL: z.string().min(1),
  /**
   * File holding the database password, for setups that keep it out of the environment. When
   * set, it replaces the password part of `DATABASE_URL`.
   */
  DATABASE_PASSWORD_FILE: z.string().min(1).optional(),
  /** Keyring JSON with the key-encryption keys. Kept outside the database. */
  KEYRING_FILE: z.string().min(1),
  SIGNER_URL: z.url(),
  /** File holding the secret shared with the signer for request signatures. */
  SIGNER_HMAC_SECRET_FILE: z.string().min(1),
  /** JSON array of {@link ChainConfig}. */
  CHAINS_FILE: z.string().min(1),
  /** Directory with the built UI (`apps/web/dist`). */
  WEB_DIST_DIR: z.string().min(1).optional(),

  SESSION_TTL_SECONDS: integer(43_200, 300, 2_592_000),
  /** How long approvals of policies, approvers, thresholds and resumes stay open. */
  ADMIN_APPROVAL_TTL_SECONDS: integer(3_600, 60, 86_400),
  /** How long a broadcast transaction is watched before it is reported as stuck. */
  RECONCILE_TIMEOUT_SECONDS: integer(3_600, 30, 604_800),
  WORKFLOW_WORKER_CONCURRENCY: integer(10, 1, 200),
  /**
   * If set, receives a POST with no transaction details whenever an approval is waiting. An
   * empty value means unset: Compose passes `${NOTIFY_WEBHOOK_URL:-}` through as "".
   */
  NOTIFY_WEBHOOK_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().optional(),
  ),
});

export interface Config {
  publicOrigin: string;
  relyingParty: { id: string; name: string; origins: string[] };
  host: string;
  port: number;
  internalPort: number;
  databaseUrl: string;
  keyringFile: string;
  signerUrl: string;
  signerSecret: Uint8Array;
  chains: ChainConfig[];
  webDistDir: string | undefined;
  sessionTtlSeconds: number;
  adminApprovalTtlSeconds: number;
  reconcileTimeoutSeconds: number;
  workflowWorkerConcurrency: number;
  notifyWebhookUrl: string | undefined;
}

/** Read and check the whole configuration once, at boot. A bad value stops the process. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Environment.parse(env);
  const origin = new URL(parsed.PUBLIC_ORIGIN).origin;
  const databaseUrl = new URL(parsed.DATABASE_URL);
  if (parsed.DATABASE_PASSWORD_FILE !== undefined) {
    databaseUrl.password = readFileSync(parsed.DATABASE_PASSWORD_FILE, "utf8").trim();
  }
  return {
    publicOrigin: origin,
    relyingParty: {
      id: parsed.WEBAUTHN_RP_ID ?? new URL(origin).hostname,
      name: parsed.WEBAUTHN_RP_NAME,
      origins: [origin],
    },
    host: parsed.HOST,
    port: parsed.PORT,
    internalPort: parsed.INTERNAL_PORT,
    databaseUrl: databaseUrl.toString(),
    keyringFile: parsed.KEYRING_FILE,
    signerUrl: parsed.SIGNER_URL,
    signerSecret: new Uint8Array(
      Buffer.from(readFileSync(parsed.SIGNER_HMAC_SECRET_FILE, "utf8").trim(), "base64"),
    ),
    chains: z
      .array(ChainConfig)
      .min(1)
      .parse(JSON.parse(readFileSync(parsed.CHAINS_FILE, "utf8"))),
    webDistDir: parsed.WEB_DIST_DIR,
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
    adminApprovalTtlSeconds: parsed.ADMIN_APPROVAL_TTL_SECONDS,
    reconcileTimeoutSeconds: parsed.RECONCILE_TIMEOUT_SECONDS,
    workflowWorkerConcurrency: parsed.WORKFLOW_WORKER_CONCURRENCY,
    notifyWebhookUrl: parsed.NOTIFY_WEBHOOK_URL,
  };
}
