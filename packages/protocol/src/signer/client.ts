import type { z } from "zod";
import { ConfirmationView } from "../confirmation.ts";
import type { AssertionResponse, Authorization } from "../envelopes.ts";
import type { ApprovalId, MandateId, WalletId, WorkspaceId } from "../primitives.ts";
import {
  type AddApproverRequest,
  ApprovalState,
  AttemptResponse,
  type CancelTransactionRequest,
  CONFIRM_TOKEN_HEADER,
  type CreateWalletRequest,
  type CreateWorkspaceRequest,
  GetPossessionResponse,
  type GrantMandateRequest,
  HealthResponse,
  ListConfirmationAssertionsResponse,
  ListDecisionsResponse,
  ListMandatesResponse,
  MandateState,
  type OpenConfirmationRequest,
  OpenConfirmationResponse,
  type RepriceRequest,
  type SetPolicyRequest,
  SignerErrorBody,
  type SignerErrorCode,
  type SignRequest,
  SignResponse,
  type SignUnderMandateRequest,
  SubmitConfirmationResponse,
  SubmitPossessionResponse,
  type SweepRequest,
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
  /**
   * The request-signing secret of the client's scope, at least 32 bytes: the control plane's for
   * {@link createSignerClient}, the `approve` service's for {@link createConfirmClient}.
   */
  secret: Uint8Array;
  fetch?: typeof globalThis.fetch;
  /** Seconds since the Unix epoch. Tests inject a clock. */
  now?: () => number;
  /**
   * How long one request may take, in milliseconds (default 15 000). A signer that accepts the
   * connection and never answers would otherwise hold the caller, and whatever it serves, forever.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

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

  /** Retire a wallet, approved by a `retire-wallet` envelope: it signs nothing from now on. */
  retireWallet(walletId: WalletId, authorization: Authorization): Promise<WalletState>;
  /** Keep a retiring wallet's key: it becomes `held`. No passkey. */
  cancelRetireWallet(walletId: WalletId, workspaceId: WorkspaceId): Promise<WalletState>;
  /** Destroy a retiring wallet's key once its `destroyAfter` has passed. No passkey; idempotent. */
  finalizeRetireWallet(walletId: WalletId, workspaceId: WorkspaceId): Promise<WalletState>;
  /** Delete a workspace, approved by a `delete-workspace` envelope: it pauses and stops signing. */
  deleteWorkspace(workspaceId: WorkspaceId, authorization: Authorization): Promise<WorkspaceState>;
  /** Keep a deleting workspace's keys: it becomes `active` and stays paused. No passkey. */
  cancelDeleteWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceState>;
  /** Destroy every key of a deleting workspace once its `destroyAfter` has passed. Idempotent. */
  finalizeDeleteWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceState>;

  sign(request: SignRequest): Promise<SignResponse>;
  sweep(walletId: WalletId, request: SweepRequest): Promise<SignResponse>;
  revokeApproval(approvalId: ApprovalId, workspaceId: WorkspaceId): Promise<ApprovalState>;
  getApproval(approvalId: ApprovalId): Promise<ApprovalState>;
  /** One more attempt at a signed approval's transaction, both fees higher, with no passkey. */
  reprice(approvalId: ApprovalId, request: RepriceRequest): Promise<AttemptResponse>;
  /** A cancel of a signed approval's transaction, approved by a `cancel-transaction` envelope. */
  cancelTransaction(
    approvalId: ApprovalId,
    request: CancelTransactionRequest,
  ): Promise<AttemptResponse>;

  grantMandate(mandateId: MandateId, request: GrantMandateRequest): Promise<MandateState>;
  getMandate(mandateId: MandateId): Promise<MandateState>;
  listMandates(walletId: WalletId): Promise<ListMandatesResponse>;
  revokeMandate(mandateId: MandateId, workspaceId: WorkspaceId): Promise<MandateState>;
  signUnderMandate(mandateId: MandateId, request: SignUnderMandateRequest): Promise<SignResponse>;

  /** Open, or reopen with a fresh token, the confirmation page for a pending approval. */
  openConfirmation(
    approvalId: ApprovalId,
    request: OpenConfirmationRequest,
  ): Promise<OpenConfirmationResponse>;
  /** The assertions people made on the confirmation page, as the signer recorded them. */
  listConfirmationAssertions(approvalId: ApprovalId): Promise<ListConfirmationAssertionsResponse>;
}

/**
 * Everything the `approve` service can ask of the signer: the view of one approval, the
 * submission of one assertion, and the possession step of an approver change, each with the
 * token from the confirmation link. Its secret reaches no other route.
 */
export interface ConfirmClient {
  getConfirmation(approvalId: ApprovalId, token: string): Promise<ConfirmationView>;
  submitConfirmation(
    approvalId: ApprovalId,
    token: string,
    response: AssertionResponse,
  ): Promise<SubmitConfirmationResponse>;
  /** The passkey request of an approver change's possession step, with its current challenge. */
  getPossession(approvalId: ApprovalId, token: string): Promise<GetPossessionResponse>;
  /** The new person's answer to the possession step; the proven key's fingerprint. */
  submitPossession(
    approvalId: ApprovalId,
    token: string,
    response: AssertionResponse,
  ): Promise<SubmitPossessionResponse>;
}

