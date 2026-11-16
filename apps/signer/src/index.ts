import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import {
  type Address,
  ApprovalId,
  type ApproverCredential,
  type AssetLabel,
  type ChainLabel,
  MandateId,
  WalletId,
  type WorkspaceId,
  WorkspaceId as WorkspaceIdSchema,
} from "@askgina/os-protocol";
import {
  AddApproverRequest,
  AuthorizedRequest,
  CancelTransactionRequest,
  CancelVenueOrderRequest,
  CONFIRM_TOKEN_HEADER,
  CreateWalletRequest,
  CreateWorkspaceRequest,
  GrantMandateRequest,
  MAX_CLOCK_SKEW_SECONDS,
  type MandateState,
  MIN_SECRET_BYTES,
  OpenConfirmationRequest,
  RepriceRequest,
  RetireWalletStepRequest,
  RevokeApprovalRequest,
  RevokeMandateRequest,
  SetPolicyRequest,
  SIGNATURE_HEADER,
  SignRequest,
  SignUnderMandateRequest,
  SignVenueRequest,
  SubmitConfirmationRequest,
  SubmitPossessionRequest,
  SweepRequest,
  signerRoutes,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
} from "@askgina/os-protocol/signer";
import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_MAX_TX_ATTEMPTS, DEFAULT_REPRICE_WINDOW_SECONDS } from "./attempts.ts";
import { createConfirmations } from "./confirmations.ts";
import { openDatabase, transaction } from "./db.ts";
import { SignerFailure } from "./errors.ts";
import { FENCE_BY_OPERATOR, fenceReplacedDatabase, raiseFence } from "./fence.ts";
import type { JsonValue } from "./json.ts";
import {
  DEFAULT_MAX_DESTROY_DELAY_SECONDS,
  DEFAULT_MIN_DESTROY_DELAY_SECONDS,
} from "./lifecycle.ts";
import { type Logger, silentLogger } from "./log.ts";
import { DEFAULT_MAX_LIVE_MANDATES_PER_WALLET, DEFAULT_MAX_MANDATE_SECONDS } from "./mandates.ts";
import { createSignerCore } from "./signer.ts";
import type { Vault } from "./vault.ts";

export { SCHEMA_VERSION, SchemaTooNewError } from "./db.ts";

export {
  DEFAULT_MAX_DESTROY_DELAY_SECONDS,
  DEFAULT_MIN_DESTROY_DELAY_SECONDS,
  LIFECYCLE_ACTIONS,
} from "./lifecycle.ts";

export type { Logger } from "./log.ts";

export { createLogger } from "./log.ts";

export {
  createTestVault,
  type EvmTransaction,
  exportOwsWalletSecret,
  OwsVault,
  type Vault,
  VaultError,
} from "./vault.ts";

const VERSION = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;

export interface SignerOptions {
  /** SQLite file, or ":memory:" for tests. */
  sqlitePath: string;
  vault: Vault;
  /** The RP ID passkeys were registered under. */
  rpId: string;
  /** Shared with the control plane; authenticates every control-scope route. */
  requestSecret: Uint8Array;
  /**
   * Shared with the `approve` service; authenticates the confirm-scope routes and nothing
   * else. At least 32 bytes, and not the request secret.
   */
  confirmSecret: Uint8Array;
  /**
   * The confirmation page's exact origin, a host under the RP ID. The signer accepts an approval,
   * for signing and applying as on the confirmation routes, only when it was made top-level on
   * this origin. Never the control plane's origin.
   */
  approvalOrigin: string;
  /** The control plane's origin, where the confirmation page sends the person afterwards. */
  returnOrigin: string;
  /** Chain names and native coins, from the operator's chains file. */
  chains: readonly ChainLabel[];
  /** Token symbols and decimals, from the operator's assets file. */
  assets: readonly AssetLabel[];
  /** 32 bytes. Seals the vault credentials stored in SQLite. */
  tokenKey: Uint8Array;
  maxIntentTtlSeconds: number;
  maxAdminTtlSeconds: number;
  /**
   * The longest life the signer grants a mandate, counted from now or from its start when that
   * is later (`SIGNER_MAX_MANDATE_SECONDS`). Defaults to seven days.
   */
  maxMandateSeconds?: number;
  /** How many live mandates one wallet may hold (`SIGNER_MAX_LIVE_MANDATES_PER_WALLET`). */
  maxLiveMandatesPerWallet?: number;
  /**
   * Attempts per approval, the first signature included (`SIGNER_MAX_TX_ATTEMPTS`). Defaults
   * to 16.
   */
  maxTxAttempts?: number;
  /**
   * How long after the first signature a reprice is signed with no person
   * (`SIGNER_REPRICE_WINDOW_SECONDS`). Defaults to a day; 0 refuses every reprice.
   */
  repriceWindowSeconds?: number;
  /**
   * The shortest `destroyAfter − issuedAt` a retirement or deletion may have
   * (`SIGNER_MIN_DESTROY_DELAY_SECONDS`). Defaults to seven days.
   */
  minDestroyDelaySeconds?: number;
  /** The longest (`SIGNER_MAX_DESTROY_DELAY_SECONDS`). Defaults to 90 days. */
  maxDestroyDelaySeconds?: number;
  /**
   * The certificates (PEM) of the signer's two TLS clients, when it serves mutual TLS on its own
   * host. The client certificate a request's connection verified then decides its scope, before
   * the request signature is checked: the control plane's reaches control-scope routes only, the
   * `approve` service's confirm-scope routes only, so a stolen confirm secret is useless from the
   * control host. Unset, as on one machine, the request signature alone decides.
   */
  clientCertificates?: { control: Uint8Array; approve: Uint8Array };
  /** Seconds since the Unix epoch. Tests inject a clock. */
  now?: () => number;
  log?: Logger;
}

