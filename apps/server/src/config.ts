import { createPrivateKey, createPublicKey } from "node:crypto";
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

/** An optional setting where "" means unset: Compose passes an unset `${VAR:-}` as "". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** Where browsers' push services live. A subscription's endpoint must be under one of them. */
const DEFAULT_PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

/** A VAPID subject (RFC 8292 §2.1): how a push service reaches the operator. */
const PushSubject = z
  .string()
  .refine((value) => /^mailto:.+/.test(value) || /^https:\/\/.+/.test(value), {
    message: "must be a mailto: or https: URI",
  });

/** A host suffix: lowercase DNS labels, no scheme, port or path. */
const HostSuffix = z
  .string()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    {
      message: "must be a lowercase host name",
    },
  );

const Environment = z
  .object({
    /**
     * The exact origin people open in their browser, for example `http://localhost:8080` or
     * `https://os.example.com`. Passkeys are bound to it: changing its host later means every
     * passkey must be registered again.
     */
    PUBLIC_ORIGIN: z.url(),
    /** Defaults to the host of `PUBLIC_ORIGIN`. */
    WEBAUTHN_RP_ID: z.string().min(1).optional(),
    /**
     * The signer's confirmation page, where people approve with their passkeys: a host under the
     * RP ID or another port on it, never `PUBLIC_ORIGIN`. Assertions collected from there must
     * carry exactly this origin.
     */
    APPROVE_ORIGIN: z.url({ protocol: /^https?$/ }),
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
    /** How long approvals of policies, approvers, thresholds, resumes and mandates stay open. */
    ADMIN_APPROVAL_TTL_SECONDS: integer(3_600, 60, 86_400),
    /**
     * The longest life of a mandate a person may propose, checked when they propose it. Set it
     * equal to the signer's `SIGNER_MAX_MANDATE_SECONDS`, whose value decides.
     */
    MANDATE_MAX_SECONDS: integer(604_800, 3_600, 2_592_000),
    /** How long a broadcast transaction is watched before it is reported as stuck. */
    RECONCILE_TIMEOUT_SECONDS: integer(3_600, 30, 604_800),
    WORKFLOW_WORKER_CONCURRENCY: integer(10, 1, 200),
    /**
     * If set, receives a signed POST with identifiers only when an approval waits and when a
     * mandate is used, retried until it is accepted (see `src/notify/webhook.ts`).
     */
    NOTIFY_WEBHOOK_URL: optional(z.url({ protocol: /^https?$/ })),
    /**
     * File holding the webhook's signing secret, at least 32 characters; its trimmed text is the
     * HMAC key. Required with `NOTIFY_WEBHOOK_URL`.
     */
    NOTIFY_WEBHOOK_SECRET_FILE: optional(z.string().min(1)),
    /**
     * `1` sends Web Push notifications through browsers' push services, third parties that see
     * when and how often a device is notified. Off unless set.
     */
    WEB_PUSH_ENABLED: optional(z.enum(["0", "1"])).transform((value) => value === "1"),
    /** PKCS#8 PEM file with the P-256 VAPID key. Required with `WEB_PUSH_ENABLED=1`. */
    WEB_PUSH_VAPID_KEY_FILE: optional(z.string().min(1)),
    /** `mailto:` or `https:` contact for push services. Defaults to an https `PUBLIC_ORIGIN`. */
    WEB_PUSH_SUBJECT: optional(PushSubject),
    /** Comma-separated host suffixes a subscription endpoint must be under, over `https:`. */
    WEB_PUSH_ENDPOINT_HOSTS: optional(
      z
        .string()
        .transform((value) =>
          value
            .split(",")
            .map((host) => host.trim())
            .filter((host) => host.length > 0),
        )
        .pipe(z.array(HostSuffix).min(1)),
    ),
  })
  .refine(
    // On the control plane's own origin the confirmation page would protect nothing.
    (env) => new URL(env.APPROVE_ORIGIN).origin !== new URL(env.PUBLIC_ORIGIN).origin,
    { path: ["APPROVE_ORIGIN"], message: "must not be PUBLIC_ORIGIN" },
  )
  .refine(
    (env) => env.NOTIFY_WEBHOOK_URL === undefined || env.NOTIFY_WEBHOOK_SECRET_FILE !== undefined,
    { path: ["NOTIFY_WEBHOOK_SECRET_FILE"], message: "is required with NOTIFY_WEBHOOK_URL" },
  )
  .refine((env) => !env.WEB_PUSH_ENABLED || env.WEB_PUSH_VAPID_KEY_FILE !== undefined, {
    path: ["WEB_PUSH_VAPID_KEY_FILE"],
    message: "is required with WEB_PUSH_ENABLED=1",
  })
  .refine(
    (env) =>
      !env.WEB_PUSH_ENABLED ||
      env.WEB_PUSH_SUBJECT !== undefined ||
      new URL(env.PUBLIC_ORIGIN).protocol === "https:",
    {
      path: ["WEB_PUSH_SUBJECT"],
      message: "is required with WEB_PUSH_ENABLED=1 when PUBLIC_ORIGIN is not https",
    },
  );

