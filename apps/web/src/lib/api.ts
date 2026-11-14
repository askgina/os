import { ApiError, createApiClient, type RouteName, type RouteOutput } from "@askgina/os-api";
import {
  keepPreviousData,
  QueryCache,
  QueryClient,
  type QueryKey,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";

/** Every request goes to the page's own origin; the session cookie rides along. */
export const api = createApiClient();

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // A session can end while a page is open (it expired, or was signed out elsewhere). Start
    // over from the sign-in page instead of showing every list as an error.
    onError: (error) => {
      if (error instanceof ApiError && error.code === "unauthenticated") {
        queryClient.clear();
        window.location.assign("/login");
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
  audit: (workspaceId: string) => ["audit", workspaceId] as const,
  decisions: (workspaceId: string) => ["decisions", workspaceId] as const,
  passkeys: ["passkeys"] as const,
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

/** An approval page follows its request to the end: it polls until the status is final. */
export const useApproval = (approvalId: string) =>
  useQuery({
    queryKey: keys.approval(approvalId),
    queryFn: () => api.call("getApproval", { params: { approvalId } }),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      if (ACTIVE_APPROVAL.has(data.status)) return 3_000;
      // An executed transfer is signed but may still be on its way to the chain.
      if (data.subject.kind === "approve-intent") {
        const status = data.subject.intent.status;
        if (status === "signed" || status === "broadcast" || status === "approved") return 3_000;
      }
      return false;
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

export const useInvites = (workspaceId: string) =>
  useApi<"listInvites">(keys.invites(workspaceId), () =>
    api.call("listInvites", { params: { workspaceId } }),
  );

export const useInvite = (token: string) =>
  useApi<"getInvite">(keys.invite(token), () => api.call("getInvite", { params: { token } }));