export interface Signer {
  app: Hono;
  /**
   * Enroll an approver without passkey assertions, for an operator who lost every passkey. Not
   * reachable over HTTP: only the admin CLI on the signer host calls it.
   */
  enrollApproverByOperator(workspaceId: WorkspaceId, approver: ApproverCredential): void;
  verifyDecisionLog(workspaceId: WorkspaceId): { ok: boolean; brokenAt: number | null };
  /**
   * Set the restore fence to now: every envelope issued before it is refused from here on, and
   * every live mandate is revoked. Not reachable over HTTP: only the admin CLI on the signer host
   * calls it, as part of a restore. Returns the fence in force, in seconds since the Unix epoch.
   */
  fence(): number;
  /** Every mandate of a workspace, for the admin CLI. */
  listWorkspaceMandates(workspaceId: WorkspaceId): MandateState[];
  /**
   * End one mandate with reason `operator`, recorded as `revoke-mandate-by-operator`. Returns
   * the ids it revoked: none when it was revoked already. Only the admin CLI calls it.
   */
  revokeMandateByOperator(mandateId: MandateId): MandateId[];
  /** End every live mandate of a workspace with reason `operator`. Only the admin CLI calls it. */
  revokeWorkspaceMandatesByOperator(workspaceId: WorkspaceId): MandateId[];
  /**
   * Read a wallet's secret through `exportSecret`, recorded as `export-wallet-by-operator`, and
   * refused for a destroyed wallet (`wallet_retired`). Only the admin CLI calls it.
   */
  exportWalletByOperator(
    workspaceId: WorkspaceId,
    walletId: WalletId,
    exportSecret: (walletId: WalletId) => string,
  ): Promise<{ address: Address; secret: string }>;
  close(): void;
}

type RouteName = keyof typeof signerRoutes;

// Compiled once from the contract, so a path or method the contract does not name has no handler.
const compiledRoutes = Object.entries(signerRoutes).map(([name, route]) => {
  const names: string[] = [];

  const pattern = route.path.replace(/:([A-Za-z]+)/g, (_match, param: string) => {
    names.push(param);

    return "([^/]+)";
  });

  // SAFETY: Object.entries of the `signerRoutes` object literal yields its own keys and nothing
  // else, and RouteName is exactly those keys.
  return {
    name: name as RouteName,
    method: route.method,
    regex: new RegExp(`^${pattern}$`),
    names,
  };
});

type MatchedRoute = { name: RouteName; params: Record<string, string> };

/** The contract route for a request; a path that names none, or does not decode, is not found. */
function matchRoute(method: string, path: string): MatchedRoute {
  for (const route of compiledRoutes) {
    if (route.method !== method) continue;
    const match = route.regex.exec(path);

    if (!match) continue;
    const params: Record<string, string> = {};

    for (const [index, name] of route.names.entries()) {
      try {
        params[name] = decodeURIComponent(match[index + 1] ?? "");
      } catch {
        throw new SignerFailure("not_found");
      }
    }

    return { name: route.name, params };
  }

  throw new SignerFailure("not_found");
}

/** Far above any valid request (a policy with every list full is about 60 KiB). */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Read the body, giving up as soon as it passes the limit. Content-Length is only a hint (a
 * chunked request has none), so the count is taken while reading, before anything is buffered
 * past the limit and before the request is authenticated.
 */
