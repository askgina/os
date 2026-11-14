import type { z } from "zod";
import type { Authorization } from "../envelopes.ts";
import type { ApprovalId, WalletId, WorkspaceId } from "../primitives.ts";
import {
  type AddApproverRequest,
  ApprovalState,
  type CreateWalletRequest,
  type CreateWorkspaceRequest,
  HealthResponse,
  ListDecisionsResponse,
  type SetPolicyRequest,
  SignerErrorBody,
  type SignerErrorCode,
  type SignRequest,
  SignResponse,
  signerRoutes,
  WalletState,
  WorkspaceState,
} from "./api.ts";
import { SIGNATURE_HEADER, signRequest, TIMESTAMP_HEADER } from "./request-signature.ts";

/** The signer understood the request and answered with an error. */
export class SignerError extends Error {
  override readonly name = "SignerError";
  readonly code: SignerErrorCode;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(code: SignerErrorCode, message: string, status: number, detail?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface SignerClientOptions {
  /** For example `http://signer:8787`. */
  baseUrl: string;
  /** The shared request-signing secret, at least 32 bytes. */
  secret: Uint8Array;
  fetch?: typeof globalThis.fetch;
  /** Seconds since the Unix epoch. Tests inject a clock. */
  now?: () => number;
}

/**
 * Everything the control plane can ask of the signer. Methods reject with {@link SignerError}
 * when the signer refuses, and with the transport's own error when it cannot be reached.
 */
export interface SignerClient {
  health(): Promise<HealthResponse>;

  createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceState>;
  getWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceState>;
  pauseWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceState>;
  resumeWorkspace(workspaceId: WorkspaceId, authorization: Authorization): Promise<WorkspaceState>;
  addApprover(workspaceId: WorkspaceId, request: AddApproverRequest): Promise<WorkspaceState>;
  removeApprover(workspaceId: WorkspaceId, authorization: Authorization): Promise<WorkspaceState>;
  setAdminThreshold(
    workspaceId: WorkspaceId,
    authorization: Authorization,
  ): Promise<WorkspaceState>;
  listDecisions(
    workspaceId: WorkspaceId,
    page?: { after?: number; limit?: number },
  ): Promise<ListDecisionsResponse>;

  createWallet(request: CreateWalletRequest): Promise<WalletState>;
  getWallet(walletId: WalletId): Promise<WalletState>;
  setPolicy(walletId: WalletId, request: SetPolicyRequest): Promise<WalletState>;

  sign(request: SignRequest): Promise<SignResponse>;
  revokeApproval(approvalId: ApprovalId): Promise<ApprovalState>;
  getApproval(approvalId: ApprovalId): Promise<ApprovalState>;
}

type Route = (typeof signerRoutes)[keyof typeof signerRoutes];

export function createSignerClient(options: SignerClientOptions): SignerClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function call<S extends z.ZodType>(
    route: Route,
    schema: S,
    input: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown },
  ): Promise<z.infer<S>> {
    let path: string = route.path;
    for (const [name, value] of Object.entries(input.params ?? {})) {
      path = path.replace(`:${name}`, encodeURIComponent(value));
    }
    const query = new URLSearchParams(input.query ?? {}).toString();
    const pathWithQuery = query === "" ? path : `${path}?${query}`;
    const body = new TextEncoder().encode(
      input.body === undefined ? "" : JSON.stringify(input.body),
    );
    const timestamp = now();
    const response = await doFetch(`${baseUrl}${pathWithQuery}`, {
      method: route.method,
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signRequest(options.secret, {
          method: route.method,
          pathWithQuery,
          timestamp,
          body,
        }),
      },
      ...(route.method === "GET" ? {} : { body }),
    });
    // A proxy in front of the signer may answer with a non-JSON error page; that is still a
    // refusal the caller must see as a SignerError, not a parse failure.
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = SignerErrorBody.safeParse(payload);
      if (parsed.success) {
        const { code, message, detail } = parsed.data.error;
        throw new SignerError(code, message, response.status, detail);
      }
      throw new SignerError("internal", `signer answered HTTP ${response.status}`, response.status);
    }
    return schema.parse(payload);
  }

  const workspace = (workspaceId: WorkspaceId) => ({ params: { workspaceId } });

  return {
    health: () => call(signerRoutes.health, HealthResponse, {}),

    createWorkspace: (request: CreateWorkspaceRequest) =>
      call(signerRoutes.createWorkspace, WorkspaceState, { body: request }),
    getWorkspace: (workspaceId: WorkspaceId) =>
      call(signerRoutes.getWorkspace, WorkspaceState, workspace(workspaceId)),
    pauseWorkspace: (workspaceId: WorkspaceId) =>
      call(signerRoutes.pauseWorkspace, WorkspaceState, { ...workspace(workspaceId), body: {} }),
    resumeWorkspace: (workspaceId: WorkspaceId, authorization: Authorization) =>
      call(signerRoutes.resumeWorkspace, WorkspaceState, {
        ...workspace(workspaceId),
        body: { authorization },
      }),
    addApprover: (workspaceId: WorkspaceId, request: AddApproverRequest) =>
      call(signerRoutes.addApprover, WorkspaceState, { ...workspace(workspaceId), body: request }),
    removeApprover: (workspaceId: WorkspaceId, authorization: Authorization) =>
      call(signerRoutes.removeApprover, WorkspaceState, {
        ...workspace(workspaceId),
        body: { authorization },
      }),
    setAdminThreshold: (workspaceId: WorkspaceId, authorization: Authorization) =>
      call(signerRoutes.setAdminThreshold, WorkspaceState, {
        ...workspace(workspaceId),
        body: { authorization },
      }),
    listDecisions: (workspaceId, page = {}) =>
      call(signerRoutes.listDecisions, ListDecisionsResponse, {
        ...workspace(workspaceId),
        query: {
          ...(page.after === undefined ? {} : { after: String(page.after) }),
          ...(page.limit === undefined ? {} : { limit: String(page.limit) }),
        },
      }),

    createWallet: (request: CreateWalletRequest) =>
      call(signerRoutes.createWallet, WalletState, { body: request }),
    getWallet: (walletId: WalletId) =>
      call(signerRoutes.getWallet, WalletState, { params: { walletId } }),
    setPolicy: (walletId: WalletId, request: SetPolicyRequest) =>
      call(signerRoutes.setPolicy, WalletState, { params: { walletId }, body: request }),

    sign: (request: SignRequest) => call(signerRoutes.sign, SignResponse, { body: request }),
    revokeApproval: (approvalId: ApprovalId) =>
      call(signerRoutes.revokeApproval, ApprovalState, { params: { approvalId }, body: {} }),
    getApproval: (approvalId: ApprovalId) =>
      call(signerRoutes.getApproval, ApprovalState, { params: { approvalId } }),
  };
}
