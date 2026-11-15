import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Building2, ChevronRight, Pause, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, FormError, Loading, PageHeader } from "@/components/common.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { api, keys, queryClient, useWorkspaces } from "@/lib/api.ts";

const ROLE_NAMES = { owner: "Owner", approver: "Approver", viewer: "Viewer" } as const;

export function WorkspacesPage() {
  const workspaces = useWorkspaces();
  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Each workspace has its own agents, wallets, limits and approvers."
      />
      {workspaces.isPending ? <Loading /> : null}
      {workspaces.isError ? (
        <ErrorState error={workspaces.error} retry={() => void workspaces.refetch()} />
      ) : null}
      {workspaces.data ? (
        <div className="grid grid-cols-1 gap-6">
          {workspaces.data.items.length === 0 ? (
            <EmptyState icon={<Building2 aria-hidden />} title="No workspaces yet">
              Create one below. You will then add an agent, which gets its own wallet, and set that
              wallet's limits.
            </EmptyState>
          ) : (
            <ul className="grid grid-cols-1 gap-3">
              {workspaces.data.items.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    to="/w/$workspaceId"
                    params={{ workspaceId: workspace.id }}
                    className="flex items-center gap-4 rounded-lg border bg-card px-5 py-4 hover:bg-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{workspace.name}</p>
                      <p className="text-sm text-muted-foreground">{ROLE_NAMES[workspace.role]}</p>
                    </div>
                    {workspace.lifecycle.state === "deleting" ? (
                      <Badge tone="danger">
                        <Trash2 aria-hidden />
                        Being deleted
                      </Badge>
                    ) : workspace.paused ? (
                      <Badge tone="danger">
                        <Pause aria-hidden />
                        Paused
                      </Badge>
                    ) : null}
                    {workspace.pendingApprovals > 0 ? (
                      <Badge tone="warning">
                        {workspace.pendingApprovals} waiting for approval
                      </Badge>
                    ) : (
                      <span className="hidden text-sm text-muted-foreground sm:inline">
                        Nothing waiting
                      </span>
                    )}
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <CreateWorkspace />
        </div>
      ) : null}
    </>
  );
}

function CreateWorkspace() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.call("createWorkspace", { body: { name } }),
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: keys.workspaces });
      queryClient.setQueryData(keys.workspace(workspace.id), workspace);
      await navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace.id } });
    },
  });
  return (
    <Card>
      <CardContent>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="workspace-name">New workspace</Label>
            <Input
              id="workspace-name"
              placeholder="For example: Research team"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={64}
            />
          </div>
          <Button type="submit" disabled={create.isPending}>
            <Plus aria-hidden />
            {create.isPending ? "Creating…" : "Create workspace"}
          </Button>
          <div className="sm:col-span-2">
            <FormError error={create.error} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
