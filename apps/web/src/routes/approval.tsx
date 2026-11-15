import type { ApprovalDetail, ApprovalSubject, WorkspaceDetail } from "@askgina/os-api";
import { canonicalJson } from "@askgina/os-protocol";
import { useMutation } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  KeyRound,
  OctagonAlert,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  ApprovalStatusBadge,
  backLinkClass,
  CopyButton,
  ErrorState,
  FormError,
  FullAddress,
  IntentStatusBadge,
  Loading,
  useNow,
} from "@/components/common.tsx";
import { PolicyDiff } from "@/components/policy.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { api, keys, queryClient, useApproval, useWallet, useWorkspace } from "@/lib/api.ts";
import { chainName } from "@/lib/assets.ts";
import { explainCode } from "@/lib/codes.ts";
import { formatCountdown, formatTime, formatUnits, percentOf, shortAddress } from "@/lib/format.ts";
import { signWithPasskey } from "@/lib/passkey.ts";
import { intentSentence, transactionSentence } from "@/lib/statuses.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The approval page is where money moves, so it shows what the signer will act on, in words a
 * person can check, before the passkey prompt. It lives outside the workspace frame so that on
 * a phone everything needed to decide fits on one screen.
 */
export function ApprovalPage() {
  const { workspaceId, approvalId } = useParams({ from: "/w/$workspaceId/approvals/$approvalId" });
  const approval = useApproval(approvalId);
  const workspace = useWorkspace(workspaceId);

  if (approval.isPending || workspace.isPending) return <Loading label="Loading the request" />;
  if (approval.isError) {
    return <ErrorState error={approval.error} retry={() => void approval.refetch()} />;
  }
  if (workspace.isError) {
    return <ErrorState error={workspace.error} retry={() => void workspace.refetch()} />;
  }
  return <ApprovalView approval={approval.data} workspace={workspace.data} />;
}

