import type { WorkspaceDetail } from "@askgina/os-api";
import type { AgentId, WalletId } from "@askgina/os-protocol";
import { useMutation } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Ban, KeyRound, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  FullAddress,
  IntentStatusBadge,
  Loading,
  linkClass,
  PageHeader,
  useNow,
} from "@/components/common.tsx";
import { MandatesCard } from "@/components/mandate.tsx";
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
import { Dialog } from "@/components/ui/dialog.tsx";
import { api, keys, queryClient, useIntents, useWallet, useWorkspace } from "@/lib/api.ts";
import { explainCode } from "@/lib/codes.ts";
import { formatRelative } from "@/lib/format.ts";
import { type RevealedToken, takeRevealedToken } from "@/lib/reveal.ts";
import { intentStatusSentence } from "@/lib/statuses.ts";

export function AgentPage() {
  const { workspaceId, agentId } = useParams({ from: "/w/$workspaceId/agents/$agentId" });
  const workspace = useWorkspace(workspaceId);
  const [revealed, setRevealed] = useState<RevealedToken | null>(() => takeRevealedToken(agentId));
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const rotate = useMutation({
    mutationFn: () => api.call("rotateAgentToken", { params: { workspaceId, agentId }, body: {} }),
    onSuccess: async ({ token }) => {
      setConfirmRotate(false);
      setRevealed({ token, mcpUrl: null });
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspaceId) });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.call("disableAgent", { params: { workspaceId, agentId }, body: {} }),
    onSuccess: async () => {
      setConfirmDisable(false);
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspaceId) });
      // Disabling an agent revokes its approvals in advance.
      await queryClient.invalidateQueries({ queryKey: keys.mandates(workspaceId) });
    },
  });

  if (!workspace.data) return null;
  const agent = workspace.data.agents.find((item) => item.id === agentId);
  if (!agent)
    return <ErrorState error={new Error("This agent does not exist in this workspace.")} />;
  const wallet = workspace.data.wallets.find((item) => item.id === agent.walletId);
  const canAdmin = workspace.data.role === "owner";
  const mcpUrl = revealed?.mcpUrl ?? `${window.location.origin}/mcp`;

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title={agent.name}
        description={`Token starts with ${agent.tokenPrefix}`}
        actions={
          <>
            {agent.status === "active" ? (
              <Badge tone="success">Active</Badge>
            ) : (
              <Badge>Disabled</Badge>
            )}
            {canAdmin && agent.status === "active" ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setConfirmRotate(true)}>
                  <RefreshCw aria-hidden />
                  New token
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmDisable(true)}>
                  <Ban aria-hidden />
                  Disable
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {revealed ? <TokenReveal token={revealed.token} /> : null}

      {wallet ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Wallet</CardTitle>
              <CardDescription>
                This agent's own wallet. Only it can propose from it.
              </CardDescription>
            </div>
            <Link
              to="/w/$workspaceId/wallets/$walletId"
              params={{ workspaceId, walletId: wallet.id }}
              className={linkClass}
            >
              {wallet.policy ? "Open wallet" : "Set this wallet's policy"}
            </Link>
          </CardHeader>
          <CardContent>
            <FullAddress address={wallet.address} />
            {wallet.policy === null ? (
              <p className="mt-2 text-sm text-warning">No limits yet: it can sign nothing.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Connect the agent</CardTitle>
            <CardDescription>
              Any MCP client works. The agent can propose payments and read their outcome; it cannot
              approve, sign or change anything.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5">
          <dl className="grid grid-cols-1 gap-3">
            <Field label="MCP address">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono break-all">{mcpUrl}</code>
                <CopyButton value={mcpUrl} label="Copy MCP address" />
              </div>
            </Field>
          </dl>
          <Snippet
            title="MCP client configuration (JSON)"
            text={mcpJson(mcpUrl, revealed?.token)}
          />
          <Snippet
            title="Try it with the example agent"
            text={scriptedAgentCommand(mcpUrl, revealed?.token)}
          />
          {revealed ? null : (
            <p className="text-sm text-muted-foreground">
              The token is not stored where this page can read it. Replace{" "}
              <code className="font-mono">&lt;agent token&gt;</code> with the token you saved, or
              create a new one.
            </p>
          )}
        </CardContent>
      </Card>

      <AgentMandates
        workspace={workspace.data}
        agentId={agent.id}
        walletId={agent.walletId}
        active={agent.status === "active"}
      />

      <RecentIntents workspaceId={workspaceId} agentId={agentId} />

      <Dialog
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        title="Create a new token?"
      >
        <p className="mt-2 text-sm text-muted-foreground">
          The current token stops working at once. Anything using it must be given the new one.
        </p>
        <FormError error={rotate.error} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmRotate(false)}>
            Keep current token
          </Button>
          <Button onClick={() => rotate.mutate()} disabled={rotate.isPending}>
            {rotate.isPending ? "Creating…" : "Create new token"}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title="Disable this agent?"
      >
        <p className="mt-2 text-sm text-muted-foreground">
          Its token stops working and it can propose nothing more. Its approvals in advance are
          revoked. Its wallet and history stay.
        </p>
        <FormError error={disable.error} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmDisable(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => disable.mutate()}
            disabled={disable.isPending}
          >
            {disable.isPending ? "Disabling…" : "Disable agent"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The agent's approvals in advance, on any wallet. An owner may ask for a new one from the
 * agent's own wallet, while the agent is active.
 */
function AgentMandates({
  workspace,
  agentId,
  walletId,
  active,
}: {
  workspace: WorkspaceDetail;
  agentId: AgentId;
  walletId: WalletId;
  active: boolean;
}) {
  const wallet = useWallet(workspace.id, walletId);
  return (
    <MandatesCard
      workspace={workspace}
      filter={{ agentId }}
      editor={wallet.data && active ? { wallet: wallet.data, agentId } : null}
    />
  );
}

function TokenReveal({ token }: { token: string }) {
  return (
    <Alert tone="warning" className="items-start">
      <KeyRound aria-hidden />
      <div className="grid min-w-0 flex-1 grid-cols-1 gap-3">
        <div>
          <p className="font-medium">Copy this token now. It is shown only this once.</p>
          <p className="text-muted-foreground">
            Anyone holding it can propose payments as this agent (people still have to approve
            them). Store it like a password.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 rounded-md border bg-card px-3 py-2 font-mono text-sm break-all">
            {token}
          </code>
          <CopyButton value={token} label="Copy agent token" />
        </div>
      </div>
    </Alert>
  );
}

function mcpJson(url: string, token: string | undefined): string {
  return JSON.stringify(
    {
      mcpServers: {
        wallet: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token ?? "<agent token>"}` },
        },
      },
    },
    null,
    2,
  );
}

function scriptedAgentCommand(url: string, token: string | undefined): string {
  return [
    `MCP_URL=${url} \\`,
    `AGENT_TOKEN=${token ?? "'<agent token>'"} \\`,
    "node examples/scripted-agent/src/main.ts",
  ].join("\n");
}

function Snippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <CopyButton value={text} label={`Copy ${title}`} />
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

function RecentIntents({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const intents = useIntents(workspaceId);
  const now = useNow();
  const mine = intents.data?.items.filter((intent) => intent.agent.id === agentId) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent requests</CardTitle>
      </CardHeader>
      <CardContent>
        {intents.isPending ? <Loading /> : null}
        {intents.isError ? <ErrorState error={intents.error} /> : null}
        {intents.data && mine.length === 0 ? (
          <EmptyState title="This agent has asked for nothing yet.">
            Requests appear here as soon as it proposes one.
          </EmptyState>
        ) : null}
        {mine.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {mine.map((intent) => (
              <li key={intent.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {intent.approvalId ? (
                    <Link
                      to="/w/$workspaceId/approvals/$approvalId"
                      params={{ workspaceId, approvalId: intent.approvalId }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {intent.display.title}
                    </Link>
                  ) : (
                    <p className="font-medium">{intent.display.title}</p>
                  )}
                  {intent.mandateId ? (
                    <p className="text-xs">
                      <Link
                        to="/w/$workspaceId/mandates/$mandateId"
                        params={{ workspaceId, mandateId: intent.mandateId }}
                        className={linkClass}
                      >
                        Approved in advance
                      </Link>
                      <span className="text-muted-foreground">: nobody was asked.</span>
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {formatRelative(intent.createdAt, now)} ·{" "}
                    {intentStatusSentence(intent.status, intent.mandateId !== null)}
                  </p>
                  {intent.failureCode ? (
                    <p className="text-xs text-muted-foreground">
                      {explainCode(intent.failureCode)}
                    </p>
                  ) : null}
                </div>
                <IntentStatusBadge status={intent.status} />
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
