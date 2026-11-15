import type { WalletSummary, WorkspaceDetail } from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  Landmark,
  PauseCircle,
  Plus,
  ShieldAlert,
  Users,
} from "lucide-react";
import { useState } from "react";
import { backLinkClass, EmptyState, ErrorState, FormError, Loading } from "@/components/common.tsx";
import { NotificationLevelCard } from "@/components/notifications.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { api, keys, queryClient, useWorkspace } from "@/lib/api.ts";
import { shortAddress } from "@/lib/format.ts";
import { revealToken } from "@/lib/reveal.ts";
import { cn } from "@/lib/utils.ts";

const ROLE_NAMES = { owner: "Owner", approver: "Approver", viewer: "Viewer" } as const;

export function useWorkspaceId(): string {
  return useParams({ from: "/w/$workspaceId" }).workspaceId;
}

/** The workspace's name, its sections and the paused banner, around every workspace page. */
export function WorkspaceLayout() {
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspace(workspaceId);
  if (workspace.isPending) return <Loading />;
  if (workspace.isError) {
    return <ErrorState error={workspace.error} retry={() => void workspace.refetch()} />;
  }
  const data = workspace.data;
  const tabs = [
    { to: "/w/$workspaceId", label: "Overview", exact: true },
    {
      to: "/w/$workspaceId/approvals",
      label: data.pendingApprovals > 0 ? `Approvals (${data.pendingApprovals})` : "Approvals",
      exact: false,
    },
    { to: "/w/$workspaceId/members", label: "Members", exact: false },
    { to: "/w/$workspaceId/activity", label: "Activity", exact: false },
  ] as const;
  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-3">
        <Link to="/" className={backLinkClass}>
          ← All workspaces
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight break-words">{data.name}</h1>
          <Badge>{ROLE_NAMES[data.role]}</Badge>
          {data.paused ? (
            <Badge tone="danger">
              <PauseCircle aria-hidden />
              Paused
            </Badge>
          ) : null}
        </div>
        <nav aria-label="Workspace" className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-1 border-b">
            {tabs.map((tab) => (
              <li key={tab.to}>
                <Link
                  to={tab.to}
                  params={{ workspaceId }}
                  activeOptions={{ exact: tab.exact }}
                  className="-mb-px block border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground"
                  activeProps={{
                    className: "border-accent! text-foreground! font-medium",
                    "aria-current": "page",
                  }}
                >
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {data.paused ? (
        <Alert tone="danger">
          <PauseCircle aria-hidden />
          <p>
            This workspace is paused. The signer refuses every transaction from its wallets until
            enough people approve resuming it.
          </p>
        </Alert>
      ) : null}
      <Outlet />
    </div>
  );
}

export function WorkspaceOverview() {
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspace(workspaceId);
  if (!workspace.data) return null;
  const data = workspace.data;
  const canAdmin = data.role === "owner";
  const withoutPolicy = data.wallets.filter((wallet) => wallet.policy === null);
  const treasury = data.wallets.find((wallet) => wallet.kind === "treasury") ?? null;

  return (
    <div className="grid grid-cols-1 gap-6">
      <NextStep workspace={data} />
      {withoutPolicy.length > 0 && data.agents.length > 0 ? (
        <Alert tone="warning">
          <ShieldAlert aria-hidden />
          <div>
            <p className="font-medium">
              {withoutPolicy.length === 1
                ? "1 wallet has no limits yet"
                : `${withoutPolicy.length} wallets have no limits yet`}
            </p>
            <p className="text-muted-foreground">
              A wallet without limits can sign nothing. Open it and set its limits; the change takes
              effect once approved.
            </p>
          </div>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Agents</CardTitle>
            <CardDescription>Each agent has its own wallet and its own token.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          {data.agents.length === 0 ? (
            <EmptyState icon={<Bot aria-hidden />} title="No agents yet">
              An agent is any program that connects over MCP. It can propose payments from its
              wallet; people approve them here.
            </EmptyState>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.agents.map((agent) => {
                const wallet = data.wallets.find((item) => item.id === agent.walletId);
                return (
                  <li key={agent.id}>
                    <Link
                      to="/w/$workspaceId/agents/$agentId"
                      params={{ workspaceId, agentId: agent.id }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-muted"
                    >
                      <Bot className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{agent.name}</p>
                        {wallet ? (
                          <p className="font-mono text-xs text-muted-foreground">
                            {shortAddress(wallet.address)}
                          </p>
                        ) : null}
                      </div>
                      {wallet && wallet.policy === null ? (
                        <Badge tone="warning">No limits</Badge>
                      ) : null}
                      {agent.status === "active" ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge>Disabled</Badge>
                      )}
                      <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {canAdmin ? <AddAgent workspaceId={workspaceId} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Treasury</CardTitle>
            <CardDescription>
              An optional shared wallet. No agent can use it unless its limits name that agent.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {treasury ? (
            <WalletRow workspaceId={workspaceId} wallet={treasury} />
          ) : canAdmin ? (
            <CreateTreasury workspaceId={workspaceId} />
          ) : (
            <p className="text-sm text-muted-foreground">This workspace has no treasury.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              Changes to wallets' limits and to who approves need {data.adminThreshold}{" "}
              {data.adminThreshold === 1 ? "approval" : "approvals"}.
            </CardDescription>
          </div>
          <Link
            to="/w/$workspaceId/members"
            params={{ workspaceId }}
            className="text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            Manage members
          </Link>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-md border">
            {data.members.map((member) => (
              <li key={member.user.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <Users className="size-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{member.user.displayName}</span>
                <Badge>{ROLE_NAMES[member.role]}</Badge>
                {member.approver === "active" ? (
                  <Badge tone="success">Can approve</Badge>
                ) : member.approver === "pending" ? (
                  <Badge tone="warning">Passkey awaiting approval</Badge>
                ) : (
                  <Badge>Cannot approve</Badge>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <NotificationLevelCard workspace={data} />

      <PauseCard workspace={data} />
    </div>
  );
}

/** First-run guidance: the one obvious thing to do next, until the workspace can work. */
function NextStep({ workspace }: { workspace: WorkspaceDetail }) {
  if (workspace.role !== "owner") return null;
  const firstAgent = workspace.agents[0];
  if (!firstAgent) {
    return (
      <Alert tone="accent">
        <CircleAlert aria-hidden />
        <div>
          <p className="font-medium">Next: add an agent</p>
          <p className="text-muted-foreground">
            Give it a name below. It gets its own wallet and a token to connect with.
          </p>
        </div>
      </Alert>
    );
  }
  const unset = workspace.wallets.find((wallet) => wallet.policy === null && wallet.agentId);
  if (!unset) return null;
  return (
    <Alert tone="accent">
      <CircleAlert aria-hidden />
      <div className="flex flex-1 flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Next: set this wallet's limits</p>
          <p className="text-muted-foreground">
            {unset.label} can sign nothing until its limits are approved.
          </p>
        </div>
        <Link
          to="/w/$workspaceId/wallets/$walletId"
          params={{ workspaceId: workspace.id, walletId: unset.id }}
          hash="policy"
          className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground"
        >
          Set this wallet's policy
        </Link>
      </div>
    </Alert>
  );
}

function WalletRow({ workspaceId, wallet }: { workspaceId: string; wallet: WalletSummary }) {
  return (
    <Link
      to="/w/$workspaceId/wallets/$walletId"
      params={{ workspaceId, walletId: wallet.id }}
      className="flex items-center gap-3 rounded-md border px-4 py-3 hover:bg-muted"
    >
      <Landmark className="size-5 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{wallet.label}</p>
        <p className="font-mono text-xs text-muted-foreground">{shortAddress(wallet.address)}</p>
      </div>
      {wallet.policy === null ? <Badge tone="warning">No limits</Badge> : null}
      <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
    </Link>
  );
}

function AddAgent({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.call("createAgent", { params: { workspaceId }, body: { name } }),
    onSuccess: async (created) => {
      revealToken(created.agent.id, { token: created.token, mcpUrl: created.mcpUrl });
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspaceId) });
      await navigate({
        to: "/w/$workspaceId/agents/$agentId",
        params: { workspaceId, agentId: created.agent.id },
      });
    },
  });
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-2">
        <Label htmlFor="agent-name">Agent name</Label>
        <Input
          id="agent-name"
          placeholder="For example: Invoice payer"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={64}
        />
      </div>
      <Button type="submit" disabled={create.isPending}>
        <Plus aria-hidden />
        {create.isPending ? "Adding…" : "Add an agent"}
      </Button>
      <div className="sm:col-span-2">
        <FormError error={create.error} />
      </div>
    </form>
  );
}

function CreateTreasury({ workspaceId }: { workspaceId: string }) {
  const [label, setLabel] = useState("Treasury");
  const create = useMutation({
    mutationFn: () => api.call("createTreasury", { params: { workspaceId }, body: { label } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.workspace(workspaceId) }),
  });
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-2">
        <Label htmlFor="treasury-label">Treasury name</Label>
        <Input
          id="treasury-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
          maxLength={64}
        />
      </div>
      <Button type="submit" variant="outline" disabled={create.isPending}>
        <Landmark aria-hidden />
        {create.isPending ? "Creating…" : "Create treasury"}
      </Button>
      <div className="sm:col-span-2">
        <FormError error={create.error} />
      </div>
    </form>
  );
}

function PauseCard({ workspace }: { workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  const canAct = workspace.role !== "viewer";
  const pause = useMutation({
    mutationFn: () =>
      api.call("pauseWorkspace", { params: { workspaceId: workspace.id }, body: {} }),
    onSuccess: async (next) => {
      queryClient.setQueryData(keys.workspace(workspace.id), next);
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
  const resume = useMutation({
    mutationFn: () =>
      api.call("requestResume", { params: { workspaceId: workspace.id }, body: {} }),
    onSuccess: async (approval) => {
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
      await navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId: workspace.id, approvalId: approval.id },
      });
    },
  });
  const busy = pause.isPending || resume.isPending;
  return (
    <Card className={cn(workspace.paused && "border-danger/50")}>
      <CardHeader>
        <div className="max-w-xl">
          <CardTitle id="pause-title">Pause all signing</CardTitle>
          <CardDescription>
            Pausing takes effect at once and needs no passkey: it only takes authority away.
            Resuming needs approval, like any other change that gives authority back.
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" aria-hidden>
            {workspace.paused ? "Paused" : "Running"}
          </span>
          <Switch
            aria-labelledby="pause-title"
            checked={workspace.paused}
            disabled={!canAct || busy}
            onCheckedChange={(paused) => (paused ? pause.mutate() : resume.mutate())}
          />
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <FormError error={pause.error ?? resume.error} />
      </CardContent>
    </Card>
  );
}
