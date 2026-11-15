import { ApiError, createApiClient, type RouteName, type RouteOutput } from "@askgina/os-api";
import type { AgentId, WalletId } from "@askgina/os-protocol";
import {
  keepPreviousData,
  QueryCache,
  QueryClient,
  type QueryKey,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { signInHref } from "@/lib/return-path.ts";
import { transactionOpen } from "@/lib/transaction.ts";

/** Every request goes to the page's own origin; the session cookie rides along. */
export const api = createApiClient();

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // A session can end while a page is open (it expired, or was signed out elsewhere). Start
    // over from the sign-in page instead of showing every list as an error.
    onError: (error) => {
      if (error instanceof ApiError && error.code === "unauthenticated") {
        queryClient.clear();
        const { pathname, search, hash } = window.location;
        window.location.assign(signInHref(`${pathname}${search}${hash}`));
      }
    },
  }),
  defaultOptions: {
    queries: {
      // A refusal (not found, forbidden, signed out) will not change by asking again.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
});

/** The API's own message for a refusal; a fixed sentence for anything that never reached it. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "The passkey prompt was closed or timed out. Nothing was sent.";
  }
  if (error instanceof Error && error.name.endsWith("Error") && error.message !== "") {
    return error.message;
  }
  return "The server could not be reached. Check your connection and try again.";
}

export const keys = {
  session: ["session"] as const,
  workspaces: ["workspaces"] as const,
  workspace: (id: string) => ["workspace", id] as const,
  approvals: (workspaceId: string, status: "pending" | "all") =>
    ["approvals", workspaceId, status] as const,
  approval: (id: string) => ["approval", id] as const,
  wallet: (workspaceId: string, walletId: string) => ["wallet", workspaceId, walletId] as const,
  intents: (workspaceId: string) => ["intents", workspaceId] as const,
  intent: (id: string) => ["intent", id] as const,
  /** Every list and page of a workspace's mandates, to refresh them together after a change. */
  mandates: (workspaceId: string) => ["mandates", workspaceId] as const,
  mandateList: (workspaceId: string, filter: MandateFilter, status: "active" | "ended") =>
    [
      "mandates",
      workspaceId,
      "list",
      filter.walletId ?? null,
      filter.agentId ?? null,
      status,
    ] as const,
  mandate: (workspaceId: string, mandateId: string) =>
    ["mandates", workspaceId, "one", mandateId] as const,
  mandatePayments: (workspaceId: string, mandateId: string) =>
    ["mandates", workspaceId, "payments", mandateId] as const,
  audit: (workspaceId: string) => ["audit", workspaceId] as const,
  decisions: (workspaceId: string) => ["decisions", workspaceId] as const,
  passkeys: ["passkeys"] as const,
  pushConfig: ["push", "config"] as const,
  pushDevices: ["push", "devices"] as const,
  /** This browser's own push subscription, read from the browser, not the API. */
  thisBrowser: ["push", "this-browser"] as const,
  notificationPreferences: ["notification-preferences"] as const,
  invite: (token: string) => ["invite", token] as const,
  invites: (workspaceId: string) => ["invites", workspaceId] as const,
};

function useApi<N extends RouteName>(
  key: QueryKey,
  load: () => Promise<RouteOutput<N>>,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useQuery({ queryKey: key, queryFn: load, ...options });
}

export const useSession = () => useApi<"getSession">(keys.session, () => api.call("getSession"));

export const useWorkspaces = () =>
  useApi<"listWorkspaces">(keys.workspaces, () => api.call("listWorkspaces"));

export const useWorkspace = (workspaceId: string) =>
  useApi<"getWorkspace">(keys.workspace(workspaceId), () =>
    api.call("getWorkspace", { params: { workspaceId } }),
  );

/**
 * Approval lists stay live: every 3 seconds while the tab is visible. TanStack Query pauses
 * interval refetches in a hidden tab by default.
 */
export const useApprovals = (workspaceId: string, status: "pending" | "all") =>
  useQuery({
    queryKey: keys.approvals(workspaceId, status),
    queryFn: () => api.call("listApprovals", { params: { workspaceId }, query: { status } }),
    refetchInterval: 3_000,
    placeholderData: keepPreviousData,
  });

const ACTIVE_APPROVAL = new Set(["pending", "approved"]);

/**
 * An approval page follows its request to the end: it polls until the status is final, and then
 * while the transaction it signed (or, for a cancel, the one it stops) may still change on chain.
 * A stuck one can be mined, sped up or cancelled at any time.
 */
