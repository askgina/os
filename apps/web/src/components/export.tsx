import type {
  CloneOptions,
  CloneResult,
  WorkspaceDetail,
  WorkspaceTemplate,
} from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, FileDown, FileUp, KeyRound, ScrollText, ShieldCheck, Users } from "lucide-react";
import { type ChangeEvent, type ReactNode, useId, useState } from "react";
import { CopyButton, FormError, linkClass, useNow } from "@/components/common.tsx";
import { SignInAgain } from "@/components/sign-in-again.tsx";
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
import { api, keys, queryClient } from "@/lib/api.ts";
import {
  copyName,
  downloadText,
  MAX_TEMPLATE_BYTES,
  needsFreshSignIn,
  readTemplateFile,
  recordFileName,
  templateFileName,
  templateFileText,
  thresholdReminder,
} from "@/lib/export.ts";
import { formatCountdown } from "@/lib/format.ts";
import { revealCloneResult } from "@/lib/reveal.ts";

/**
 * Taking a workspace elsewhere. The template is its setup without secrets, history or approvals
 * in advance; the record is its history, opened, that verifies offline; a copy is a new workspace
 * made from the template, with new wallets, keys and tokens. A copy's agent tokens and invite
 * links are shown once, on the page that follows, and never stored or logged here.
 */

const ROLE_NAMES = { owner: "Owner", approver: "Approver", viewer: "Viewer" } as const;

/**
 * Hands a new workspace's result to the page that shows it once, then opens that page. The result
 * goes through memory only (`revealCloneResult`), never the URL, history or storage.
 */
function useOpenCloneResult() {
  const navigate = useNavigate();

  return async (result: CloneResult) => {
    revealCloneResult(result);
    queryClient.setQueryData(keys.workspace(result.workspace.id), result.workspace);
    await queryClient.invalidateQueries({ queryKey: keys.workspaces });
    await navigate({ to: "/w/$workspaceId/created", params: { workspaceId: result.workspace.id } });
  };
}

