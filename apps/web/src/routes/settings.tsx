import type { ApprovalSummary, PasskeySummary } from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound, LogOut, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  FormError,
  Loading,
  linkClass,
  PageHeader,
} from "@/components/common.tsx";
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
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { api, keys, queryClient, usePasskeys, useSession } from "@/lib/api.ts";
import { formatTime } from "@/lib/format.ts";
import { createPasskey } from "@/lib/passkey.ts";

export function SettingsPage() {
  const session = useSession();
  const passkeys = usePasskeys();
  const navigate = useNavigate();
  const [opened, setOpened] = useState<ApprovalSummary[]>([]);
  const logout = useMutation({
    mutationFn: () => api.call("logout", { body: {} }),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Your passkeys"
        description={
          session.data?.user ? `Signed in as ${session.data.user.displayName}` : undefined
        }
        actions={
          <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut aria-hidden />
            {logout.isPending ? "Signing out…" : "Sign out"}
          </Button>
        }
      />
      <FormError error={logout.error} />
      {opened.length > 0 ? (
        <Alert tone="accent" className="items-start">
          <div className="grid gap-1">
            <p className="font-medium">Workspaces where you approve must agree to this change:</p>
            <ul>
              {opened.map((approval) => (
                <li key={approval.id}>
                  <Link
                    to="/w/$workspaceId/approvals/$approvalId"
                    params={{ workspaceId: approval.workspaceId, approvalId: approval.id }}
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
            <CardTitle>Passkeys</CardTitle>
            <CardDescription>
              A passkey signs you in and approves requests. Keep more than one, on different
              devices, so losing one does not lock you out.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          {passkeys.isPending ? <Loading /> : null}
          {passkeys.isError ? (
            <ErrorState error={passkeys.error} retry={() => void passkeys.refetch()} />
          ) : null}
          {passkeys.data && passkeys.data.items.length === 0 ? (
            <EmptyState icon={<KeyRound aria-hidden />} title="No passkeys" />
          ) : null}
          {passkeys.data && passkeys.data.items.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {passkeys.data.items.map((passkey) => (
                <PasskeyRow
                  key={passkey.credentialId}
                  passkey={passkey}
                  last={passkeys.data.items.length === 1}
                  onApprovals={setOpened}
                />
              ))}
            </ul>
          ) : null}
          <AddPasskey onApprovals={setOpened} />
        </CardContent>
      </Card>
    </div>
  );
}

function PasskeyRow({
  passkey,
  last,
  onApprovals,
}: {
  passkey: PasskeySummary;
  last: boolean;
  onApprovals: (approvals: ApprovalSummary[]) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.call("removePasskey", { params: { credentialId: passkey.credentialId } }),
    onSuccess: async ({ approvals }) => {
      setConfirm(false);
      onApprovals(approvals);
      await queryClient.invalidateQueries({ queryKey: keys.passkeys });
    },
  });
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <KeyRound className="size-4 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">{passkey.label}</p>
        <p className="text-xs text-muted-foreground">
          Added {formatTime(passkey.createdAt)} ·{" "}
          {passkey.lastUsedAt ? `last used ${formatTime(passkey.lastUsedAt)}` : "never used"}
        </p>
      </div>
      {passkey.deviceType === "multiDevice" ? (
        <Badge>Synced by its provider</Badge>
      ) : (
        <Badge>This device only</Badge>
      )}
      <Button variant="ghost" size="sm" onClick={() => setConfirm(true)} disabled={last}>
        <Trash2 aria-hidden />
        Remove
      </Button>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Remove "${passkey.label}"?`}>
        <p className="mt-2 text-sm text-muted-foreground">
          It stops signing you in at once. Where it approves, removing it from the signer needs
          approval.
        </p>
        <FormError error={remove.error} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirm(false)}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending ? "Removing…" : "Remove passkey"}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}

function AddPasskey({ onApprovals }: { onApprovals: (approvals: ApprovalSummary[]) => void }) {
  const [label, setLabel] = useState("");
  const add = useMutation({
    mutationFn: async () => {
      const start = await api.call("startAddPasskey", { body: {} });
      const response = await createPasskey(start.options);
      return api.call("finishAddPasskey", {
        body: { ceremonyId: start.ceremonyId, response, label },
      });
    },
    onSuccess: async ({ approvals }) => {
      setLabel("");
      onApprovals(approvals);
      await queryClient.invalidateQueries({ queryKey: keys.passkeys });
    },
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="passkey-label">Name for the new passkey</Label>
        <Input
          id="passkey-label"
          placeholder="For example: Work laptop"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
          maxLength={64}
        />
      </div>
      <Button type="submit" disabled={add.isPending}>
        <Plus aria-hidden />
        {add.isPending ? "Waiting for your passkey…" : "Add a passkey"}
      </Button>
      <div className="sm:col-span-2">
        <FormError error={add.error} />
      </div>
    </form>
  );
}
