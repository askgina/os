import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { SignerAdminCommand } from "@askgina/os-api";
import { ChainId, VenueNetwork } from "@askgina/os-protocol";
import {
  readSignerTls,
  type SignerTls,
  type SignerTlsFile,
  SignerTlsFileError,
} from "@askgina/os-protocol/signer-transport";
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

/** One venue the control plane posts signed requests to and reads state from. */
export const VenueConfig = z.strictObject({
  network: VenueNetwork,
  /** The venue's API base, for example `https://api.hyperliquid-testnet.xyz`. */
  apiUrl: z.url({ protocol: /^https?$/ }),
});
export type VenueConfig = z.infer<typeof VenueConfig>;

/**
 * Hosts of Hyperliquid's mainnet API. Until the owner decides whether and where mainnet venue
 * support may ship (D2 in `specs/non-evm-operations.md`), naming one stops the boot, whatever
 * network the entry claims.
 */
const MAINNET_VENUE_HOSTS = ["api.hyperliquid.xyz"];

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** An optional setting where "" means unset: Compose passes an unset `${VAR:-}` as "". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** The variable behind each of the server's TLS files, for messages that name it. */
const TLS_VARIABLES: Record<SignerTlsFile, string> = {
  cert: "SIGNER_TLS_CERT_FILE",
  key: "SIGNER_TLS_KEY_FILE",
  peerCert: "SIGNER_TLS_PEER_CERT_FILE",
};

/** How an operator reaches the signer's admin commands on one machine with `compose.yaml`. */
const DEFAULT_SIGNER_ADMIN_COMMAND = "docker compose exec signer node src/admin.ts";

/** Where browsers' push services live. A subscription's endpoint must be under one of them. */
const DEFAULT_PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

/**
 * The longest `PUBLIC_ORIGIN` with Web Push on: every push message carries an approval link on
 * it and must fit 511 bytes with its text (`src/notify/content.ts`).
 */