/** Owners download the template and the record, and copy the workspace. */
export function ExportCard({ workspace }: { workspace: WorkspaceDetail }) {
  const openCloneResult = useOpenCloneResult();
  const [copying, setCopying] = useState(false);

  const template = useMutation({
    mutationFn: () => api.call("exportTemplate", { params: { workspaceId: workspace.id } }),
    onSuccess: (result) =>
      downloadText(templateFileText(result), templateFileName(workspace.name), "application/json"),
  });

  const record = useMutation({
    mutationFn: () => api.call("exportRecord", { params: { workspaceId: workspace.id } }),
    // The record is the workspace's whole history: kept here no longer than it takes to save it.
    gcTime: 0,
    onSuccess: ({ record: lines }) =>
      downloadText(lines, recordFileName(workspace.name, new Date()), "application/x-ndjson"),
  });

  const clone = useMutation({
    mutationFn: (options: CloneOptions) =>
      api.call("cloneWorkspace", { params: { workspaceId: workspace.id }, body: options }),
    // The result holds new agent tokens: it leaves this cache as soon as it is handed on.
    gcTime: 0,
    onSuccess: openCloneResult,
  });

  const deleting = workspace.lifecycle.state !== "active";

  return (
    <Card id="export">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Export or copy</CardTitle>
          <CardDescription>
            The template is this workspace's setup: its wallets, their limits, its agents' names and
            its members, with no key, token, history or approval in advance. The record is its whole
            history, which anyone can check offline.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5">
        <div className="grid grid-cols-1 gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => template.mutate()}
              disabled={template.isPending}
            >
              <FileDown aria-hidden />
              {template.isPending ? "Preparing…" : "Download template"}
            </Button>
            <Button variant="outline" onClick={() => record.mutate()} disabled={record.isPending}>
              <ScrollText aria-hidden />
              {record.isPending ? "Preparing…" : "Download record"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The record needs a passkey sign-in from the last 5 minutes, and is noted in the activity
            log.
          </p>
          <FormError error={template.error} />
          {needsFreshSignIn(record.error) ? (
            <SignInAgain returnTo={`/w/${workspace.id}#export`}>
              Sign in again with your passkey to download the record: your sign-in is more than 5
              minutes old. You come back here afterwards.
            </SignInAgain>
          ) : (
            <FormError error={record.error} />
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 border-t pt-5">
          <div>
            <p className="font-medium">Copy this workspace</p>
            <p className="text-sm text-muted-foreground">
              A new workspace from this one's template, with you as its only member and approver:
              new wallets with new keys, new agent tokens, and each wallet's limits waiting for your
              approval. None of this workspace's history, keys or approvals in advance.
            </p>
          </div>
          {deleting ? (
            <p className="text-sm text-muted-foreground">
              A workspace being deleted cannot be copied. Its template can still be downloaded and
              imported.
            </p>
          ) : copying ? (
            <CloneForm
              defaultName={copyName(workspace.name)}
              submitLabel="Create the copy"
              pending={clone.isPending}
              error={clone.error}
              onSubmit={(options) => clone.mutate(options)}
              onCancel={() => setCopying(false)}
            />
          ) : (
            <div>
              <Button variant="outline" onClick={() => setCopying(true)}>
                <Copy aria-hidden />
                Copy this workspace…
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** A checkbox with its label and a line that says what it does. */
function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-w-0 items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-(--accent)"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        {label}
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}

/** The new workspace's name and what it takes along besides the wallets' setup. */
function CloneForm({
  defaultName,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  children,
}: {
  defaultName: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (options: CloneOptions) => void;
  onCancel?: () => void;
  children?: ReactNode;
}) {
  const nameId = useId();
  const [name, setName] = useState(defaultName);
  const [includeAgents, setIncludeAgents] = useState(true);
  const [includeMembers, setIncludeMembers] = useState(true);

  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ name: name.trim(), includeAgents, includeMembers });
      }}
    >
      {children}
      <div className="grid grid-cols-1 gap-2">
        <Label htmlFor={nameId}>Name of the new workspace</Label>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={64}
        />
      </div>
      <fieldset className="grid grid-cols-1 gap-3">
        <legend className="mb-1 text-sm font-medium">Also take along</legend>
        <Toggle
          label="Its agents"
          detail="Each gets a new wallet and a new token, shown once on the next page."
          checked={includeAgents}
          onChange={setIncludeAgents}
        />
        <Toggle
          label="Its members, as invite links"
          detail="One link per member this server knows, with their role, for you to pass on."
          checked={includeMembers}
          onChange={setIncludeMembers}
        />
      </fieldset>
      <FormError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Any signed-in person makes a new workspace from a template file. */
export function ImportTemplateCard() {
  const openCloneResult = useOpenCloneResult();
  const fileId = useId();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<{ fileName: string; template: WorkspaceTemplate } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const importTemplate = useMutation({
    mutationFn: ({ template, options }: { template: WorkspaceTemplate; options: CloneOptions }) =>
      api.call("importTemplate", { body: { template, ...options } }),
    // The result holds new agent tokens: it leaves this cache as soon as it is handed on.
    gcTime: 0,
    onSuccess: openCloneResult,
  });

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setRead(null);
    setProblem(null);
    importTemplate.reset();

    if (!file) return;

    if (file.size > MAX_TEMPLATE_BYTES) {
      setProblem("This file is too large to be a workspace template.");

      return;
    }

    const result = readTemplateFile(await file.text());

    if (result.ok) setRead({ fileName: file.name, template: result.template });
    else setProblem(result.problem);
  };

  const agents = read?.template.wallets.filter((wallet) => wallet.agent !== null).length ?? 0;

  return (
    <Card id="import">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Import a template</CardTitle>
          <CardDescription>
            A template file downloaded from a workspace, on this server or another. It makes a new
            workspace with new wallets and keys, with you as its only approver.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {open ? (
          <>
            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor={fileId}>Template file</Label>
              <input
                id={fileId}
                type="file"
                accept="application/json,.json"
                onChange={(event) => void choose(event)}
                className="w-full min-w-0 text-sm file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium"
              />
              {problem ? (
                <p role="alert" className="text-sm text-danger">
                  {problem}
                </p>
              ) : null}
            </div>
            {read ? (
              <CloneForm
                // A new file starts a new form, named as its template.
                key={read.fileName + read.template.name}
                defaultName={read.template.name}
                submitLabel="Create workspace from template"
                pending={importTemplate.isPending}
                error={importTemplate.error}
                onSubmit={(options) => importTemplate.mutate({ template: read.template, options })}
              >
                <p className="text-sm text-muted-foreground">
                  {read.template.name}: {read.template.wallets.length}{" "}
                  {read.template.wallets.length === 1 ? "wallet" : "wallets"}, {agents}{" "}
                  {agents === 1 ? "agent" : "agents"}, {read.template.members.length}{" "}
                  {read.template.members.length === 1 ? "member" : "members"}. Members this server
                  does not know are left out.
                </p>
              </CloneForm>
            ) : null}
          </>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <FileUp aria-hidden />
              Import a template…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What a copy or an import made, shown once: the new agents' tokens, the limits waiting for
 * approval, the invite links, and the admin threshold to raise later.
 */
export function CloneResultView({ result }: { result: CloneResult }) {
  const now = useNow();
  const workspaceId = result.workspace.id;

  return (
    <div className="grid grid-cols-1 gap-6">
      <Alert tone="success" className="items-start">
        <ShieldCheck aria-hidden />
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <h2 className="font-medium">The new workspace is ready</h2>
          <p className="text-muted-foreground">
            New wallets with new keys. Nothing of the source's history, keys or approvals in advance
            came along, and no wallet signs anything until its limits are approved.
          </p>
        </div>
      </Alert>

      {result.agents.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Agent tokens</CardTitle>
              <CardDescription>Each agent connects over MCP with its own token.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4">
            <Alert tone="warning" className="items-start">
              <KeyRound aria-hidden />
              <div className="grid min-w-0 grid-cols-1 gap-1">
                <p className="font-medium">Copy these tokens now. They are shown only now.</p>
                <p className="text-muted-foreground">
                  Leaving or reloading this page loses them for good; an agent's page can make it a
                  new one. Anyone holding a token can propose payments as that agent. Store each
                  like a password.
                </p>
              </div>
            </Alert>
            <ul className="grid grid-cols-1 gap-4" aria-label="New agent tokens">
              {result.agents.map((agent) => {
                const name =
                  result.workspace.agents.find((item) => item.id === agent.agentId)?.name ??
                  "Agent";

                return (
                  <li key={agent.agentId} className="grid grid-cols-1 gap-2">
                    <Link
                      to="/w/$workspaceId/agents/$agentId"
                      params={{ workspaceId, agentId: agent.agentId }}
                      className={`${linkClass} wrap-anywhere`}
                    >
                      {name}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="min-w-0 flex-1 rounded-md border bg-card px-3 py-2 font-mono text-sm break-all">
                        {agent.token}
                      </code>
                      <CopyButton value={agent.token} label={`Copy ${name}'s token`} />
                    </div>
                    <p className="text-xs text-muted-foreground break-all">
                      MCP address: <span className="font-mono">{agent.mcpUrl}</span>
                    </p>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Limits waiting for approval</CardTitle>
            <CardDescription>
              Approve each on the signer's page. Until then that wallet signs nothing.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {result.approvals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No wallet had limits to copy. Set each wallet's limits on its page.
            </p>
          ) : (
            <ul className="divide-y rounded-md border" aria-label="Limits waiting for approval">
              {result.approvals.map((approval) => (
                <li key={approval.id}>
                  <Link
                    to="/w/$workspaceId/approvals/$approvalId"
                    params={{ workspaceId, approvalId: approval.id }}
                    className="block px-4 py-3 font-medium wrap-anywhere hover:bg-muted"
                  >
                    {approval.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {result.invites.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>Invite links</CardTitle>
              <CardDescription>
                Pass each link on to its person; anyone holding it can join with that role. Open
                invites are also listed under Members.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="grid grid-cols-1 gap-4" aria-label="Invite links">
              {result.invites.map((invite) => {
                const id = `invite-${invite.userId}`;

                return (
                  <li key={invite.userId} className="grid grid-cols-1 gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Users className="size-4 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 font-medium wrap-anywhere">
                        {invite.displayName}
                      </span>
                      <Badge>{ROLE_NAMES[invite.role]}</Badge>
                    </div>
                    <Label htmlFor={id} className="text-xs text-muted-foreground">
                      Invite link for {invite.displayName}, valid for{" "}
                      {formatCountdown(invite.expiresAt - now)}
                    </Label>
                    <div className="flex gap-2">
                      <Input id={id} readOnly value={invite.url} className="font-mono text-xs" />
                      <CopyButton
                        value={invite.url}
                        label={`Copy ${invite.displayName}'s invite link`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Alert tone="accent" className="items-start">
        <ShieldCheck aria-hidden />
        <p>
          {thresholdReminder(result.templateAdminThreshold)}{" "}
          <Link to="/w/$workspaceId/members" params={{ workspaceId }} className={linkClass}>
            Members
          </Link>
        </p>
      </Alert>

      <div>
        <Link to="/w/$workspaceId" params={{ workspaceId }} className={linkClass}>
          Open the new workspace
        </Link>
      </div>
    </div>
  );
}

/** In place of the result after a reload or a return: it was shown once and is gone. */
export function CloneResultGone({ workspaceId }: { workspaceId: string }) {
  return (
    <Alert className="items-start">
      <KeyRound aria-hidden />
      <div className="grid min-w-0 grid-cols-1 gap-2">
        <p className="font-medium">Shown once, and gone</p>
        <p className="text-muted-foreground">
          The new agents' tokens and the invite links were shown when this workspace was made and
          are not kept. Make a new token on an agent's page, and new invite links under Members.
        </p>
        <Link to="/w/$workspaceId" params={{ workspaceId }} className={linkClass}>
          Open the workspace
        </Link>
      </div>
    </Alert>
  );
}
