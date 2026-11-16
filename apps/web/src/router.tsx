import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AppShell, NotFound, ShellError } from "@/components/app-shell.tsx";
import { ErasedNotice } from "@/components/erase.tsx";
import { api, keys, queryClient } from "@/lib/api.ts";
import { DEFAULT_LANDING, safeReturnPath, signInHref } from "@/lib/return-path.ts";
import { ActivityPage } from "@/routes/activity.tsx";
import { AgentPage } from "@/routes/agent.tsx";
import { ApprovalPage } from "@/routes/approval.tsx";
import { ApprovalsPage } from "@/routes/approvals.tsx";
import { JoinPage, LoginPage, SetupPage } from "@/routes/auth.tsx";
import { CreatedPage } from "@/routes/created.tsx";
import { MandatePage } from "@/routes/mandate.tsx";
import { MembersPage } from "@/routes/members.tsx";
import { PaymentPage } from "@/routes/payment.tsx";
import { SettingsPage } from "@/routes/settings.tsx";
import { WalletPage } from "@/routes/wallet.tsx";
import { WorkspaceLayout, WorkspaceOverview } from "@/routes/workspace.tsx";
import { WorkspacesPage } from "@/routes/workspaces.tsx";

/** Pages a person can open without being signed in. */
const PUBLIC_PATHS = [/^\/login$/, /^\/setup$/, /^\/join\//, /^\/erased$/];

const rootRoute = createRootRoute({
  // Decide where a person belongs before any page renders, so no page asks the API for data
  // it cannot have (a signed-out visitor's workspaces, say).
  beforeLoad: async ({ location }) => {
    const session = await queryClient.ensureQueryData({
      queryKey: keys.session,
      queryFn: () => api.call("getSession"),
    });

    const path = location.pathname;

    if (session.setupRequired) {
      if (path !== "/setup") throw redirect({ to: "/setup", replace: true });

      return { session };
    }

    if (path === "/setup") throw redirect({ to: "/", replace: true });

    if (!session.user && !PUBLIC_PATHS.some((pattern) => pattern.test(path))) {
      // Remember the page asked for (an approval link opened on a phone, say), so signing in
      // opens it instead of the workspace list.
      throw redirect({ href: signInHref(location.href), replace: true });
    }

    return { session };
  },
  component: AppShell,
  errorComponent: ShellError,
  notFoundComponent: NotFound,
});

const setup = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const login = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  // `next` is kept only when it is a path on this site; anything else is dropped here, so the
  // page never sees an unsafe value.
  validateSearch: (search: { next?: unknown }): { next?: string } => {
    const next = safeReturnPath(search.next);

    return next === DEFAULT_LANDING ? {} : { next };
  },
  beforeLoad: ({ context, search }) => {
    if (context.session.user) {
      throw redirect({ href: search.next ?? DEFAULT_LANDING, replace: true });
    }
  },
  component: LoginPage,
});

// Where a person lands once erased, signed out; anyone signed in has nothing to read here.
const erased = createRoute({
  getParentRoute: () => rootRoute,
  path: "/erased",
  beforeLoad: ({ context }) => {
    if (context.session.user) throw redirect({ to: "/", replace: true });
  },
  component: ErasedNotice,
});

const join = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$token",
  component: JoinPage,
});

const home = createRoute({ getParentRoute: () => rootRoute, path: "/", component: WorkspacesPage });

const settings = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const workspace = createRoute({
  getParentRoute: () => rootRoute,
  path: "/w/$workspaceId",
  component: WorkspaceLayout,
});

const overview = createRoute({
  getParentRoute: () => workspace,
  path: "/",
  component: WorkspaceOverview,
});

const approvals = createRoute({
  getParentRoute: () => workspace,
  path: "/approvals",
  component: ApprovalsPage,
});

// Outside the workspace frame on purpose: on a phone, the whole decision fits on one screen.
const approval = createRoute({
  getParentRoute: () => rootRoute,
  path: "/w/$workspaceId/approvals/$approvalId",
  component: ApprovalPage,
});

const wallet = createRoute({
  getParentRoute: () => workspace,
  path: "/wallets/$walletId",
  component: WalletPage,
});

const agent = createRoute({
  getParentRoute: () => workspace,
  path: "/agents/$agentId",
  component: AgentPage,
});

const mandate = createRoute({
  getParentRoute: () => workspace,
  path: "/mandates/$mandateId",
  component: MandatePage,
});

const payment = createRoute({
  getParentRoute: () => workspace,
  path: "/payments/$intentId",
  component: PaymentPage,
});

const members = createRoute({
  getParentRoute: () => workspace,
  path: "/members",
  component: MembersPage,
});

const activity = createRoute({
  getParentRoute: () => workspace,
  path: "/activity",
  component: ActivityPage,
});

// The one page that shows a copied or imported workspace's new tokens and invite links.
const created = createRoute({
  getParentRoute: () => workspace,
  path: "/created",
  component: CreatedPage,
});

const routeTree = rootRoute.addChildren([
  setup,
  login,
  join,
  erased,
  home,
  settings,
  approval,
  workspace.addChildren([
    overview,
    approvals,
    wallet,
    agent,
    mandate,
    payment,
    members,
    activity,
    created,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