async function readBody(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.byteLength;

    if (total > MAX_BODY_BYTES) {
      await stream.cancel().catch(() => undefined);
      throw new SignerFailure("invalid_request");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

type SignedScope = "control" | "confirm";

const derFingerprint = (der: Uint8Array) => createHash("sha256").update(der).digest("hex");

/** Each client certificate's fingerprint, the SHA-256 of its DER, mapped to the scope it reaches. */
function clientScopes(certificates: SignerOptions["clientCertificates"]) {
  if (certificates === undefined) return null;
  const control = derFingerprint(new X509Certificate(certificates.control).raw);
  const approve = derFingerprint(new X509Certificate(certificates.approve).raw);

  if (control === approve) throw new RangeError("the two client certificates must differ");

  return new Map<string, SignedScope>([
    [control, "control"],
    [approve, "confirm"],
  ]);
}

/**
 * What `@hono/node-server` passes along as `c.env`: the Node request, whose socket is the TLS
 * socket. A request that did not come through it (`app.request` in tests) has none.
 */
const NodeBindings = z.object({ incoming: z.instanceof(IncomingMessage) });

/**
 * The fingerprint of the client certificate the request's TLS connection verified, or null for
 * a request that did not arrive over a verified TLS connection.
 */
function verifiedClientFingerprint(incoming: IncomingMessage | undefined): string | null {
  if (incoming === undefined) return null;
  const socket = incoming.socket;

  if (!(socket instanceof TLSSocket) || !socket.authorized) return null;
  const { raw } = socket.getPeerCertificate();

  return Buffer.isBuffer(raw) ? derFingerprint(raw) : null;
}

function parse<S extends z.ZodType>(schema: S, value: JsonValue | undefined): z.infer<S> {
  const result = schema.safeParse(value);

  if (!result.success) throw new SignerFailure("invalid_request");

  return result.data;
}

function parseBody(body: Uint8Array): JsonValue {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new SignerFailure("invalid_request");
  }
}

function pageNumber(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;

  if (!/^[0-9]{1,9}$/.test(raw)) throw new SignerFailure("invalid_request");
  const value = Number(raw);

  if (value > max) throw new SignerFailure("invalid_request");

  return value;
}

export function createSigner(options: SignerOptions): Signer {
  if (options.tokenKey.byteLength !== 32) throw new RangeError("tokenKey must be 32 bytes");

  if (options.confirmSecret.byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(`confirmSecret must be at least ${MIN_SECRET_BYTES} bytes`);
  }

  // One secret for both scopes would let the `approve` service call every route.
  if (Buffer.from(options.confirmSecret).equals(Buffer.from(options.requestSecret))) {
    throw new RangeError("confirmSecret must differ from requestSecret");
  }

  const secrets = { control: options.requestSecret, confirm: options.confirmSecret };
  const scopeOfClient = clientScopes(options.clientCertificates);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? silentLogger;
  const maxMandateSeconds = options.maxMandateSeconds ?? DEFAULT_MAX_MANDATE_SECONDS;
  const maxTxAttempts = options.maxTxAttempts ?? DEFAULT_MAX_TX_ATTEMPTS;

  const minDestroyDelaySeconds =
    options.minDestroyDelaySeconds ?? DEFAULT_MIN_DESTROY_DELAY_SECONDS;

  const maxDestroyDelaySeconds =
    options.maxDestroyDelaySeconds ?? DEFAULT_MAX_DESTROY_DELAY_SECONDS;

  if (minDestroyDelaySeconds < 0 || maxDestroyDelaySeconds < minDestroyDelaySeconds) {
    throw new RangeError("the destroy delay bounds must satisfy 0 <= min <= max");
  }

  const { db, created } = openDatabase(options.sqlitePath);

  // Before anything is served: a database file that is not the one last recorded may be a
  // restored copy that forgot what it signed after the copy was made.
  const fencedAt = transaction(db, () =>
    fenceReplacedDatabase(db, options.sqlitePath, created, now()),
  );

  if (fencedAt !== null) {
    log.warn("restore fence set", { reason: "new_database_file", fenceAt: fencedAt });
  }

  const core = createSignerCore({
    db,
    vault: options.vault,
    relyingParty: { id: options.rpId, origins: [options.approvalOrigin] },
    tokenKey: options.tokenKey,
    maxIntentTtlSeconds: options.maxIntentTtlSeconds,
    maxAdminTtlSeconds: options.maxAdminTtlSeconds,
    maxMandateSeconds,
    maxLiveMandatesPerWallet:
      options.maxLiveMandatesPerWallet ?? DEFAULT_MAX_LIVE_MANDATES_PER_WALLET,
    maxTxAttempts,
    repriceWindowSeconds: options.repriceWindowSeconds ?? DEFAULT_REPRICE_WINDOW_SECONDS,
    minDestroyDelaySeconds,
    maxDestroyDelaySeconds,
    now,
    log,
  });

  const confirmations = createConfirmations({
    db,
    records: core.records,
    rpId: options.rpId,
    approvalOrigin: options.approvalOrigin,
    returnOrigin: options.returnOrigin,
    chains: options.chains,
    assets: options.assets,
    maxIntentTtlSeconds: options.maxIntentTtlSeconds,
    maxAdminTtlSeconds: options.maxAdminTtlSeconds,
    maxMandateSeconds,
    maxTxAttempts,
    now,
    log,
  });

  async function dispatch(
    name: RouteName,
    params: Record<string, string>,
    query: URLSearchParams,
    body: Uint8Array,
    confirmToken: string,
  ) {
    const workspaceId = () => parse(WorkspaceIdSchema, params.workspaceId);
    const approvalId = () => parse(ApprovalId, params.approvalId);
    const mandateId = () => parse(MandateId, params.mandateId);

    switch (name) {
      case "health":
        return { ok: true, version: VERSION };
      case "createWorkspace":
        return core.createWorkspace(parse(CreateWorkspaceRequest, parseBody(body)));
      case "getWorkspace":
        return core.getWorkspace(workspaceId());
      case "pauseWorkspace":
        return core.pauseWorkspace(workspaceId());
      case "resumeWorkspace":
        return core.resumeWorkspace(
          workspaceId(),
          parse(AuthorizedRequest, parseBody(body)).authorization,
        );
      case "addApprover":
        return core.addApprover(workspaceId(), parse(AddApproverRequest, parseBody(body)));
      case "removeApprover":
        return core.removeApprover(
          workspaceId(),
          parse(AuthorizedRequest, parseBody(body)).authorization,
        );
      case "setAdminThreshold":
        return core.setAdminThreshold(
          workspaceId(),
          parse(AuthorizedRequest, parseBody(body)).authorization,
        );
      case "listDecisions":
        return {
          decisions: core.listDecisions(
            workspaceId(),
            pageNumber(query.get("after"), 0, Number.MAX_SAFE_INTEGER),
            pageNumber(query.get("limit"), 100, 1000),
          ),
        };
      case "createWallet":
        return core.createWallet(parse(CreateWalletRequest, parseBody(body)));
      case "getWallet":
        return core.getWallet(parse(WalletId, params.walletId));
      case "setPolicy":
        return core.setPolicy(
          parse(WalletId, params.walletId),
          parse(SetPolicyRequest, parseBody(body)),
        );
      case "sign":
        return core.sign(parse(SignRequest, parseBody(body)));
      case "sweep":
        return core.sweep(parse(WalletId, params.walletId), parse(SweepRequest, parseBody(body)));
      case "revokeApproval":
        return core.revokeApproval(
          approvalId(),
          parse(RevokeApprovalRequest, parseBody(body)).workspaceId,
        );
      case "getApproval":
        return core.getApproval(approvalId());
      case "reprice":
        return core.reprice(approvalId(), parse(RepriceRequest, parseBody(body)));
      case "cancelTransaction":
        return core.cancelTransaction(
          approvalId(),
          parse(CancelTransactionRequest, parseBody(body)),
        );
      case "grantMandate":
        return core.grantMandate(mandateId(), parse(GrantMandateRequest, parseBody(body)));
      case "getMandate":
        return core.getMandate(mandateId());
      case "listMandates":
        return core.listMandates(parse(WalletId, params.walletId));
      case "revokeMandate":
        return core.revokeMandate(
          mandateId(),
          parse(RevokeMandateRequest, parseBody(body)).workspaceId,
        );
      case "signUnderMandate":
        return core.signUnderMandate(mandateId(), parse(SignUnderMandateRequest, parseBody(body)));
      case "signVenue":
        return core.signVenue(parse(SignVenueRequest, parseBody(body)));
      case "cancelVenueOrder":
        return core.cancelVenueOrder(
          approvalId(),
          parse(CancelVenueOrderRequest, parseBody(body)).workspaceId,
        );
      case "retireWallet":
        return core.retireWallet(
          parse(WalletId, params.walletId),
          parse(AuthorizedRequest, parseBody(body)).authorization,
        );
      case "cancelRetireWallet":
        return core.cancelRetireWallet(
          parse(WalletId, params.walletId),
          parse(RetireWalletStepRequest, parseBody(body)).workspaceId,
        );
      case "finalizeRetireWallet":
        return core.finalizeRetireWallet(
          parse(WalletId, params.walletId),
          parse(RetireWalletStepRequest, parseBody(body)).workspaceId,
        );
      case "deleteWorkspace":
        return core.deleteWorkspace(
          workspaceId(),
          parse(AuthorizedRequest, parseBody(body)).authorization,
        );
      case "cancelDeleteWorkspace":
        return core.cancelDeleteWorkspace(workspaceId());
      case "finalizeDeleteWorkspace":
        return core.finalizeDeleteWorkspace(workspaceId());
      case "openConfirmation":
        return confirmations.openConfirmation(
          approvalId(),
          parse(OpenConfirmationRequest, parseBody(body)),
        );
      case "listConfirmationAssertions":
        return confirmations.listConfirmationAssertions(approvalId());
      case "getConfirmation":
        return confirmations.getConfirmation(approvalId(), confirmToken);
      case "submitConfirmation":
        return confirmations.submitConfirmation(
          approvalId(),
          confirmToken,
          parse(SubmitConfirmationRequest, parseBody(body)).response,
        );
      case "getPossession":
        return confirmations.getPossession(approvalId(), confirmToken);
      case "submitPossession":
        return confirmations.submitPossession(
          approvalId(),
          confirmToken,
          parse(SubmitPossessionRequest, parseBody(body)).response,
        );
    }
  }

  const app = new Hono();
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    let route: MatchedRoute | null = null;

    try {
      route = matchRoute(c.req.method, url.pathname);

      if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
        throw new SignerFailure("invalid_request");
      }

      const body = await readBody(c.req.raw.body);
      // Each route is reachable only with its own scope's secret: the `approve` service's
      // cannot sign or apply anything, and the control plane's cannot submit an assertion.
      const { scope } = signerRoutes[route.name];

      if (scope !== "unsigned") {
        // With mutual TLS the client certificate is checked first: the right secret on the
        // wrong client's connection is refused like a wrong secret.
        if (
          scopeOfClient !== null &&
          scopeOfClient.get(
            verifiedClientFingerprint(NodeBindings.safeParse(c.env).data?.incoming) ?? "",
          ) !== scope
        ) {
          throw new SignerFailure("unauthenticated");
        }

        const signature = c.req.header(SIGNATURE_HEADER) ?? "";
        const timestampText = c.req.header(TIMESTAMP_HEADER) ?? "";

        const authentic =
          /^[0-9]{1,12}$/.test(timestampText) &&
          verifyRequestSignature(secrets[scope], {
            method: c.req.method,
            pathWithQuery: `${url.pathname}${url.search}`,
            timestamp: Number(timestampText),
            body,
            signature,
            now: now(),
          });

        if (!authentic) throw new SignerFailure("unauthenticated");
      }

      // Every route answers with an object; Hono serializes it with JSON.stringify.
      const result: object = await dispatch(
        route.name,
        route.params,
        url.searchParams,
        body,
        c.req.header(CONFIRM_TOKEN_HEADER) ?? "",
      );

      log.info("request", { route: route.name, status: 200 });

      return c.json(result, 200);
    } catch (error) {
      const failure = error instanceof SignerFailure ? error : new SignerFailure("internal");

      if (!(error instanceof SignerFailure)) {
        log.error("unexpected failure", {
          route: route?.name ?? null,
          kind: error instanceof Error ? error.name : "unknown",
        });
      }

      log.info("request", {
        route: route?.name ?? null,
        status: failure.status,
        code: failure.code,
      });

      return c.json(failure.body(), failure.status);
    }
  });

  return {
    app,
    enrollApproverByOperator: core.enrollApproverByOperator,
    verifyDecisionLog: core.verifyDecisionLog,
    fence: () => {
      const fenceAt = transaction(db, () => raiseFence(db, now(), FENCE_BY_OPERATOR));
      log.warn("restore fence set", { reason: "operator", fenceAt });

      return fenceAt;
    },
    listWorkspaceMandates: core.listWorkspaceMandates,
    revokeMandateByOperator: core.revokeMandateByOperator,
    revokeWorkspaceMandatesByOperator: core.revokeWorkspaceMandatesByOperator,
    exportWalletByOperator: core.exportWalletByOperator,
    close: () => db.close(),
  };
}

/** How far a request's timestamp may drift from the signer's clock, re-exported for operators. */
export const REQUEST_CLOCK_SKEW_SECONDS = MAX_CLOCK_SKEW_SECONDS;