const PUSH_ORIGIN_MAX_LENGTH = 128;

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
    // The key provider (`KEY_PROVIDER`, `KEYRING_FILE`, `OPENBAO_*`) is read and checked by
    // `keyProviderFromEnv` from `@askgina/os-keys`, which `main.ts` calls at boot.
    /** For example `http://signer:8787`, or `https://signer.example.internal:8787` on its own host. */
    SIGNER_URL: z.url({ protocol: /^https?$/ }),
    /** File holding the secret shared with the signer for request signatures. */
    SIGNER_HMAC_SECRET_FILE: z.string().min(1),
    /**
     * Mutual TLS to a signer at an `https:` SIGNER_URL: the control plane's certificate and key,
     * and the one certificate it accepts from the signer (PEM, `deploy/split/make-peer-certs.sh`).
     * All three with an `https:` SIGNER_URL, none with an `http:` one.
     */
    SIGNER_TLS_CERT_FILE: optional(z.string().min(1)),
    SIGNER_TLS_KEY_FILE: optional(z.string().min(1)),
    SIGNER_TLS_PEER_CERT_FILE: optional(z.string().min(1)),
    /**
     * What an operator types on the signer's host before one of its admin commands, shown to
     * owners next to a passkey that waits to approve. Pasted into a root shell, so only words of
     * `[A-Za-z0-9_./:-]` separated by single spaces.
     */
    SIGNER_ADMIN_COMMAND: optional(SignerAdminCommand).transform(
      (value) => value ?? DEFAULT_SIGNER_ADMIN_COMMAND,
    ),
    /** JSON array of {@link ChainConfig}. */
    CHAINS_FILE: z.string().min(1),
    /**
     * JSON array of {@link VenueConfig}, at most one per network. Unset: venue features answer
     * "not configured". Testnet only: a mainnet entry stops the boot (D2).
     */
    VENUES_FILE: optional(z.string().min(1)),
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
    /**
     * `0` stops the control plane from repricing a transaction that is not mined by itself; an
     * approver can still speed one up. On unless set.
     */
    REPRICE_AUTO: optional(z.enum(["0", "1"])).transform((value) => value !== "0"),
    /** How long the newest attempt of a transaction waits unmined before an automatic reprice. */
    REPRICE_AFTER_SECONDS: integer(180, 15, 86_400),
    /**
     * How much each reprice raises both fees above the newest attempt's, in percent. go-ethereum
     * and reth replace a pooled transaction only for at least 10.
     */
    REPRICE_BUMP_PERCENT: integer(12, 10, 100),
    WORKFLOW_WORKER_CONCURRENCY: integer(10, 1, 200),
    /**
     * How long an unwrapped data key stays in this process's memory, 0 to 600 seconds. A shred in
     * any replica reaches every replica's cache at once (`LISTEN os_keys_shred`); this is the
     * upper bound while that connection is down, when nothing is cached anyway.
     */
    DATA_KEY_CACHE_SECONDS: optional(z.coerce.number().int().min(0).max(600)).transform(
      (value) => value ?? 60,
    ),
    /**
     * How many proxies append to `X-Forwarded-For` in front of the server, 1 to 5: the address
     * this many entries from the end is the client a failed agent authentication is charged to.
     * 1 behind the bundled Caddy; 2 with one load balancer in front of it.
     */
    FORWARDED_HOPS: optional(z.coerce.number().int().min(1).max(5)).transform(
      (value) => value ?? 1,
    ),
    /**
     * `false` (or `0`) keeps the setup token out of the server's log: boots then mint none, and
     * the operator gets one from `node apps/server/src/cli.ts setup-token`. On unless set.
     */
    SETUP_TOKEN_IN_LOG: optional(z.enum(["0", "1", "false", "true"])).transform(
      (value) => value !== "0" && value !== "false",
    ),
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
  // A half-configured split fails at boot, not silently in clear text.
  .refine(
    (env) =>
      new URL(env.SIGNER_URL).protocol !== "https:" ||
      (env.SIGNER_TLS_CERT_FILE !== undefined &&
        env.SIGNER_TLS_KEY_FILE !== undefined &&
        env.SIGNER_TLS_PEER_CERT_FILE !== undefined),
    {
      path: ["SIGNER_TLS_CERT_FILE"],
      message: "an https SIGNER_URL needs all three SIGNER_TLS_* files",
    },
  )
  .refine(
    (env) =>
      new URL(env.SIGNER_URL).protocol === "https:" ||
      (env.SIGNER_TLS_CERT_FILE ?? env.SIGNER_TLS_KEY_FILE ?? env.SIGNER_TLS_PEER_CERT_FILE) ===
        undefined,
    {
      path: ["SIGNER_TLS_CERT_FILE"],
      message: "SIGNER_TLS_* files are set only with an https SIGNER_URL",
    },
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
      !env.WEB_PUSH_ENABLED || new URL(env.PUBLIC_ORIGIN).origin.length <= PUSH_ORIGIN_MAX_LENGTH,
    {
      path: ["PUBLIC_ORIGIN"],
      message: `must be at most ${PUSH_ORIGIN_MAX_LENGTH} characters with WEB_PUSH_ENABLED=1`,
    },
  )
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

