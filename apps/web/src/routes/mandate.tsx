import type { IntentSummary, MandateDetail, WorkspaceDetail } from "@askgina/os-api";
import { canonicalJson } from "@askgina/os-protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Ban, CalendarClock } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  Field,
  IntentStatusBadge,
  Loading,
  linkClass,
  PageHeader,
  TechBlock,
  useNow,
} from "@/components/common.tsx";
import {
  MandateLimits,
  MandateRecipients,
  MandateSentence,
  MandateStatusBadge,
  MandateTime,
  MandateUsage,
  MandateWorstCase,
  mandateAssetInfos,
  RevokeMandateButton,
} from "@/components/mandate.tsx";
import { IntentLink } from "@/components/transaction.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { api, keys, useMandate, useWorkspace } from "@/lib/api.ts";
import { explainCode } from "@/lib/codes.ts";
import { formatRelative, formatTime, formatUnits, shortAddress } from "@/lib/format.ts";
import { formatWindow } from "@/lib/mandate.ts";
import { intentStatusSentence } from "@/lib/statuses.ts";

/**
 * One approval in advance (a mandate): what it allows, what the signer counted under it, the
 * payments it covered, and, for anyone who can approve, Revoke. An ended one says why.
 */
export function MandatePage() {
  const { workspaceId, mandateId } = useParams({ from: "/w/$workspaceId/mandates/$mandateId" });
  const workspace = useWorkspace(workspaceId);
  const mandate = useMandate(workspaceId, mandateId);
  if (mandate.isPending || !workspace.data) return <Loading label="Loading the approval" />;
  if (mandate.isError) {
    return <ErrorState error={mandate.error} retry={() => void mandate.refetch()} />;
  }
  return <MandateView detail={mandate.data} workspace={workspace.data} />;
}