function ApprovalView({
  approval,
  workspace,
}: {
  approval: ApprovalDetail;
  workspace: WorkspaceDetail;
}) {
  const now = useNow();
  const secondsLeft = approval.expiresAt - now;
  const open = approval.status === "pending";
  return (
    <article className="mx-auto grid max-w-2xl gap-4 sm:gap-6" aria-labelledby="approval-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/w/$workspaceId/approvals"
          params={{ workspaceId: workspace.id }}
          className={backLinkClass}
        >
          ← {workspace.name}
        </Link>
        <ApprovalStatusBadge status={approval.status} />
      </div>

      <Subject approval={approval} workspace={workspace} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">
          {approval.approvals} of {approval.threshold} approvals
        </span>
        {open ? (
          <span className={cn("flex items-center gap-1", secondsLeft < 60 && "text-danger")}>
            <Clock className="size-4" aria-hidden />
            {secondsLeft > 0 ? `${formatCountdown(secondsLeft)} left to decide` : "Time is up"}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          Asked by {approval.requestedBy.type === "agent" ? "agent " : ""}
          {approval.requestedBy.name}
        </span>
      </div>

      {open ? (
        <Decide approval={approval} expired={secondsLeft <= 0} />
      ) : (
        <Outcome approval={approval} />
      )}

      {approval.approvedBy.length > 0 || approval.rejectedBy ? (
        <section className="grid gap-1 text-sm">
          {approval.approvedBy.length > 0 ? (
            <p>
              <span className="text-muted-foreground">Approved by: </span>
              {approval.approvedBy.map((user) => user.displayName).join(", ")}
            </p>
          ) : null}
          {approval.rejectedBy ? (
            <p>
              <span className="text-muted-foreground">Rejected by: </span>
              {approval.rejectedBy.displayName}
            </p>
          ) : null}
        </section>
      ) : null}

      <TechnicalDetails approval={approval} />
    </article>
  );
}

function Subject({
  approval,
  workspace,
}: {
  approval: ApprovalDetail;
  workspace: WorkspaceDetail;
}) {
  const subject = approval.subject;
  switch (subject.kind) {
    case "approve-intent":
      return <IntentSubject subject={subject} workspace={workspace} />;
    case "set-policy":
      return <PolicySubject subject={subject} workspace={workspace} />;
    case "add-approver":
      return (
        <Summary title={`Let ${subject.user.displayName} approve with a new passkey`}>
          <Facts>
            <Fact label="Person">{subject.user.displayName}</Fact>
            <Fact label="Passkey">{subject.passkeyLabel}</Fact>
            <Fact label="Passkey id">
              <code className="font-mono text-xs break-all">{subject.credentialId}</code>
            </Fact>
          </Facts>
          <p className="text-sm text-muted-foreground">
            Once approved, this passkey counts as {subject.user.displayName}'s approval for every
            payment and change in {workspace.name}.
          </p>
        </Summary>
      );
    case "remove-approver":
      return (
        <Summary title={`Stop ${subject.user.displayName}'s passkey from approving`}>
          <Facts>
            <Fact label="Person">{subject.user.displayName}</Fact>
            <Fact label="Passkey">{subject.passkeyLabel}</Fact>
            <Fact label="Passkey id">
              <code className="font-mono text-xs break-all">{subject.credentialId}</code>
            </Fact>
          </Facts>
        </Summary>
      );
    case "set-admin-threshold":
      return (
        <Summary
          title={`Change approvals needed for admin changes from ${subject.current} to ${subject.proposed}`}
        >
          <Facts>
            <Fact label="Now">{subject.current}</Fact>
            <Fact label="After">
              <strong>{subject.proposed}</strong>
            </Fact>
          </Facts>
          <p className="text-sm text-muted-foreground">
            This is how many people must approve changes to wallets' limits and to who approves.
          </p>
        </Summary>
      );
    case "resume-workspace":
      return (
        <Summary title={`Resume ${workspace.name}`}>
          <p className="text-sm">
            While paused, the signer refuses everything. Resuming lets its wallets sign again, each
            still only within its own limits and only with the approvals those limits ask for.
          </p>
        </Summary>
      );
    case "sweep-wallet":
      return <SweepSubject subject={subject} workspace={workspace} />;
  }
}

/** Where a sweep goes, in words: the signer refuses any destination other than these two. */
const sweepDestinationText = {
  treasury: "The workspace's treasury.",
  allowlist: "On this wallet's list of allowed recipients.",
} as const;

function SweepSubject({
  subject,
  workspace,
}: {
  subject: Extract<ApprovalSubject, { kind: "sweep-wallet" }>;
  workspace: WorkspaceDetail;
}) {
  const { sweep, wallet } = subject;
  const chain = workspace.chains.find((item) => item.chainId === sweep.chainId);
  const amount = formatUnits(sweep.amount, subject.assetDecimals);
  return (
    <Summary title={`Empty ${amount} ${subject.assetSymbol} to ${shortAddress(sweep.to)}`}>
      <Alert tone="warning" className="py-2.5">
        <TriangleAlert aria-hidden />
        <p>
          <strong>No limits apply.</strong> A sweep moves this whole amount in one transaction,
          without an agent and above the wallet's caps. It needs the approvals of an admin change.
        </p>
      </Alert>

      <div>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {amount} <span className="text-xl">{subject.assetSymbol}</span>
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {sweep.amount} base units ({subject.assetDecimals} decimals)
          {sweep.asset === "native" ? "" : ` · token ${shortAddress(sweep.asset)}`}
        </p>
      </div>

      <div>
        <p className="text-xs text-muted-foreground">Destination (check every group)</p>
        <FullAddress address={sweep.to} className="text-base" />
        {subject.destination ? (
          <p className="mt-1 text-sm">{sweepDestinationText[subject.destination]}</p>
        ) : (
          <Alert tone="danger" className="mt-2 py-2.5">
            <OctagonAlert aria-hidden />
            <p>
              This address is neither the treasury nor an allowed recipient of this wallet. The
              signer will refuse this sweep after it is approved.
            </p>
          </Alert>
        )}
      </div>

      <Facts>
        <Fact label="From wallet">
          {wallet.label} <span className="font-mono text-xs">{shortAddress(wallet.address)}</span>
        </Fact>
        <Fact label="Network">{chainName(sweep.chainId, workspace.chains)}</Fact>
        <Fact label="Network fee, at most">
          {formatUnits(sweep.maxFeeWei, 18)} {chain?.nativeSymbol ?? ""}
        </Fact>
        <Fact label="Agent">None: a person asked for this</Fact>
      </Facts>
    </Summary>
  );
}

function Summary({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4">
      <h1
        id="approval-title"
        className="text-xl font-semibold tracking-tight break-words sm:text-2xl"
      >
        {title}
      </h1>
      {children}
    </section>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:gap-y-3">{children}</dl>;
}

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function IntentSubject({
  subject,
  workspace,
}: {
  subject: Extract<ApprovalSubject, { kind: "approve-intent" }>;
  workspace: WorkspaceDetail;
}) {
  const { intent, wallet, limits } = subject;
  const display = intent.display;
  const chain = workspace.chains.find((item) => item.chainId === intent.chainId);
  const amount = `${display.amountFormatted} ${display.assetSymbol}`;
  const sentence = display.rawCall
    ? `Call contract ${shortAddress(display.to)}${display.amount === "0" ? "" : ` with ${amount}`}`
    : `Send ${amount} to ${shortAddress(display.to)}`;
  const fee = formatUnits(intent.intent.maxFeeWei, 18);
  return (
    <Summary title={sentence}>
      {display.rawCall ? (
        <Alert tone="danger" className="py-2.5">
          <OctagonAlert aria-hidden />
          <p>
            <strong>Raw contract call.</strong> The wallet's limits cannot measure what it does; it
            may move any asset the contract can reach. Approve only if you know this contract and
            this call.
          </p>
        </Alert>
      ) : null}

      <div>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {display.amountFormatted} <span className="text-xl">{display.assetSymbol}</span>
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {display.amount} base units ({display.assetDecimals} decimals)
          {display.token ? ` · token ${shortAddress(display.token)}` : ""}
        </p>
      </div>

      <div>
        <p className="text-xs text-muted-foreground">
          {display.rawCall ? "Contract" : "Recipient"} (check every group)
        </p>
        <FullAddress address={display.to} className="text-base" />
      </div>

      <Facts>
        <Fact label="From wallet">
          {wallet.label} <span className="font-mono text-xs">{shortAddress(wallet.address)}</span>
        </Fact>
        <Fact label="Requested by agent">{intent.agent.name}</Fact>
        <Fact label="Network">{chainName(intent.chainId, workspace.chains)}</Fact>
        <Fact label="Network fee, at most">
          {fee} {chain?.nativeSymbol ?? ""}
        </Fact>
        <Fact label="Simulation" wide>
          <Simulation simulation={intent.simulation} />
        </Fact>
      </Facts>

      <figure className="rounded-md border-l-4 border-muted-foreground/40 bg-muted px-3 py-2">
        <figcaption className="text-xs text-muted-foreground">
          The agent's own words, not checked by anyone:
        </figcaption>
        {/* Plain text only: React escapes it, and it is never parsed as HTML or Markdown. */}
        <blockquote className="text-sm break-words whitespace-pre-wrap">
          {intent.memo === "" ? (
            <span className="text-muted-foreground">(no memo)</span>
          ) : (
            intent.memo
          )}
        </blockquote>
      </figure>

      {limits ? (
        <Limits
          amount={display.amount}
          decimals={display.assetDecimals}
          symbol={display.assetSymbol}
          limits={limits}
        />
      ) : null}
    </Summary>
  );
}

function Simulation({
  simulation,
}: {
  simulation: Extract<ApprovalSubject, { kind: "approve-intent" }>["intent"]["simulation"];
}) {
  if (!simulation) return <span className="text-muted-foreground">Not run</span>;
  if (simulation.ok) {
    return (
      <span className="flex items-center gap-1 text-success">
        <CheckCircle2 className="size-4 shrink-0" aria-hidden />
        Would succeed (block {simulation.blockNumber})
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1 text-danger">
      <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>Would fail: {simulation.error ?? "the contract refused it"}</span>
    </span>
  );
}

function Limits({
  amount,
  decimals,
  symbol,
  limits,
}: {
  amount: string;
  decimals: number;
  symbol: string;
  limits: { maxPerTx: string; maxPerDay: string; spentToday: string };
}) {
  const afterToday = BigInt(limits.spentToday) + BigInt(amount);
  const units = (value: string | bigint) => `${formatUnits(value, decimals)} ${symbol}`;
  const txShare = percentOf(amount, limits.maxPerTx);
  const dayShare = percentOf(afterToday, limits.maxPerDay);
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-1">
        <div className="flex justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Of the per-transaction limit</span>
          <span className="tabular-nums">
            {units(amount)} of {units(limits.maxPerTx)}
          </span>
        </div>
        <Progress
          value={txShare}
          label="Share of the per-transaction limit"
          tone={txShare > 90 ? "warning" : "accent"}
        />
      </div>
      <div className="grid gap-1">
        <div className="flex justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Of the 24-hour limit, with this</span>
          <span className="tabular-nums">
            {units(afterToday)} of {units(limits.maxPerDay)}
          </span>
        </div>
        <Progress
          value={dayShare}
          label="Share of the 24-hour limit"
          tone={dayShare > 90 ? "warning" : "accent"}
        />
      </div>
    </div>
  );
}

function PolicySubject({
  subject,
  workspace,
}: {
  subject: Extract<ApprovalSubject, { kind: "set-policy" }>;
  workspace: WorkspaceDetail;
}) {
  const wallet = useWallet(workspace.id, subject.wallet.id);
  return (
    <Summary title={`Change the limits of ${subject.wallet.label}`}>
      <p className="text-sm">
        Wallet <FullAddress address={subject.wallet.address} className="text-xs" />
      </p>
      <PolicyDiff
        current={subject.current}
        proposed={subject.proposed}
        context={{
          chains: workspace.chains,
          agents: workspace.agents,
          balances: wallet.data?.balances ?? [],
        }}
      />
    </Summary>
  );
}

function Decide({ approval, expired }: { approval: ApprovalDetail; expired: boolean }) {
  const [confirmReject, setConfirmReject] = useState(false);
  const refresh = async (next: ApprovalDetail) => {
    queryClient.setQueryData(keys.approval(approval.id), next);
    await queryClient.invalidateQueries({ queryKey: ["approvals", approval.workspaceId] });
    await queryClient.invalidateQueries({ queryKey: keys.workspace(approval.workspaceId) });
  };
  const approve = useMutation({
    mutationFn: async () => {
      const params = { approvalId: approval.id };
      const { options } = await api.call("startApproval", { params, body: {} });
      const response = await signWithPasskey(options);
      return api.call("approve", { params, body: { response } });
    },
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: () => api.call("reject", { params: { approvalId: approval.id }, body: {} }),
    onSuccess: async (next) => {
      setConfirmReject(false);
      await refresh(next);
    },
  });
  const busy = approve.isPending || reject.isPending;

  if (!approval.canDecide) {
    return (
      <Alert>
        <KeyRound aria-hidden />
        <p>
          You cannot decide this request: you may have approved it already, or your passkey is not
          yet an approver in this workspace.
        </p>
      </Alert>
    );
  }
  return (
    <section className="grid gap-2" aria-label="Decision">
      <p className="text-xs text-muted-foreground">
        Approving lets the signer{" "}
        {approval.kind === "approve-intent" || approval.kind === "sweep-wallet"
          ? "sign exactly this operation"
          : "apply exactly this change"}{" "}
        once. Your passkey signs this request's fingerprint, nothing else.
      </p>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button size="lg" onClick={() => approve.mutate()} disabled={busy || expired}>
          <KeyRound aria-hidden />
          {approve.isPending ? "Waiting for your passkey…" : "Approve with passkey"}
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={() => setConfirmReject(true)}
          disabled={busy || expired}
        >
          <Ban aria-hidden />
          Reject
        </Button>
      </div>
      <FormError error={approve.error} />
      {approval.confirmUrl ? <ConfirmationLink url={approval.confirmUrl} /> : null}
      <Dialog
        open={confirmReject}
        onClose={() => setConfirmReject(false)}
        title="Reject this request?"
      >
        <p className="mt-2 text-sm text-muted-foreground">
          It ends at once for everyone and cannot be approved later. No passkey is needed to say no.
        </p>
        <FormError error={reject.error} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmReject(false)}>
            Keep it open
          </Button>
          <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}>
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

/**
 * The signer's own page for this request, on another origin. It shows the request as the signer
 * holds it, and an approval made there names that origin, which this page cannot fake. It opens
 * in this tab and comes back here when done; the copied link works on another device too.
 */
function ConfirmationLink({ url }: { url: string }) {
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <a
        href={url}
        rel="noopener noreferrer"
        // The label is long: it wraps on a narrow phone instead of widening the page.
        className={cn(
          buttonVariants({ variant: "outline", size: "lg" }),
          "h-auto min-h-12 w-full py-2 text-center whitespace-normal",
        )}
      >
        <ShieldCheck aria-hidden />
        Review and approve on the signer's page
      </a>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          It opens <span className="font-mono break-all text-foreground">{new URL(url).host}</span>.
          Check that your address bar shows it before you approve. To approve on another device,
          copy the link.
        </p>
        <CopyButton value={url} label="Copy link" />
      </div>
    </div>
  );
}

/** Where a decided request ended up, followed until it is final. */
function Outcome({ approval }: { approval: ApprovalDetail }) {
  const subject = approval.subject;
  const intent = subject.kind === "approve-intent" ? subject.intent : null;
  const transaction =
    intent?.transaction ?? (subject.kind === "sweep-wallet" ? subject.transaction : null);
  const signs = subject.kind === "approve-intent" || subject.kind === "sweep-wallet";
  switch (approval.status) {
    case "approved":
      return (
        <Alert tone="accent">
          <Loading label="Approved. Applying it now" />
        </Alert>
      );
    case "executed":
      return (
        <Alert tone="success" className="items-start">
          <CheckCircle2 aria-hidden />
          <div className="grid min-w-0 gap-1">
            <p className="font-medium">{signs ? "Approved." : "Done. The change is in effect."}</p>
            {intent ? (
              <div className="flex flex-wrap items-center gap-2">
                <IntentStatusBadge status={intent.status} />
                <span className="text-muted-foreground">{intentSentence[intent.status]}</span>
              </div>
            ) : null}
            {intent?.failureCode ? (
              <p className="text-muted-foreground">{explainCode(intent.failureCode)}</p>
            ) : null}
            {transaction && transaction.status !== intent?.status ? (
              <p className="text-muted-foreground">
                Transaction: {transactionSentence[transaction.status]}
              </p>
            ) : null}
            {transaction ? (
              transaction.explorerUrl ? (
                <a
                  href={transaction.explorerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-1 font-mono text-xs break-all text-accent underline-offset-4 hover:underline"
                >
                  {transaction.hash}
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                  <span className="sr-only">(opens the block explorer)</span>
                </a>
              ) : (
                <code className="font-mono text-xs break-all">{transaction.hash}</code>
              )
            ) : null}
          </div>
        </Alert>
      );
    case "failed":
      return (
        <Alert tone="danger" className="items-start">
          <TriangleAlert aria-hidden />
          <div>
            <p className="font-medium">
              Approved, but it did not go through
              {approval.failureCode ? (
                <>
                  {" "}
                  (<code className="font-mono text-xs">{approval.failureCode}</code>)
                </>
              ) : null}
              .
            </p>
            <p className="text-muted-foreground">
              {explainCode(approval.failureCode ?? "internal")} Nothing was signed with this
              approval.
            </p>
          </div>
        </Alert>
      );
    case "expired":
      return (
        <Alert>
          <Clock aria-hidden />
          <p>This request expired before enough people approved it. Nothing was signed.</p>
        </Alert>
      );
    case "rejected":
      return (
        <Alert>
          <Ban aria-hidden />
          <p>This request was rejected. Nothing was signed.</p>
        </Alert>
      );
    case "cancelled":
      return (
        <Alert>
          <Ban aria-hidden />
          <p>This request was withdrawn. Nothing was signed.</p>
        </Alert>
      );
    case "pending":
      return null;
  }
}

function TechnicalDetails({ approval }: { approval: ApprovalDetail }) {
  const intent = approval.subject.kind === "approve-intent" ? approval.subject.intent : null;
  const sweep = approval.subject.kind === "sweep-wallet" ? approval.subject : null;
  return (
    <details className="group rounded-lg border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
        Technical details
      </summary>
      <div className="grid gap-4 border-t px-4 py-4 text-xs">
        {intent ? (
          <>
            <TechBlock label="Intent hash (SHA-256)" value={intent.intentHash} />
            <TechBlock
              label="Canonical intent (exactly what is hashed)"
              value={canonicalJson(intent.intent)}
              pre
            />
          </>
        ) : null}
        {sweep ? (
          <>
            <TechBlock label="Sweep hash (SHA-256)" value={sweep.sweepHash} />
            <TechBlock
              label="Canonical sweep (exactly what is hashed)"
              value={canonicalJson(sweep.sweep)}
              pre
            />
          </>
        ) : null}
        <TechBlock
          label="Envelope (exactly what your passkey signs)"
          value={JSON.stringify(approval.envelope, null, 2)}
          pre
        />
        <TechBlock label="Passkey challenge (the envelope's digest)" value={approval.challenge} />
        <p className="text-muted-foreground">
          Requested {formatTime(approval.createdAt)} · expires {formatTime(approval.expiresAt)} · id{" "}
          <code className="font-mono">{approval.id}</code>
        </p>
      </div>
    </details>
  );
}

function TechBlock({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div className="grid gap-1">
      <p className="font-medium text-muted-foreground">{label}</p>
      {pre ? (
        <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono whitespace-pre-wrap break-all">
          {value}
        </pre>
      ) : (
        <code className="rounded-md bg-muted p-2 font-mono break-all">{value}</code>
      )}
    </div>
  );
}
