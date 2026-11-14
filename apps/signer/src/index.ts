import { readFileSync } from "node:fs";
import {
  ApprovalId,
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
  SetPolicyRequest,
  SIGNATURE_HEADER,
  SignRequest,
  signerRoutes,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
} from "@askgina/os-protocol/signer";
import type { RelyingParty } from "@askgina/os-protocol/webauthn";
import { Hono } from "hono";
import type { z } from "zod";
import { openDatabase } from "./db.ts";
import { SignerFailure } from "./errors.ts";
import { type Logger, silentLogger } from "./log.ts";
import { createSignerCore } from "./signer.ts";
import type { Vault } from "./vault.ts";

export type { Logger } from "./log.ts";
export { createLogger } from "./log.ts";
export { RECOVERY_CODE_TTL_SECONDS } from "./signer.ts";
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
  /** A one-time code that enrolls one approver for the workspace within 15 minutes. */
  issueRecoveryCode(workspaceId: WorkspaceId): string;
  verifyDecisionLog(workspaceId: WorkspaceId): { ok: boolean; brokenAt: number | null };
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

function matchRoute(method: string, path: string) {
  for (const route of compiledRoutes) {
    if (route.method !== method) continue;
    const match = route.regex.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? "");
    });
    return { name: route.name, params };
  }
  return null;
}

/** Far above any valid request (a policy with every list full is about 60 KiB). */
const MAX_BODY_BYTES = 256 * 1024;

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
  const db = openDatabase(options.sqlitePath);
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
      case "revokeApproval":
        return core.revokeApproval(parse(ApprovalId, params.approvalId));
      case "getApproval":
        return core.getApproval(parse(ApprovalId, params.approvalId));
    }
  }

  const app = new Hono();
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const route = matchRoute(c.req.method, url.pathname);
    try {
      if (!route) throw new SignerFailure("not_found");
      if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
        throw new SignerFailure("invalid_request");
      }
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.byteLength > MAX_BODY_BYTES) throw new SignerFailure("invalid_request");
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
    issueRecoveryCode: core.issueRecoveryCode,
    verifyDecisionLog: core.verifyDecisionLog,
    close: () => db.close(),
  };
}

/** How far a request's timestamp may drift from the signer's clock, re-exported for operators. */
export const REQUEST_CLOCK_SKEW_SECONDS = MAX_CLOCK_SKEW_SECONDS;