export const useApproval = (approvalId: string) =>
  useQuery({
    queryKey: keys.approval(approvalId),
    queryFn: () => api.call("getApproval", { params: { approvalId } }),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      if (ACTIVE_APPROVAL.has(data.status)) return 3_000;
      const subject = data.subject;
      if (subject.kind === "approve-intent") {
        const status = subject.intent.status;
        if (status === "approved" || status === "signed" || status === "broadcast") return 3_000;
        if (status === "stuck") return 5_000;
      }
      if (subject.kind === "sweep-wallet" || subject.kind === "cancel-transaction") {
        const status = subject.transaction?.status;
        if (status && transactionOpen(status)) return status === "stuck" ? 5_000 : 3_000;
      }
      return false;
    },
  });

/** The wallet or the agent a list of mandates is for; neither for the whole workspace. */
export interface MandateFilter {
  walletId?: WalletId;
  agentId?: AgentId;
}

/**
 * A workspace's mandates, newest first: `active` while one can still sign, `ended` once it never
 * will. Live lists refresh every 5 seconds, because an agent may pay under one at any time.
 */
export const useMandates = (
  workspaceId: string,
  filter: MandateFilter,
  status: "active" | "ended",
) =>
  useInfiniteQuery({
    queryKey: keys.mandateList(workspaceId, filter, status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.call("listMandates", {
        params: { workspaceId },
        query: { ...filter, status, cursor: pageParam },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: status === "active" ? 5_000 : false,
  });

/** A payment on its way to the chain, or stuck there: it can still be mined, sped up or cancelled. */
const IN_FLIGHT = new Set(["proposed", "approved", "signed", "broadcast", "stuck"]);

/** One payment, followed while it is in flight. */
export const useIntent = (intentId: string) =>
  useQuery({
    queryKey: keys.intent(intentId),
    queryFn: () => api.call("getIntent", { params: { intentId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined || !IN_FLIGHT.has(status)) return false;
      return status === "stuck" ? 5_000 : 3_000;
    },
  });

/** One mandate with its first payments, followed while it can still sign or a payment is on its way. */
export const useMandate = (workspaceId: string, mandateId: string) =>
  useQuery({
    queryKey: keys.mandate(workspaceId, mandateId),
    queryFn: () => api.call("getMandate", { params: { workspaceId, mandateId } }),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const moving = data.intents.some((intent) => IN_FLIGHT.has(intent.status));
      return data.endedReason === null || moving ? 5_000 : false;
    },
  });

export const useWallet = (workspaceId: string, walletId: string) =>
  useApi<"getWallet">(keys.wallet(workspaceId, walletId), () =>
    api.call("getWallet", { params: { workspaceId, walletId } }),
  );

export const useIntents = (workspaceId: string) =>
  useQuery({
    queryKey: keys.intents(workspaceId),
    queryFn: () => api.call("listIntents", { params: { workspaceId } }),
    refetchInterval: 5_000,
  });

export const useAudit = (workspaceId: string) =>
  useInfiniteQuery({
    queryKey: keys.audit(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.call("listAudit", { params: { workspaceId }, query: { cursor: pageParam } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useSignerDecisions = (workspaceId: string) =>
  useApi<"listSignerDecisions">(keys.decisions(workspaceId), () =>
    api.call("listSignerDecisions", { params: { workspaceId } }),
  );

export const usePasskeys = () =>
  useApi<"listPasskeys">(keys.passkeys, () => api.call("listPasskeys"));

/** Whether the server sends Web Push, and the key a browser subscribes with. */
export const usePushConfig = () =>
  useApi<"getPushConfig">(keys.pushConfig, () => api.call("getPushConfig"));

/** The signed-in person's devices that get notifications. */
export const usePushDevices = () =>
  useApi<"listPushSubscriptions">(keys.pushDevices, () => api.call("listPushSubscriptions"));

export const useNotificationPreferences = () =>
  useApi<"getNotificationPreferences">(keys.notificationPreferences, () =>
    api.call("getNotificationPreferences"),
  );

export const useInvites = (workspaceId: string) =>
  useApi<"listInvites">(keys.invites(workspaceId), () =>
    api.call("listInvites", { params: { workspaceId } }),
  );

export const useInvite = (token: string) =>
  useApi<"getInvite">(keys.invite(token), () => api.call("getInvite", { params: { token } }));
