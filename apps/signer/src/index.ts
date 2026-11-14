import { readFileSync } from "node:fs";
import {
  ApprovalId,
  type ApproverCredential,
  WalletId,
  type WorkspaceId,
  WorkspaceId as WorkspaceIdSchema,
} from "@askgina/os-protocol";
import {
  AddApproverRequest,
  AuthorizedRequest,
  CreateWalletRequest,
  CreateWorkspaceRequest,
  MAX_CLOCK_SKEW_SECONDS,
  RevokeApprovalRequest,
  SetPolicyRequest,
  SIGNATURE_HEADER,
  SignRequest,
  SweepRequest,
  signerRoutes,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
} from "@askgina/os-protocol/signer";
import type { RelyingParty } from "@askgina/os-protocol/webauthn";
import { Hono } from "hono";
import type { z } from "zod";
import { openDatabase, transaction } from "./db.ts";
import { SignerFailure } from "./errors.ts";
import { FENCE_BY_OPERATOR, fenceReplacedDatabase, raiseFence } from "./fence.ts";
import { type Logger, silentLogger } from "./log.ts";
import { createSignerCore } from "./signer.ts";
import type { Vault } from "./vault.ts";

export { SCHEMA_VERSION, SchemaTooNewError } from "./db.ts";
export type { Logger } from "./log.ts";
export { createLogger } from "./log.ts";
export {
  createTestVault,
  type EvmTransaction,
  OwsVault,
  type Vault,
  VaultError,
} from "./vault.ts";

const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export interface SignerOptions {
  /** SQLite file, or ":memory:" for tests. */
  sqlitePath: string;
  vault: Vault;
  relyingParty: RelyingParty;
  /** Shared with the control plane; authenticates every request except the health check. */
  requestSecret: Uint8Array;
  /** 32 bytes. Seals the vault credentials stored in SQLite. */
  tokenKey: Uint8Array;
  maxIntentTtlSeconds: number;
  maxAdminTtlSeconds: number;
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
   * Set the restore fence to now: every envelope issued before it is refused from here on. Not
   * reachable over HTTP: only the admin CLI on the signer host calls it, as part of a restore.
   * Returns the fence in force, in seconds since the Unix epoch.
   */
  fence(): number;
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

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SignerFailure("invalid_request");
  return result.data;
}

function parseBody(body: Uint8Array): unknown {
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
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? silentLogger;
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
    relyingParty: options.relyingParty,
    tokenKey: options.tokenKey,
    maxIntentTtlSeconds: options.maxIntentTtlSeconds,
    maxAdminTtlSeconds: options.maxAdminTtlSeconds,
    now,
    log,
  });

  async function dispatch(
    name: RouteName,
    params: Record<string, string>,
    query: URLSearchParams,
    body: Uint8Array,
  ): Promise<unknown> {
    const workspaceId = () => parse(WorkspaceIdSchema, params.workspaceId);
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
          parse(ApprovalId, params.approvalId),
          parse(RevokeApprovalRequest, parseBody(body)).workspaceId,
        );
      case "getApproval":
        return core.getApproval(parse(ApprovalId, params.approvalId));
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
      if (route.name !== "health") {
        const signature = c.req.header(SIGNATURE_HEADER) ?? "";
        const timestampText = c.req.header(TIMESTAMP_HEADER) ?? "";
        const authentic =
          /^[0-9]{1,12}$/.test(timestampText) &&
          verifyRequestSignature(options.requestSecret, {
            method: c.req.method,
            pathWithQuery: `${url.pathname}${url.search}`,
            timestamp: Number(timestampText),
            body,
            signature,
            now: now(),
          });
        if (!authentic) throw new SignerFailure("unauthenticated");
      }
      const result = await dispatch(route.name, route.params, url.searchParams, body);
      log.info("request", { route: route.name, status: 200 });
      return c.json(result as object, 200);
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
      return c.json(failure.body(), failure.status as 400);
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
    close: () => db.close(),
  };
}

/** How far a request's timestamp may drift from the signer's clock, re-exported for operators. */
export const REQUEST_CLOCK_SKEW_SECONDS = MAX_CLOCK_SKEW_SECONDS;