type Route = (typeof signerRoutes)[keyof typeof signerRoutes];

type CallInput = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
};

/** One signed request to the signer, answered with a schema-checked body or a SignerError. */
function createCaller(options: SignerClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function call<S extends z.ZodType>(
    route: Route,
    schema: S,
    input: CallInput,
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
        ...input.headers,
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
      signal: AbortSignal.timeout(timeoutMs),
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
  };
}

export function createSignerClient(options: SignerClientOptions): SignerClient {
  const call = createCaller(options);
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

    retireWallet: (walletId: WalletId, authorization: Authorization) =>
      call(signerRoutes.retireWallet, WalletState, {
        params: { walletId },
        body: { authorization },
      }),
    cancelRetireWallet: (walletId: WalletId, workspaceId: WorkspaceId) =>
      call(signerRoutes.cancelRetireWallet, WalletState, {
        params: { walletId },
        body: { workspaceId },
      }),
    finalizeRetireWallet: (walletId: WalletId, workspaceId: WorkspaceId) =>
      call(signerRoutes.finalizeRetireWallet, WalletState, {
        params: { walletId },
        body: { workspaceId },
      }),
    deleteWorkspace: (workspaceId: WorkspaceId, authorization: Authorization) =>
      call(signerRoutes.deleteWorkspace, WorkspaceState, {
        ...workspace(workspaceId),
        body: { authorization },
      }),
    cancelDeleteWorkspace: (workspaceId: WorkspaceId) =>
      call(signerRoutes.cancelDeleteWorkspace, WorkspaceState, {
        ...workspace(workspaceId),
        body: {},
      }),
    finalizeDeleteWorkspace: (workspaceId: WorkspaceId) =>
      call(signerRoutes.finalizeDeleteWorkspace, WorkspaceState, {
        ...workspace(workspaceId),
        body: {},
      }),

    sign: (request: SignRequest) => call(signerRoutes.sign, SignResponse, { body: request }),
    sweep: (walletId: WalletId, request: SweepRequest) =>
      call(signerRoutes.sweep, SignResponse, { params: { walletId }, body: request }),
    revokeApproval: (approvalId: ApprovalId, workspaceId: WorkspaceId) =>
      call(signerRoutes.revokeApproval, ApprovalState, {
        params: { approvalId },
        body: { workspaceId },
      }),
    getApproval: (approvalId: ApprovalId) =>
      call(signerRoutes.getApproval, ApprovalState, { params: { approvalId } }),
    reprice: (approvalId: ApprovalId, request: RepriceRequest) =>
      call(signerRoutes.reprice, AttemptResponse, { params: { approvalId }, body: request }),
    cancelTransaction: (approvalId: ApprovalId, request: CancelTransactionRequest) =>
      call(signerRoutes.cancelTransaction, AttemptResponse, {
        params: { approvalId },
        body: request,
      }),

    grantMandate: (mandateId: MandateId, request: GrantMandateRequest) =>
      call(signerRoutes.grantMandate, MandateState, { params: { mandateId }, body: request }),
    getMandate: (mandateId: MandateId) =>
      call(signerRoutes.getMandate, MandateState, { params: { mandateId } }),
    listMandates: (walletId: WalletId) =>
      call(signerRoutes.listMandates, ListMandatesResponse, { params: { walletId } }),
    revokeMandate: (mandateId: MandateId, workspaceId: WorkspaceId) =>
      call(signerRoutes.revokeMandate, MandateState, {
        params: { mandateId },
        body: { workspaceId },
      }),
    signUnderMandate: (mandateId: MandateId, request: SignUnderMandateRequest) =>
      call(signerRoutes.signUnderMandate, SignResponse, { params: { mandateId }, body: request }),

    openConfirmation: (approvalId: ApprovalId, request: OpenConfirmationRequest) =>
      call(signerRoutes.openConfirmation, OpenConfirmationResponse, {
        params: { approvalId },
        body: request,
      }),
    listConfirmationAssertions: (approvalId: ApprovalId) =>
      call(signerRoutes.listConfirmationAssertions, ListConfirmationAssertionsResponse, {
        params: { approvalId },
      }),
  };
}

export function createConfirmClient(options: SignerClientOptions): ConfirmClient {
  const call = createCaller(options);
  const confirm = (approvalId: ApprovalId, token: string) => ({
    params: { approvalId },
    headers: { [CONFIRM_TOKEN_HEADER]: token },
  });

  return {
    getConfirmation: (approvalId: ApprovalId, token: string) =>
      call(signerRoutes.getConfirmation, ConfirmationView, confirm(approvalId, token)),
    submitConfirmation: (approvalId: ApprovalId, token: string, response: AssertionResponse) =>
      call(signerRoutes.submitConfirmation, SubmitConfirmationResponse, {
        ...confirm(approvalId, token),
        body: { response },
      }),
    getPossession: (approvalId: ApprovalId, token: string) =>
      call(signerRoutes.getPossession, GetPossessionResponse, confirm(approvalId, token)),
    submitPossession: (approvalId: ApprovalId, token: string, response: AssertionResponse) =>
      call(signerRoutes.submitPossession, SubmitPossessionResponse, {
        ...confirm(approvalId, token),
        body: { response },
      }),
  };
}