/** A configuration file that cannot be used. The message names the variable, never its content. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

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

/** Repricing a sent transaction that is not mined (`src/execution/repricing.ts`). */
export interface RepriceConfig {
  /** Whether the follow-up reprices by itself. */
  auto: boolean;
  afterSeconds: number;
  bumpPercent: number;
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
  signerUrl: string;
  signerSecret: Uint8Array;
  /** Mutual TLS to the signer, set exactly when `signerUrl` is `https:`. */
  signerTls: SignerTls | null;
  /** The prefix of the signer's admin commands on its host (`SIGNER_ADMIN_COMMAND`). */
  signerAdminCommand: string;
  chains: ChainConfig[];
  /** The venues orders go to; empty when `VENUES_FILE` is unset. Never a mainnet venue (D2). */
  venues: VenueConfig[];
  webDistDir: string | undefined;
  sessionTtlSeconds: number;
  adminApprovalTtlSeconds: number;
  mandateMaxSeconds: number;
  reconcileTimeoutSeconds: number;
  reprice: RepriceConfig;
  workflowWorkerConcurrency: number;
  /** Seconds an unwrapped data key may stay in memory; 0 caches nothing. */
  dataKeyCacheSeconds: number;
  /** Which `X-Forwarded-For` entry, counted from the end, names the client. */
  forwardedHops: number;
  /** Whether a boot before setup mints the setup token and logs it. */
  setupTokenInLog: boolean;
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

/** Read the venues file; a mainnet venue, or a second entry for one network, stops the boot. */
function venues(file: string | undefined): VenueConfig[] {
  if (file === undefined) return [];
  let entries: VenueConfig[];
  try {
    entries = z
      .array(VenueConfig)
      .max(2)
      .parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new ConfigError(
      "VENUES_FILE: expected a JSON array of { network, apiUrl } with network hyperliquid:testnet",
    );
  }
  for (const entry of entries) {
    const host = new URL(entry.apiUrl).hostname.toLowerCase();
    if (entry.network === "hyperliquid:mainnet" || MAINNET_VENUE_HOSTS.includes(host)) {
      throw new ConfigError(
        "VENUES_FILE: Hyperliquid mainnet is refused until the owner decides D2 (whether and where mainnet venue support may ship); configure hyperliquid:testnet only",
      );
    }
  }
  if (new Set(entries.map((entry) => entry.network)).size !== entries.length) {
    throw new ConfigError("VENUES_FILE: at most one entry per network");
  }
  return entries;
}

function signerTls(parsed: {
  SIGNER_TLS_CERT_FILE?: string | undefined;
  SIGNER_TLS_KEY_FILE?: string | undefined;
  SIGNER_TLS_PEER_CERT_FILE?: string | undefined;
}): SignerTls | null {
  const {
    SIGNER_TLS_CERT_FILE: cert,
    SIGNER_TLS_KEY_FILE: key,
    SIGNER_TLS_PEER_CERT_FILE: peerCert,
  } = parsed;
  // The schema allows all three or none, by the scheme of SIGNER_URL.
  if (cert === undefined || key === undefined || peerCert === undefined) return null;
  try {
    return readSignerTls({ cert, key, peerCert });
  } catch (error) {
    if (!(error instanceof SignerTlsFileError)) throw error;
    throw new ConfigError(`${TLS_VARIABLES[error.file]}: ${error.message}`);
  }
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
    signerUrl: parsed.SIGNER_URL,
    signerSecret: new Uint8Array(
      Buffer.from(readFileSync(parsed.SIGNER_HMAC_SECRET_FILE, "utf8").trim(), "base64"),
    ),
    signerTls: signerTls(parsed),
    signerAdminCommand: parsed.SIGNER_ADMIN_COMMAND,
    chains: z
      .array(ChainConfig)
      .min(1)
      .parse(JSON.parse(readFileSync(parsed.CHAINS_FILE, "utf8"))),
    venues: venues(parsed.VENUES_FILE),
    webDistDir: parsed.WEB_DIST_DIR,
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
    adminApprovalTtlSeconds: parsed.ADMIN_APPROVAL_TTL_SECONDS,
    mandateMaxSeconds: parsed.MANDATE_MAX_SECONDS,
    reconcileTimeoutSeconds: parsed.RECONCILE_TIMEOUT_SECONDS,
    reprice: {
      auto: parsed.REPRICE_AUTO,
      afterSeconds: parsed.REPRICE_AFTER_SECONDS,
      bumpPercent: parsed.REPRICE_BUMP_PERCENT,
    },
    workflowWorkerConcurrency: parsed.WORKFLOW_WORKER_CONCURRENCY,
    dataKeyCacheSeconds: parsed.DATA_KEY_CACHE_SECONDS,
    forwardedHops: parsed.FORWARDED_HOPS,
    setupTokenInLog: parsed.SETUP_TOKEN_IN_LOG,
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