/** The webhook's shortest secret, so a guessable one fails at boot. */
const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** Web Push settings; present only when it is enabled. */
export interface WebPushConfig {
  /** The VAPID `sub` claim. */
  subject: string;
  /** Host suffixes a subscription endpoint must be under. */
  endpointHosts: string[];
  /** The VAPID private key, PKCS#8 DER. */
  vapidPrivateKey: Uint8Array;
  /** The VAPID public key, an uncompressed P-256 point (65 bytes): the application server key. */
  vapidPublicKey: Uint8Array;
}

export interface NotifyConfig {
  webhook: { url: string; secret: Uint8Array } | null;
  webPush: WebPushConfig | null;
}

export interface Config {
  publicOrigin: string;
  relyingParty: { id: string; name: string; origins: string[] };
  /** The signer's confirmation page's origin. */
  approveOrigin: string;
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
  mandateMaxSeconds: number;
  reconcileTimeoutSeconds: number;
  workflowWorkerConcurrency: number;
  notify: NotifyConfig;
}

function webhookSecret(file: string): Uint8Array {
  const text = readFileSync(file, "utf8").trim();
  if (text.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(
      `NOTIFY_WEBHOOK_SECRET_FILE must hold at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`,
    );
  }
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/** Read the VAPID key; anything but a P-256 private key stops the boot. */
function vapidKeys(file: string): Pick<WebPushConfig, "vapidPrivateKey" | "vapidPublicKey"> {
  const key = createPrivateKey(readFileSync(file, "utf8"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("WEB_PUSH_VAPID_KEY_FILE must hold a P-256 (prime256v1) private key");
  }
  const jwk = createPublicKey(key).export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) throw new Error("VAPID key has no public point");
  return {
    vapidPrivateKey: new Uint8Array(key.export({ format: "der", type: "pkcs8" })),
    vapidPublicKey: new Uint8Array(
      Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]),
    ),
  };
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
    approveOrigin: new URL(parsed.APPROVE_ORIGIN).origin,
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
    mandateMaxSeconds: parsed.MANDATE_MAX_SECONDS,
    reconcileTimeoutSeconds: parsed.RECONCILE_TIMEOUT_SECONDS,
    workflowWorkerConcurrency: parsed.WORKFLOW_WORKER_CONCURRENCY,
    notify: {
      webhook:
        parsed.NOTIFY_WEBHOOK_URL !== undefined && parsed.NOTIFY_WEBHOOK_SECRET_FILE !== undefined
          ? {
              url: parsed.NOTIFY_WEBHOOK_URL,
              secret: webhookSecret(parsed.NOTIFY_WEBHOOK_SECRET_FILE),
            }
          : null,
      webPush:
        parsed.WEB_PUSH_ENABLED && parsed.WEB_PUSH_VAPID_KEY_FILE !== undefined
          ? {
              subject: parsed.WEB_PUSH_SUBJECT ?? origin,
              endpointHosts: parsed.WEB_PUSH_ENDPOINT_HOSTS ?? DEFAULT_PUSH_ENDPOINT_HOSTS,
              ...vapidKeys(parsed.WEB_PUSH_VAPID_KEY_FILE),
            }
          : null,
    },
  };
}