function MandateView({ detail, workspace }: { detail: MandateDetail; workspace: WorkspaceDetail }) {
  const now = useNow();
  const { mandate } = detail;
  const wallet = workspace.wallets.find((item) => item.id === detail.walletId);
  const infos = mandateAssetInfos(mandate, workspace.chains, detail.assets);
  const live = detail.endedReason === null;
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title={`Approved in advance for ${detail.agent.name}`}
        back={
          wallet ? (
            <Link
              to="/w/$workspaceId/wallets/$walletId"
              params={{ workspaceId: workspace.id, walletId: wallet.id }}
              className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              ← {wallet.label}
            </Link>
          ) : null
        }
        description={
          <>
            Granted {formatTime(detail.grantedAt)} by{" "}
            {detail.grantedBy.map((user) => user.displayName).join(", ") || "its approvers"}.{" "}
            <Link
              to="/w/$workspaceId/approvals/$approvalId"
              params={{ workspaceId: workspace.id, approvalId: detail.grantApprovalId }}
              className={linkClass}
            >
              The request they approved
            </Link>
          </>
        }
        actions={
          <>
            <MandateStatusBadge status={detail.status} />
            {live && workspace.role !== "viewer" ? <RevokeMandateButton summary={detail} /> : null}
          </>
        }
      />

      {live ? (
        <Alert tone="accent" className="items-start">
          <CalendarClock aria-hidden />
          <p>
            {detail.agent.name}'s payments that fit are signed with nobody asked.{" "}
            <MandateTime summary={detail} now={now} />. Anything else waits in the inbox as usual.
          </p>
        </Alert>
      ) : (
        <Alert className="items-start">
          <Ban aria-hidden />
          <p>
            <MandateTime summary={detail} now={now} /> Nothing more is signed under it.
          </p>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What it allows</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          <MandateSentence terms={mandate} agent={detail.agent.name} infos={infos} />
          <MandateWorstCase terms={mandate} infos={infos} chains={workspace.chains} />
          <MandateRecipients recipients={mandate.recipients} />
          <MandateLimits
            terms={mandate}
            infos={infos}
            chains={workspace.chains}
            views={detail.assets}
          />
          <dl className="grid grid-cols-1 gap-3">
            <Field label="From wallet">
              {wallet?.label ?? detail.walletId}{" "}
              {wallet ? (
                <span className="font-mono text-xs">{shortAddress(wallet.address)}</span>
              ) : null}
            </Field>
            <Field label="Window">Any {formatWindow(mandate.windowSeconds)}</Field>
            <Field label="Network fee per payment, at most">
              {formatUnits(mandate.maxFeePerActionWei, 18)} of the native coin
            </Field>
            <Field label="Purpose, in the words of who asked">
              <span className="whitespace-pre-wrap wrap-anywhere">
                {mandate.purpose === "" ? (
                  <span className="text-muted-foreground">(none given)</span>
                ) : (
                  mandate.purpose
                )}
              </span>
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Used so far</CardTitle>
        </CardHeader>
        <CardContent>
          <MandateUsage summary={detail} infos={infos} />
        </CardContent>
      </Card>

      <Payments detail={detail} workspaceId={workspace.id} now={now} />

      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
          Technical details
        </summary>
        <div className="grid grid-cols-1 gap-4 border-t px-4 py-4 text-xs">
          <TechBlock label="Mandate hash (SHA-256)" value={detail.mandateHash} />
          <TechBlock
            label="Canonical mandate (exactly what is hashed and what the signer enforces)"
            value={canonicalJson(mandate)}
            pre
          />
          <p className="text-muted-foreground">
            id <code className="font-mono break-all">{detail.id}</code>
          </p>
        </div>
      </details>
    </div>
  );
}

/** The payments signed under it, newest first, with older pages on request. */
function Payments({
  detail,
  workspaceId,
  now,
}: {
  detail: MandateDetail;
  workspaceId: string;
  now: number;
}) {
  const older = useInfiniteQuery({
    queryKey: keys.mandatePayments(workspaceId, detail.id),
    initialPageParam: detail.intentsCursor ?? undefined,
    queryFn: ({ pageParam }) =>
      api.call("listIntents", {
        params: { workspaceId },
        query: { mandateId: detail.id, cursor: pageParam },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: false,
  });
  // The first page refreshes while payments come in, so an older page may repeat one of its rows.
  const shown = new Set(detail.intents.map((intent) => intent.id));
  const more = (older.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (intent) => !shown.has(intent.id),
  );
  const canLoad = older.data ? older.hasNextPage : detail.intentsCursor !== null;
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Payments under it</CardTitle>
          <CardDescription>Signed without asking anyone, newest first.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        {detail.intents.length === 0 ? (
          <EmptyState title="No payment was made under it yet." />
        ) : (
          <ul className="divide-y rounded-md border">
            {[...detail.intents, ...more].map((intent) => (
              <Payment key={intent.id} intent={intent} workspaceId={workspaceId} now={now} />
            ))}
          </ul>
        )}
        {canLoad ? (
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => void (older.data ? older.fetchNextPage() : older.refetch())}
            disabled={older.isFetching}
          >
            {older.isFetching ? "Loading…" : "Show older payments"}
          </Button>
        ) : null}
        {older.isError ? <ErrorState error={older.error} /> : null}
      </CardContent>
    </Card>
  );
}

/** One payment under it; its own page has the transaction, and Speed up and Cancel. */
function Payment({
  intent,
  workspaceId,
  now,
}: {
  intent: IntentSummary;
  workspaceId: string;
  now: number;
}) {
  return (
    <li className="grid grid-cols-1 gap-1 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <IntentLink
          workspaceId={workspaceId}
          intent={intent}
          className="min-w-0 font-medium wrap-anywhere underline-offset-4 hover:underline"
        >
          {intent.display.title}
          {/* A mandate covers transfers only; an order never runs under one. */}
          {intent.display.kind === "transfer" ? (
            <>
              {" "}
              to <span className="font-mono text-sm">{shortAddress(intent.display.to)}</span>
            </>
          ) : null}
        </IntentLink>
        <IntentStatusBadge status={intent.status} />
      </div>
      <p className="text-xs text-muted-foreground">
        {formatRelative(intent.createdAt, now)} · {intentStatusSentence(intent.status, true)}
      </p>
      {intent.failureCode ? (
        <p className="text-xs text-muted-foreground">{explainCode(intent.failureCode)}</p>
      ) : null}
      {intent.transactionHash ? (
        <code className="font-mono text-xs break-all text-muted-foreground">
          {intent.transactionHash}
        </code>
      ) : null}
    </li>
  );
}
