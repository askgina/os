import type {
  ApprovalSummary,
  InviteSummary,
  Member,
  PendingPasskey,
  Role,
  WorkspaceDetail,
} from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound, Link2, UserMinus, X } from "lucide-react";
import { useState } from "react";
import { CopyButton, FormError, linkClass, useNow } from "@/components/common.tsx";
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
import { Input, Select } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { api, keys, queryClient, useInvites, useSession, useWorkspace } from "@/lib/api.ts";
import { formatCountdown, formatTime } from "@/lib/format.ts";
import { enrollApproverCommand } from "@/lib/operator.ts";
import { useWorkspaceId } from "@/routes/workspace.tsx";

const ROLE_NAMES: Record<Role, string> = { owner: "Owner", approver: "Approver", viewer: "Viewer" };
const ROLE_HINTS: Record<Role, string> = {
  owner: "Changes everything, approves",
  approver: "Approves payments and changes",
  viewer: "Sees everything, approves nothing",
};

export function MembersPage() {
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspace(workspaceId);
  const session = useSession();
  const [opened, setOpened] = useState<ApprovalSummary[]>([]);
  // Invites revoked on this page: the link card must stop showing a link that no longer works.
  const [revoked, setRevoked] = useState<string[]>([]);
  if (!workspace.data) return null;
  const data = workspace.data;
  const isOwner = data.role === "owner";
  const me = session.data?.user?.id;

  return (
    <div className="grid gap-6">
      {opened.length > 0 ? (
        <Alert tone="accent" className="items-start">
          <div className="grid gap-1">
            <p className="font-medium">
              This change needs approval before it takes effect for the signer.
            </p>
            <ul className="grid gap-1">
              {opened.map((approval) => (
                <li key={approval.id}>
                  <Link
                    to="/w/$workspaceId/approvals/$approvalId"
                    params={{ workspaceId, approvalId: approval.id }}
                    className={linkClass}
                  >
                    {approval.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              Role changes and removals that affect who can approve need approval themselves.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-md border">
            {data.members.map((member) => (
              <MemberRow
                key={member.user.id}
                workspaceId={workspaceId}
                member={member}
                editable={isOwner && member.user.id !== me}
                onApprovals={setOpened}
              />
            ))}
          </ul>
        </CardContent>
      </Card>

      {isOwner ? <InviteCard workspaceId={workspaceId} revoked={revoked} /> : null}
      {isOwner ? (
        <OpenInvites
          workspaceId={workspaceId}
          onRevoked={(inviteId) => setRevoked((ids) => [...ids, inviteId])}
        />
      ) : null}
      {isOwner ? <ThresholdCard workspace={data} /> : null}
    </div>
  );
}

function MemberRow({
  workspaceId,
  member,
  editable,
  onApprovals,
}: {
  workspaceId: string;
  member: Member;
  editable: boolean;
  onApprovals: (approvals: ApprovalSummary[]) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const params = { workspaceId, userId: member.user.id };
  const setRole = useMutation({
    mutationFn: (role: Role) => api.call("setMemberRole", { params, body: { role } }),
    onSuccess: async ({ approvals }) => {
      onApprovals(approvals);
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspaceId) });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.call("removeMember", { params }),
    onSuccess: async ({ approvals }) => {
      setConfirmRemove(false);
      onApprovals(approvals);
      await queryClient.invalidateQueries({ queryKey: keys.workspace(workspaceId) });
    },
  });
  const selectId = `role-${member.user.id}`;
  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate font-medium">{member.user.displayName}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {member.approver === "active" ? (
            <Badge tone="success">Can approve</Badge>
          ) : member.approver === "pending" ? (
            <Badge tone="warning">Passkey awaiting approval</Badge>
          ) : (
            <Badge>Cannot approve</Badge>
          )}
        </div>
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={selectId} className="sr-only">
            Role of {member.user.displayName}
          </Label>
          <Select
            id={selectId}
            className="w-auto"
            value={member.role}
            disabled={setRole.isPending}
            onChange={(event) => setRole.mutate(event.target.value as Role)}
          >
            {(["owner", "approver", "viewer"] as const).map((role) => (
              <option key={role} value={role}>
                {ROLE_NAMES[role]}: {ROLE_HINTS[role]}
              </option>
            ))}
          </Select>
          <Button variant="outline" size="sm" onClick={() => setConfirmRemove(true)}>
            <UserMinus aria-hidden />
            Remove
          </Button>
        </div>
      ) : (
        <Badge className="w-fit">{ROLE_NAMES[member.role]}</Badge>
      )}
      <div className="sm:col-span-2">
        <FormError error={setRole.error} />
      </div>
      {member.pendingPasskeys.length > 0 ? (
        <div className="grid gap-3 sm:col-span-2">
          {member.pendingPasskeys.map((passkey) => (
            <PendingPasskeyHelp
              key={passkey.credentialId}
              workspaceId={workspaceId}
              member={member}
              passkey={passkey}
            />
          ))}
        </div>
      ) : null}
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${member.user.displayName}?`}
      >
        <p className="mt-2 text-sm text-muted-foreground">
          They lose access to this workspace. If they can approve, removing their passkeys from the
          signer needs approval too.
        </p>
        <FormError error={remove.error} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmRemove(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}

/**
 * A passkey that cannot approve yet. Both ways in are spelled out, because when the last
 * approver is gone the inbox route can never complete and only the operator can help.
 */
function PendingPasskeyHelp({
  workspaceId,
  member,
  passkey,
}: {
  workspaceId: string;
  member: Member;
  passkey: PendingPasskey;
}) {
  let command: string | null = null;
  try {
    command = enrollApproverCommand({
      workspaceId,
      userId: member.user.id,
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
    });
  } catch {
    // Offer no command rather than one that could run something else on the signer's host.
  }
  return (
    <div className="grid gap-2 rounded-md border bg-muted p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <KeyRound className="size-4 shrink-0" aria-hidden />
        Passkey “{passkey.label}” is waiting to become an approver
      </p>
      <p className="text-muted-foreground">There are two ways it can start approving:</p>
      <ol className="grid list-decimal gap-2 pl-5">
        <li>
          Someone who can already approve accepts the request in the{" "}
          <Link to="/w/$workspaceId/approvals" params={{ workspaceId }} className={linkClass}>
            approval inbox
          </Link>
          .
        </li>
        <li className="grid gap-2">
          <span>
            If nobody who can approve is left, the operator runs this one command on the signer's
            host:
          </span>
          {command ? (
            <div className="flex items-start gap-2">
              <textarea
                readOnly
                rows={4}
                spellCheck={false}
                aria-label="Command to enroll this passkey at the signer"
                className="min-w-0 flex-1 resize-none rounded-md border bg-card p-2 font-mono text-xs break-all"
                value={command}
              />
              <CopyButton value={command} label="Copy the command" />
            </div>
          ) : (
            <span className="text-danger">
              The server sent values that are not safe to put in a command, so none is shown.
            </span>
          )}
          <span className="text-muted-foreground">
            Whoever can run commands on the signer's host controls who approves, with no passkey
            needed. Run it only for a passkey you know is this person's.
          </span>
        </li>
      </ol>
    </div>
  );
}

/** Invites still waiting to be used. Revoking one makes its link stop working at once. */
function OpenInvites({
  workspaceId,
  onRevoked,
}: {
  workspaceId: string;
  onRevoked: (inviteId: string) => void;
}) {
  const invites = useInvites(workspaceId);
  const revoke = useMutation({
    mutationFn: (inviteId: string) =>
      api.call("revokeInvite", { params: { workspaceId, inviteId } }),
    onSuccess: (_result, inviteId) => {
      onRevoked(inviteId);
      return queryClient.invalidateQueries({ queryKey: keys.invites(workspaceId) });
    },
  });
  const items: InviteSummary[] = invites.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Open invites</CardTitle>
          <CardDescription>Links that have not been used yet.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <FormError error={invites.error ?? revoke.error} />
        {invites.data && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open invites.</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="divide-y rounded-md border" aria-label="Open invites">
            {items.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">{ROLE_NAMES[invite.role]}</p>
                  <p className="text-muted-foreground">
                    Created by {invite.createdBy.displayName} · expires{" "}
                    {formatTime(invite.expiresAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(invite.id)}
                >
                  <X aria-hidden />
                  Revoke<span className="sr-only"> the {ROLE_NAMES[invite.role]} invite</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InviteCard({ workspaceId, revoked }: { workspaceId: string; revoked: string[] }) {
  const [role, setRole] = useState<Role>("approver");
  const now = useNow();
  const invite = useMutation({
    mutationFn: () => api.call("createInvite", { params: { workspaceId }, body: { role } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.invites(workspaceId) }),
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Invite someone</CardTitle>
          <CardDescription>
            The link works once and is shown only here. Send it privately.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {(["approver", "viewer", "owner"] as const).map((item) => (
                <option key={item} value={item}>
                  {ROLE_NAMES[item]}: {ROLE_HINTS[item]}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={invite.isPending}>
            <Link2 aria-hidden />
            {invite.isPending ? "Creating…" : "Create invite link"}
          </Button>
        </form>
        <FormError error={invite.error} />
        {invite.data && !revoked.includes(invite.data.id) ? (
          <div className="grid gap-2 rounded-md border bg-muted p-3">
            <Label htmlFor="invite-url">
              Invite link, valid for {formatCountdown(invite.data.expiresAt - now)}
            </Label>
            <div className="flex gap-2">
              <Input
                id="invite-url"
                readOnly
                value={invite.data.url}
                className="font-mono text-xs"
              />
              <CopyButton value={invite.data.url} label="Copy invite link" />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ThresholdCard({ workspace }: { workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  // The signer refuses an admin threshold below any wallet's own approval threshold.
  const lowest = Math.max(
    1,
    ...workspace.wallets.map((wallet) => wallet.policy?.approvals.threshold ?? 1),
  );
  const [value, setValue] = useState(String(workspace.adminThreshold));
  const request = useMutation({
    mutationFn: () =>
      api.call("requestAdminThreshold", {
        params: { workspaceId: workspace.id },
        body: { adminThreshold: Number(value) },
      }),
    onSuccess: (approval) =>
      navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId: workspace.id, approvalId: approval.id },
      }),
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Approvals needed for admin changes</CardTitle>
          <CardDescription>
            How many people must approve changes to wallets' limits and to who approves. Now:{" "}
            {workspace.adminThreshold}. It cannot be lower than any wallet's own number of approvals
            {lowest > 1 ? `, so at least ${lowest}` : ""}.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-[12rem_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            request.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="admin-threshold">Approvals needed</Label>
            <Input
              id="admin-threshold"
              type="number"
              min={lowest}
              max={16}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            className="w-fit"
            disabled={request.isPending || Number(value) === workspace.adminThreshold}
          >
            {request.isPending ? "Requesting…" : "Request change"}
          </Button>
        </form>
        <FormError error={request.error} />
      </CardContent>
    </Card>
  );
}
