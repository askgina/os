import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { EmptyState, ErrorState, FormError, Loading } from "@/components/common.tsx";
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
import { api, useAudit, useSignerDecisions } from "@/lib/api.ts";
import { explainCode } from "@/lib/codes.ts";
import { formatTime } from "@/lib/format.ts";
import { useWorkspaceId } from "@/routes/workspace.tsx";

export function ActivityPage() {
  const workspaceId = useWorkspaceId();

  return (
    <div className="grid grid-cols-1 gap-6">
      <AuditLog workspaceId={workspaceId} />
      <SignerDecisions workspaceId={workspaceId} />
    </div>
  );
}

function AuditLog({ workspaceId }: { workspaceId: string }) {
  const audit = useAudit(workspaceId);

  const verify = useMutation({
    mutationFn: () => api.call("verifyAudit", { params: { workspaceId } }),
  });

  const events = audit.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Activity log</CardTitle>
          <CardDescription>
            Every entry includes the fingerprint of the one before it, so a removed or edited entry
            breaks the chain.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => verify.mutate()}
          disabled={verify.isPending}
        >
          <ShieldCheck aria-hidden />
          {verify.isPending ? "Checking…" : "Verify log"}
        </Button>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <FormError error={verify.error} />
        {verify.data ? (
          verify.data.ok ? (
            <Alert tone="success">
              <CheckCircle2 aria-hidden />
              <p>
                The log is intact: all {verify.data.checked} entries follow from the one before.
              </p>
            </Alert>
          ) : (
            <Alert tone="danger">
              <XCircle aria-hidden />
              <p>
                The log is broken at entry {verify.data.brokenAt}: it does not follow from the entry
                before it. Entries may have been changed or removed.
              </p>
            </Alert>
          )
        ) : null}
        {audit.isPending ? <Loading /> : null}
        {audit.isError ? (
          <ErrorState error={audit.error} retry={() => void audit.refetch()} />
        ) : null}
        {audit.data && events.length === 0 ? (
          <EmptyState title="Nothing has happened yet." />
        ) : null}
        {events.length > 0 ? (
          <ol className="divide-y rounded-md border">
            {events.map((event) => (
              <li
                key={event.seq}
                className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[3rem_minmax(0,1fr)_auto] sm:gap-4"
              >
                <span className="font-mono text-xs text-muted-foreground">#{event.seq}</span>
                <div className="min-w-0">
                  <p className="font-mono text-sm">{event.action}</p>
                  <p className="text-xs text-muted-foreground">
                    {event.actor.type}
                    {event.actor.name ? `: ${event.actor.name}` : ""}
                    {event.subject ? ` · ${event.subject.type} ${event.subject.id}` : ""}
                  </p>
                </div>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={new Date(event.at * 1000).toISOString()}
                >
                  {formatTime(event.at)}
                </time>
              </li>
            ))}
          </ol>
        ) : null}
        {audit.hasNextPage ? (
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => void audit.fetchNextPage()}
            disabled={audit.isFetchingNextPage}
          >
            {audit.isFetchingNextPage ? "Loading…" : "Show older entries"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SignerDecisions({ workspaceId }: { workspaceId: string }) {
  const decisions = useSignerDecisions(workspaceId);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>The signer's own record</CardTitle>
          <CardDescription>
            Kept by the signer, separately from this server: everything it allowed or refused.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {decisions.isPending ? <Loading /> : null}
        {decisions.isError ? (
          <ErrorState error={decisions.error} retry={() => void decisions.refetch()} />
        ) : null}
        {decisions.data && decisions.data.items.length === 0 ? (
          <EmptyState title="The signer has decided nothing yet." />
        ) : null}
        {decisions.data && decisions.data.items.length > 0 ? (
          <ol className="divide-y rounded-md border">
            {[...decisions.data.items].reverse().map((decision) => (
              <li
                key={decision.seq}
                className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[3rem_minmax(0,1fr)_auto] sm:gap-4"
              >
                <span className="font-mono text-xs text-muted-foreground">#{decision.seq}</span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{decision.action}</span>
                    {decision.outcome === "allowed" ? (
                      <Badge tone="success">Allowed</Badge>
                    ) : (
                      <Badge tone="danger">Refused</Badge>
                    )}
                  </p>
                  {decision.code ? (
                    <p className="text-xs text-muted-foreground">
                      <code className="font-mono">{decision.code}</code>:{" "}
                      {explainCode(decision.code)}
                    </p>
                  ) : null}
                </div>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={new Date(decision.at * 1000).toISOString()}
                >
                  {formatTime(decision.at)}
                </time>
              </li>
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}
