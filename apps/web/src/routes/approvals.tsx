import type { ApprovalSummary } from "@askgina/os-api";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Inbox } from "lucide-react";
import {
  ApprovalStatusBadge,
  EmptyState,
  ErrorState,
  Loading,
  useNow,
} from "@/components/common.tsx";
import { useApprovals } from "@/lib/api.ts";
import { formatCountdown, formatRelative } from "@/lib/format.ts";
import { useWorkspaceId } from "@/routes/workspace.tsx";

export function ApprovalsPage() {
  const workspaceId = useWorkspaceId();
  const pending = useApprovals(workspaceId, "pending");
  const all = useApprovals(workspaceId, "all");
  const now = useNow();
  const decided = all.data?.items.filter((item) => item.status !== "pending") ?? [];

  return (
    <div className="grid grid-cols-1 gap-8">
      <section aria-labelledby="pending-title" className="grid grid-cols-1 gap-3">
        <h2 id="pending-title" className="text-lg font-semibold">
          Waiting for approval
        </h2>
        {pending.isPending ? <Loading /> : null}
        {pending.isError ? (
          <ErrorState error={pending.error} retry={() => void pending.refetch()} />
        ) : null}
        {pending.data && pending.data.items.length === 0 ? (
          <EmptyState icon={<Inbox aria-hidden />} title="Nothing is waiting for you.">
            New requests from agents and members appear here on their own.
          </EmptyState>
        ) : null}
        {pending.data && pending.data.items.length > 0 ? (
          <ApprovalList workspaceId={workspaceId} items={pending.data.items} now={now} />
        ) : null}
      </section>
      <section aria-labelledby="history-title" className="grid grid-cols-1 gap-3">
        <h2 id="history-title" className="text-lg font-semibold">
          Decided
        </h2>
        {all.isError ? <ErrorState error={all.error} retry={() => void all.refetch()} /> : null}
        {all.data && decided.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions yet.</p>
        ) : null}
        {decided.length > 0 ? (
          <ApprovalList workspaceId={workspaceId} items={decided} now={now} />
        ) : null}
      </section>
    </div>
  );
}

function ApprovalList({
  workspaceId,
  items,
  now,
}: {
  workspaceId: string;
  items: ApprovalSummary[];
  now: number;
}) {
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to="/w/$workspaceId/approvals/$approvalId"
            params={{ workspaceId, approvalId: item.id }}
            className="flex items-center gap-3 px-4 py-3 hover:bg-muted"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium break-words">{item.title}</p>
              <p className="text-xs text-muted-foreground">
                {item.requestedBy.type === "agent" ? "Agent " : ""}
                {item.requestedBy.name} · {formatRelative(item.createdAt, now)}
                {item.status === "pending"
                  ? ` · ${item.approvals} of ${item.threshold} approvals · ${formatCountdown(item.expiresAt - now)} left`
                  : ""}
              </p>
            </div>
            <ApprovalStatusBadge status={item.status} />
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
