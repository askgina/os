import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Check, Link2, ShieldAlert, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ErrorState, FormError, Loading } from "@/components/common.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input, Select } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { api, keys, queryClient, useWorkspaces } from "@/lib/api.ts";
import { cn } from "@/lib/utils.ts";

const pairingKey = (pairingId: string) => ["pairing", pairingId] as const;

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto mt-6 max-w-md sm:mt-16">{children}</div>;
}

/**
 * Where an agent's pairing link opens: the person checks the agent's code against this one and
 * allows it. Allowing creates a new agent with its own new wallet in the chosen workspace; the
 * agent collects its token by itself, so nothing is copied.
 */
export function PairPage() {
  const { pairingId } = useParams({ from: "/pair/$pairingId" });

  const pairing = useQuery({
    queryKey: pairingKey(pairingId),
    queryFn: () => api.call("getPairing", { params: { pairingId } }),
    // The agent's own screen changes as soon as it collects; this page follows.
    refetchInterval: (query) => (query.state.data?.status === "approved" ? 2000 : false),
  });

  if (pairing.isPending) return <Loading />;

  if (pairing.isError) {
    return <ErrorState error={pairing.error} retry={() => void pairing.refetch()} />;
  }

  const { clientName, userCode, status, workspaceId, walletId } = pairing.data;

  if (status === "approved" || status === "claimed") {
    return (
      <Connected
        clientName={clientName}
        waiting={status === "approved"}
        workspaceId={workspaceId}
        walletId={walletId}
      />
    );
  }

  if (status !== "pending") {
    return (
      <Centered>
        <Card>
          <CardHeader className="flex-col items-stretch">
            <CardTitle className="text-xl">
              {status === "denied" ? "Not connected" : "This link has expired"}
            </CardTitle>
            <CardDescription>
              {status === "denied"
                ? `You chose not to connect ${clientName}.`
                : `Start again from ${clientName}: it shows a new code.`}
            </CardDescription>
          </CardHeader>
        </Card>
      </Centered>
    );
  }

  return <Ask pairingId={pairingId} clientName={clientName} userCode={userCode} />;
}

function Ask({
  pairingId,
  clientName,
  userCode,
}: {
  pairingId: string;
  clientName: string;
  userCode: string;
}) {
  const workspaces = useWorkspaces();

  const owned = (workspaces.data?.items ?? []).filter(
    (workspace) => workspace.role === "owner" && workspace.lifecycle.state === "active",
  );

  const [workspaceId, setWorkspaceId] = useState("");
  const [newWorkspace, setNewWorkspace] = useState("Personal");
  const [name, setName] = useState(clientName);

  useEffect(() => {
    if (workspaceId === "" && owned[0]) setWorkspaceId(owned[0].id);
  }, [owned, workspaceId]);

  const done = () => queryClient.invalidateQueries({ queryKey: pairingKey(pairingId) });

  const allow = useMutation({
    mutationFn: async () => {
      // No workspace of their own yet: make one, so allowing stays a single step.
      const target =
        owned.length > 0
          ? workspaceId
          : (await api.call("createWorkspace", { body: { name: newWorkspace } })).id;

      return api.call("approvePairing", {
        params: { pairingId },
        body: { workspaceId: target, name },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      await done();
    },
  });

  const deny = useMutation({
    mutationFn: () => api.call("denyPairing", { params: { pairingId }, body: {} }),
    onSuccess: done,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    allow.mutate();
  };

  return (
    <Centered>
      <Card>
        <CardHeader className="flex-col items-stretch">
          <CardTitle className="flex items-center gap-2 text-xl">
            <Link2 className="size-5" aria-hidden />
            Connect {clientName}
          </CardTitle>
          <CardDescription>Check this code matches the one on your computer.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 gap-5">
            <p className="rounded-lg border bg-muted py-4 text-center font-mono text-3xl font-semibold tracking-[0.2em]">
              {userCode}
            </p>
            <Alert tone="warning">
              <ShieldAlert aria-hidden />
              Only allow this if you started it yourself, on your own computer.
            </Alert>
            {workspaces.isPending ? <Loading /> : null}
            {owned.length > 1 ? (
              <div className="grid grid-cols-1 gap-2">
                <Label htmlFor="pair-workspace">Workspace</Label>
                <Select
                  id="pair-workspace"
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {owned.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {workspaces.data && owned.length === 0 ? (
              <div className="grid grid-cols-1 gap-2">
                <Label htmlFor="pair-new-workspace">New workspace</Label>
                <Input
                  id="pair-new-workspace"
                  value={newWorkspace}
                  onChange={(event) => setNewWorkspace(event.target.value)}
                  required
                  maxLength={64}
                />
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="pair-name">Name</Label>
              <Input
                id="pair-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={64}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {clientName} gets its own new wallet. It can't pay anything until you set its limits.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={deny.isPending || allow.isPending}
                onClick={() => deny.mutate()}
              >
                <X aria-hidden />
                Don't allow
              </Button>
              <Button
                type="submit"
                disabled={allow.isPending || deny.isPending || !workspaces.data}
              >
                <Check aria-hidden />
                {allow.isPending ? "Connecting…" : "Allow"}
              </Button>
            </div>
            <FormError error={allow.error ?? deny.error} />
          </form>
        </CardContent>
      </Card>
    </Centered>
  );
}

function Connected({
  clientName,
  waiting,
  workspaceId,
  walletId,
}: {
  clientName: string;
  waiting: boolean;
  workspaceId: string | null;
  walletId: string | null;
}) {
  return (
    <Centered>
      <Card>
        <CardHeader className="flex-col items-stretch">
          <CardTitle className="flex items-center gap-2 text-xl">
            <Check className="size-5 text-success" aria-hidden />
            {waiting ? `Connecting ${clientName}…` : `${clientName} is connected`}
          </CardTitle>
          <CardDescription>
            It has its own new wallet with no limits, so it can't pay anything yet. Set how much it
            may spend; you approve that with your passkey.
          </CardDescription>
        </CardHeader>
        {workspaceId && walletId ? (
          <CardContent>
            <Link
              to="/w/$workspaceId/wallets/$walletId"
              params={{ workspaceId, walletId }}
              className={cn(buttonVariants(), "w-full")}
            >
              Set spending limits
            </Link>
          </CardContent>
        ) : null}
      </Card>
    </Centered>
  );
}
