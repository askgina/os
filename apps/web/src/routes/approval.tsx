import type {
  ApprovalDetail,
  ApprovalSubject,
  TransactionInfo,
  WalletSummary,
  WorkspaceDetail,
} from "@askgina/os-api";
import { canonicalJson, keyFingerprint } from "@askgina/os-protocol";
import { useMutation } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  Ban,
  CheckCircle2,
  Clock,
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
  linkClass,
  TechBlock,
  useNow,
} from "@/components/common.tsx";
import { BALANCES_NOTE, WalletAtRisk } from "@/components/lifecycle.tsx";
import {
  MandateLimits,
  MandateRecipients,
  MandateSentence,
  MandateWorstCase,
  mandateAssetInfos,
} from "@/components/mandate.tsx";
import { PolicyDiff } from "@/components/policy.tsx";
import { IntentLink, TransactionPanel, type TransactionTarget } from "@/components/transaction.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import {
  api,
  keys,
  queryClient,
  useApproval,
  useSession,
  useWallet,
  useWorkspace,
} from "@/lib/api.ts";
import { chainName } from "@/lib/assets.ts";
import { explainCode, explainMandateRefusal } from "@/lib/codes.ts";
import { formatCountdown, formatTime, formatUnits, percentOf, shortAddress } from "@/lib/format.ts";
import { formatEndTime, formatTimeLeft, formatWindow } from "@/lib/mandate.ts";
import { intentSentence, transactionSentence } from "@/lib/statuses.ts";
import { paymentTitle, transactionOpen } from "@/lib/transaction.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The approval page is where a person reads what an agent or a member asked for, in words they
 * can check, and goes to the signer's own page to approve it. It lives outside the workspace
 * frame so that on a phone everything needed to decide fits on one screen.
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
    <article
      className="mx-auto grid max-w-2xl grid-cols-1 gap-4 sm:gap-6"
      aria-labelledby="approval-title"
    >
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

      <SentTransaction approval={approval} workspace={workspace} />

      <WalletsToDestroy approval={approval} workspace={workspace} />

      {approval.approvedBy.length > 0 || approval.rejectedBy ? (
        <section className="grid grid-cols-1 gap-1 text-sm">
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
    case "add-approver": {
      const fingerprint = newKeyFingerprint(approval);
      return (
        <Summary title={`Let ${subject.user.displayName} approve with a new passkey`}>
          <Facts>
            <Fact label="Person">{subject.user.displayName}</Fact>
            <Fact label="Passkey">{subject.passkeyLabel}</Fact>
            {fingerprint ? (
              <Fact label="Key fingerprint" wide>
                <code className="font-mono font-semibold">{fingerprint}</code>
              </Fact>
            ) : null}
            <Fact label="Passkey id" wide>
              <code className="font-mono text-xs break-all">{subject.credentialId}</code>
            </Fact>
          </Facts>
          <p className="text-sm text-muted-foreground">
            Once approved, this passkey counts as {subject.user.displayName}'s approval for every
            payment and change in {workspace.name}.
          </p>
        </Summary>
      );
    }
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
    case "grant-mandate":
      return <MandateSubject approval={approval} subject={subject} workspace={workspace} />;
    case "cancel-transaction":
      return <CancelSubject approval={approval} subject={subject} workspace={workspace} />;
    case "retire-wallet":
    case "delete-workspace":
      return <DestroySubject approval={approval} subject={subject} />;
  }
}

type DestroySubjectData = Extract<ApprovalSubject, { kind: "retire-wallet" | "delete-workspace" }>;

/**
 * A request to retire a wallet or delete the workspace: what is destroyed, and when. Short, so
 * the link to the signer's page stays on a phone's first screen; the wallets and what the server
 * reads in them follow below the decision.
 */
function DestroySubject({
  approval,
  subject,
}: {
  approval: ApprovalDetail;
  subject: DestroySubjectData;
}) {
  const wallets = subject.kind === "retire-wallet" ? [subject.wallet] : subject.wallets;
  const retire = subject.kind === "retire-wallet";
  return (
    <Summary title={approval.title}>
      <Alert tone="danger" className="py-2.5">
        <OctagonAlert aria-hidden />
        <p>
          <strong>
            {retire ? "Its key is destroyed" : "Every key is destroyed"} after the delay.
          </strong>{" "}
          Whatever is still in {retire ? "the wallet" : "the wallets"} then is lost for good, and
          the signer cannot see balances. Until then it can be cancelled.
        </p>
      </Alert>
      <Facts>
        <Fact label={retire ? "Wallet" : "Wallet keys"}>
          {retire ? (
            <>
              {subject.wallet.label}{" "}
              <span className="font-mono text-xs">{shortAddress(subject.wallet.address)}</span>
            </>
          ) : (
            wallets.length
          )}
        </Fact>
        <Fact label="Time to cancel">
          {/* Rounded down: the request adds a few minutes to the delay picked. */}
          {formatTimeLeft(subject.destroyAfter - approval.createdAt)} from the request
        </Fact>
        <Fact label={retire ? "Key destroyed after" : "Keys destroyed after"} wide>
          {formatEndTime(subject.destroyAfter)}
        </Fact>
      </Facts>
    </Summary>
  );
}

/** The wallets a retirement or deletion destroys the keys of, with what the server reads in them. */
function WalletsToDestroy({
  approval,
  workspace,
}: {
  approval: ApprovalDetail;
  workspace: WorkspaceDetail;
}) {
  const subject = approval.subject;
  if (subject.kind !== "retire-wallet" && subject.kind !== "delete-workspace") return null;
  const wallets = subject.kind === "retire-wallet" ? [subject.wallet] : subject.wallets;
  return (
    <section className="grid grid-cols-1 gap-2" aria-labelledby="wallets-to-destroy">
      <h2 id="wallets-to-destroy" className="text-sm font-medium">
        {wallets.length === 1 ? "Still in the wallet" : "Still in the wallets"}
      </h2>
      {wallets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The workspace has no wallet keys: only its data is lost.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {wallets.map((wallet) => (
            <WalletBalances key={wallet.id} workspace={workspace} wallet={wallet} />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{BALANCES_NOTE}</p>
    </section>
  );
}

function WalletBalances({
  workspace,
  wallet,
}: {
  workspace: WorkspaceDetail;
  wallet: WalletSummary;
}) {
  const detail = useWallet(workspace.id, wallet.id);
  return (
    <WalletAtRisk
      wallet={wallet}
      balances={detail.isError ? null : detail.data?.balances}
      chains={workspace.chains}
    />
  );
}

type CancelTransactionSubject = Extract<ApprovalSubject, { kind: "cancel-transaction" }>;

/** The network a cancel request is for: its envelope names it; a payment's intent does too. */
function cancelChainId(approval: ApprovalDetail, subject: CancelTransactionSubject): string | null {
  if (approval.envelope.type === "cancel-transaction") return approval.envelope.chainId;
  return subject.intent?.chainId ?? null;
}

/**
 * A request to cancel a sent payment or sweep: what it would stop, and that it is an attempt, not
 * a guarantee. Short on purpose, so the link to the signer's page stays on a phone's first
 * screen; the attempts so far are listed below it.
 */
function CancelSubject({
  approval,
  subject,
  workspace,
}: {
  approval: ApprovalDetail;
  subject: CancelTransactionSubject;
  workspace: WorkspaceDetail;
}) {
  const { intent, sweep, wallet } = subject;
  const what = intent ? "payment" : "sweep";
  const stops = intent ? paymentTitle(intent.display) : (sweep?.title ?? "");
  const chainId = cancelChainId(approval, subject);
  const chain = workspace.chains.find((item) => item.chainId === chainId);
  return (
    <Summary title={`Cancel ${what}: ${stops}`}>
      <Alert tone="warning" className="items-start py-2.5">
        <TriangleAlert aria-hidden />
        <p>
          <strong>An attempt, not a guarantee.</strong> It takes the {what}'s place only if the
          network includes it first. If the network includes the {what} first, the {what} goes
          through as sent.
        </p>
      </Alert>
      <Facts>
        <Fact label="It would stop" wide>
          {intent ? (
            <IntentLink workspaceId={workspace.id} intent={intent} className={linkClass}>
              {stops}
            </IntentLink>
          ) : sweep ? (
            <Link
              to="/w/$workspaceId/approvals/$approvalId"
              params={{ workspaceId: workspace.id, approvalId: sweep.approvalId }}
              className={linkClass}
            >
              {stops}
            </Link>
          ) : null}
        </Fact>
        <Fact label="From wallet">
          {wallet.label} <span className="font-mono text-xs">{shortAddress(wallet.address)}</span>
        </Fact>
        <Fact label="Network">{chainId ? chainName(chainId, workspace.chains) : "Unknown"}</Fact>
        <Fact label="Network fee, at most">
          {formatUnits(subject.maxFeeWei, 18)} {chain?.nativeSymbol ?? ""}
        </Fact>
        <Fact label="Attempts so far">{subject.transaction.attempts.length}</Fact>
      </Facts>
      <p className="text-sm">
        If it wins, nothing moves: the wallet sends nothing to itself at the {what}'s place in line
        (account nonce {subject.txNonce}) and pays only the network fee.
        {intent ? " The payment still counts toward the wallet's 24-hour limit." : ""}
      </p>
    </Summary>
  );
}

/**
 * The transaction a request signed, or, for a cancel request, the one it would stop, with every
 * attempt. Owners and approvers can speed up a payment or cancel a payment or a sweep here.
 */
function SentTransaction({
  approval,
  workspace,
}: {
  approval: ApprovalDetail;
  workspace: WorkspaceDetail;
}) {
  const subject = approval.subject;
  let shown: {
    transaction: TransactionInfo;
    chainId: string | null;
    target?: TransactionTarget;
  } | null = null;
  if (subject.kind === "approve-intent" && subject.intent.transaction) {
    shown = {
      transaction: subject.intent.transaction,
      chainId: subject.intent.chainId,
      target: { kind: "payment", intentId: subject.intent.id, approvalId: approval.id },
    };
  } else if (subject.kind === "sweep-wallet" && subject.transaction) {
    shown = {
      transaction: subject.transaction,
      chainId: subject.sweep.chainId,
      target: { kind: "sweep", approvalId: approval.id },
    };
  } else if (subject.kind === "cancel-transaction") {
    shown = { transaction: subject.transaction, chainId: cancelChainId(approval, subject) };
  }
  if (!shown) return null;
  const chainId = shown.chainId;
  const chain = workspace.chains.find((item) => item.chainId === chainId);
  return (
    <TransactionPanel
      transaction={shown.transaction}
      workspaceId={workspace.id}
      nativeSymbol={chain?.nativeSymbol ?? "native coin"}
      role={workspace.role}
      target={shown.target}
    />
  );
}

/**
 * A request to approve payments in advance: the mandate in one sentence, its worst case set
 * apart, every recipient in full, the agent, the wallet, the window and the end time in the
 * viewer's own time zone, the caps next to the wallet's own limits, and the purpose as the asker
 * wrote it.
 */
function MandateSubject({
  approval,
  subject,
  workspace,
}: {
  approval: ApprovalDetail;
  subject: Extract<ApprovalSubject, { kind: "grant-mandate" }>;
  workspace: WorkspaceDetail;
}) {
  const now = useNow();
  const { mandate, wallet, agent } = subject;
  const infos = mandateAssetInfos(mandate, workspace.chains, subject.assets);
  const left = mandate.notAfter - now;
  return (
    <Summary title={`Let ${agent.name} pay from ${wallet.label} without asking`}>
      <MandateSentence terms={mandate} agent={agent.name} infos={infos} />
      <MandateWorstCase terms={mandate} infos={infos} chains={workspace.chains} />
      <MandateRecipients recipients={mandate.recipients} />
      <Facts>
        <Fact label="Agent that may pay">{agent.name}</Fact>
        <Fact label="From wallet">
          {wallet.label} <span className="font-mono text-xs">{shortAddress(wallet.address)}</span>
        </Fact>
        <Fact label="Payments, at most">{mandate.maxUses}</Fact>
        <Fact label="Window">Any {formatWindow(mandate.windowSeconds)}</Fact>
        <Fact label="Ends" wide>
          {formatEndTime(mandate.notAfter)}
          {left > 0 ? `, in ${formatTimeLeft(left)}` : ", already passed"}
        </Fact>
      </Facts>
      <MandateLimits
        terms={mandate}
        infos={infos}
        chains={workspace.chains}
        views={subject.assets}
      />
      <figure className="rounded-md border-l-4 border-muted-foreground/40 bg-muted px-3 py-2">
        <figcaption className="text-xs text-muted-foreground">
          {approval.requestedBy.name}'s purpose, in their own words:
        </figcaption>
        <blockquote className="text-sm whitespace-pre-wrap wrap-anywhere">
          {mandate.purpose === "" ? (
            <span className="text-muted-foreground">(none given)</span>
          ) : (
            mandate.purpose
          )}
        </blockquote>
      </figure>
      <p className="text-sm">
        Each payment is signed without asking you again. Anything outside these limits comes to your
        inbox as usual. Anyone who can approve can stop this at any time from the wallet page.
      </p>
    </Summary>
  );
}

/**
 * The fingerprint of the key an approver change adds, from the envelope a passkey would sign. The
 * signer's page shows the same one, read from its own copy of the envelope.
 */
function newKeyFingerprint(approval: ApprovalDetail): string | null {
  return approval.envelope.type === "add-approver"
    ? keyFingerprint(approval.envelope.publicKey)
    : null;
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
        <p className="text-3xl font-semibold tracking-tight tabular-nums wrap-anywhere">
          {amount} <span className="text-xl">{subject.assetSymbol}</span>
        </p>
        <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
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
    <section className="grid grid-cols-1 gap-4">
      <h1
        id="approval-title"
        className="text-xl font-semibold tracking-tight wrap-anywhere sm:text-2xl"
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
      <dd className="text-sm wrap-anywhere">{children}</dd>
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
  const fee = formatUnits(intent.intent.maxFeeWei, 18);
  return (
    <Summary title={paymentTitle(display)}>
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
        <p className="text-3xl font-semibold tracking-tight tabular-nums wrap-anywhere">
          {display.amountFormatted} <span className="text-xl">{display.assetSymbol}</span>
        </p>
        <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
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
        <blockquote className="text-sm whitespace-pre-wrap wrap-anywhere">
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
    <div className="grid grid-cols-1 gap-2.5">
      <div className="grid grid-cols-1 gap-1">
        <div className="flex flex-wrap justify-between gap-x-2 text-xs">
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
      <div className="grid grid-cols-1 gap-1">
        <div className="flex flex-wrap justify-between gap-x-2 text-xs">
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

/**
 * What the person can do while the request waits. A request is approved only on the signer's own
 * page, on another origin, which shows the request as the signer holds it; an approval made there
 * names that origin, which this page cannot fake. This page links there and keeps reading the
 * request, so the count and the outcome appear here once the signer has collected them.
 *
 * An approver change has one more step on the signer's page, for the person it adds, so they get
 * the link too, even though they cannot decide.
 */
function Decide({ approval, expired }: { approval: ApprovalDetail; expired: boolean }) {
  const session = useSession();
  const userId = session.data?.user?.id;
  const subject = approval.subject;
  const beingAdded = subject.kind === "add-approver" && subject.user.id === userId ? subject : null;

  if (approval.approvedBy.some((user) => user.id === userId)) {
    const missing = approval.threshold - approval.approvals;
    return (
      <Alert tone="accent">
        <CheckCircle2 aria-hidden />
        <p>
          You approved this request. It waits for {missing} more{" "}
          {missing === 1 ? "approval" : "approvals"} from other approvers. This page updates when
          they come in.
        </p>
      </Alert>
    );
  }
  if (!approval.canDecide) {
    if (beingAdded) {
      return <ProvePasskey approval={approval} subject={beingAdded} expired={expired} />;
    }
    return (
      <Alert>
        <KeyRound aria-hidden />
        <p>
          Only this workspace's approvers can decide this request, and your passkey is not an
          approver here.
        </p>
      </Alert>
    );
  }
  if (!approval.confirmUrl) {
    return (
      <section className="grid grid-cols-1 gap-2" aria-label="Decision">
        <Alert tone="warning" className="items-start">
          <TriangleAlert aria-hidden />
          <div className="grid grid-cols-1 gap-1">
            <p className="font-medium">This request cannot be approved.</p>
            <p>
              The signer would not open its page for approving it. That happens when something
              changed after the request was made: the wallet's limits changed, a newer request
              replaced it, or the server was restored from a backup. It also happens while the
              signer cannot be reached. This page keeps checking. If nothing changes, reject it and
              ask again.
            </p>
          </div>
        </Alert>
        <RejectButton approval={approval} disabled={expired} className="justify-self-start" />
      </section>
    );
  }
  const host = new URL(approval.confirmUrl).host;
  return (
    <>
      {beingAdded ? (
        <ProvePasskey approval={approval} subject={beingAdded} expired={expired} />
      ) : null}
      <section className="grid grid-cols-1 gap-2" aria-label="Decision">
        {subject.kind === "add-approver" && !beingAdded ? (
          <CompareFingerprint approval={approval} subject={subject} />
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          {expired ? (
            <Button size="lg" disabled className={wrappingButton}>
              <ShieldCheck aria-hidden />
              Review and approve on the signer's page
            </Button>
          ) : (
            <a
              href={approval.confirmUrl}
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: "lg" }), wrappingButton)}
            >
              <ShieldCheck aria-hidden />
              Review and approve on the signer's page
            </a>
          )}
          <RejectButton approval={approval} disabled={expired} />
        </div>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            It opens <span className="font-mono break-all text-foreground">{host}</span>. Check that
            your address bar shows exactly this before you approve. To approve on another device,
            copy the link.
          </p>
          <CopyButton value={approval.confirmUrl} label="Copy link" />
        </div>
      </section>
    </>
  );
}

type AddApproverSubject = Extract<ApprovalSubject, { kind: "add-approver" }>;

/**
 * For the person an approver change adds. Nobody can approve the change until they prove on the
 * signer's page, with the new passkey, that it is theirs; that page then shows them the key's
 * fingerprint to read to an approver over another channel. Whether they did it already is known
 * only to the signer, so this page says what to do either way.
 */
function ProvePasskey({
  approval,
  subject,
  expired,
}: {
  approval: ApprovalDetail;
  subject: AddApproverSubject;
  expired: boolean;
}) {
  if (!approval.confirmUrl) {
    return (
      <Alert tone="warning" className="items-start">
        <TriangleAlert aria-hidden />
        <div className="grid grid-cols-1 gap-1">
          <p className="font-medium">You cannot prove that this passkey is yours right now.</p>
          <p>
            The signer would not open its page for this request. This page keeps checking. If
            nothing changes, ask an owner to ask for the change again.
          </p>
        </div>
      </Alert>
    );
  }
  const host = new URL(approval.confirmUrl).host;
  return (
    <section className="grid grid-cols-1 gap-2" aria-label="Your new passkey">
      <Alert tone="accent" className="items-start">
        <KeyRound aria-hidden />
        <div className="grid min-w-0 grid-cols-1 gap-1">
          <p className="font-medium">Prove that this passkey is yours</p>
          <p>
            Nobody can approve this request before you do. Open the signer's page on the device that
            holds your passkey “{subject.passkeyLabel}”, press “This passkey is mine” and answer
            with that passkey.
          </p>
          <p>
            The page then shows the passkey's fingerprint. Read it to someone who already approves
            here, over a call or in person, not in a message. They approve only if it matches what
            their page shows. If you did this already, nothing more is needed from you.
          </p>
        </div>
      </Alert>
      {expired ? (
        <Button size="lg" disabled className={wrappingButton}>
          <KeyRound aria-hidden />
          Prove the passkey is yours on the signer's page
        </Button>
      ) : (
        <a
          href={approval.confirmUrl}
          rel="noopener noreferrer"
          className={cn(buttonVariants({ size: "lg" }), wrappingButton)}
        >
          <KeyRound aria-hidden />
          Prove the passkey is yours on the signer's page
        </a>
      )}
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          It opens <span className="font-mono break-all text-foreground">{host}</span>. Check that
          your address bar shows exactly this. To do this on another device, copy the link.
        </p>
        <CopyButton value={approval.confirmUrl} label="Copy link" />
      </div>
    </section>
  );
}

/**
 * For the people who approve an approver change: the key is the new person's only if the
 * fingerprint they read out matches. The signer's page refuses an approval until that person has
 * proven there that the passkey is theirs, so this says who acts when it does.
 */
function CompareFingerprint({
  approval,
  subject,
}: {
  approval: ApprovalDetail;
  subject: AddApproverSubject;
}) {
  const fingerprint = newKeyFingerprint(approval);
  const name = subject.user.displayName;
  return (
    <Alert className="items-start">
      <KeyRound aria-hidden />
      <div className="grid min-w-0 grid-cols-1 gap-1">
        <p className="font-medium">Compare the fingerprint with {name} before you approve</p>
        <p>
          Ask {name} to read you the fingerprint the signer's page showed them, over a call or in
          person, not in a message. Approve only if it matches{" "}
          {fingerprint ? (
            <code className="font-mono font-semibold whitespace-nowrap">{fingerprint}</code>
          ) : (
            "the key fingerprint"
          )}{" "}
          on the signer's page. If it does not, reject.
        </p>
        <p>
          The signer's page takes your approval only after {name} has proven there that the passkey
          is theirs. If it says that has not happened yet, {name} has to open this request and press
          “This passkey is mine” first.
        </p>
      </div>
    </Alert>
  );
}

/** A long label wraps on a narrow screen or with large text, instead of widening the page. */
const wrappingButton = "h-auto min-h-12 min-w-0 px-4 py-2 text-center whitespace-normal";

/** Saying no needs no passkey: it ends the request at once, for everyone. */
function RejectButton({
  approval,
  disabled,
  className,
}: {
  approval: ApprovalDetail;
  disabled: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const reject = useMutation({
    mutationFn: () => api.call("reject", { params: { approvalId: approval.id }, body: {} }),
    onSuccess: async (next) => {
      setOpen(false);
      queryClient.setQueryData(keys.approval(approval.id), next);
      await queryClient.invalidateQueries({ queryKey: ["approvals", approval.workspaceId] });
      await queryClient.invalidateQueries({ queryKey: keys.workspace(approval.workspaceId) });
    },
  });
  return (
    <>
      <Button
        size="lg"
        variant="outline"
        className={className}
        onClick={() => setOpen(true)}
        disabled={disabled || reject.isPending}
      >
        <Ban aria-hidden />
        Reject
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Reject this request?">
        <p className="mt-2 text-sm text-muted-foreground">
          It ends at once for everyone and cannot be approved later. No passkey is needed to say no.
        </p>
        <FormError error={reject.error} />
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Keep it open
          </Button>
          <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}>
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/**
 * Where an approved cancel stands: signed and sent, and what became of the payment or sweep it
 * was meant to stop. The chain decides which of the two it includes.
 */
function CancelOutcome({
  subject,
  workspaceId,
}: {
  subject: CancelTransactionSubject;
  workspaceId: string;
}) {
  const { intent, sweep, transaction } = subject;
  const what = intent ? "payment" : "sweep";
  return (
    <>
      {transactionOpen(transaction.status) ? (
        <p>
          The cancel was signed and sent. The network includes either it or the {what}, whichever
          comes first.
        </p>
      ) : null}
      {intent ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <IntentStatusBadge status={intent.status} />
            <span className="text-muted-foreground">{intentSentence[intent.status]}</span>
          </div>
          {intent.failureCode ? (
            <p className="text-muted-foreground">{explainCode(intent.failureCode)}</p>
          ) : null}
          <IntentLink workspaceId={workspaceId} intent={intent} className={cn(linkClass, "w-fit")}>
            Open the payment
          </IntentLink>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            The sweep's transaction: {transactionSentence[transaction.status]}
          </p>
          {sweep ? (
            <Link
              to="/w/$workspaceId/approvals/$approvalId"
              params={{ workspaceId, approvalId: sweep.approvalId }}
              className={cn(linkClass, "w-fit")}
            >
              Open the sweep
            </Link>
          ) : null}
        </>
      )}
    </>
  );
}

/** Where a decided request ended up, followed until it is final. */
function Outcome({ approval }: { approval: ApprovalDetail }) {
  const subject = approval.subject;
  const intent = subject.kind === "approve-intent" ? subject.intent : null;
  const transaction =
    intent?.transaction ?? (subject.kind === "sweep-wallet" ? subject.transaction : null);
  const signs =
    subject.kind === "approve-intent" ||
    subject.kind === "sweep-wallet" ||
    subject.kind === "cancel-transaction";
  const mandate = subject.kind === "grant-mandate" ? subject.mandate : null;
  const destroy =
    subject.kind === "retire-wallet" || subject.kind === "delete-workspace" ? subject : null;
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
          <div className="grid min-w-0 grid-cols-1 gap-1">
            <p className="font-medium">
              {signs || destroy ? "Approved." : "Done. The change is in effect."}
            </p>
            {destroy?.kind === "retire-wallet" ? (
              <>
                <p>
                  The wallet signs nothing more. Its key is destroyed after{" "}
                  {formatEndTime(destroy.destroyAfter)} unless an owner or approver cancels first.
                </p>
                <Link
                  to="/w/$workspaceId/wallets/$walletId"
                  params={{ workspaceId: approval.workspaceId, walletId: destroy.wallet.id }}
                  className={linkClass}
                >
                  Open the wallet
                </Link>
              </>
            ) : null}
            {destroy?.kind === "delete-workspace" ? (
              <>
                <p>
                  The workspace is being deleted. Its keys are destroyed after{" "}
                  {formatEndTime(destroy.destroyAfter)} unless a member cancels first.
                </p>
                <Link
                  to="/w/$workspaceId"
                  params={{ workspaceId: approval.workspaceId }}
                  className={linkClass}
                >
                  Open the workspace
                </Link>
              </>
            ) : null}
            {mandate ? (
              <Link
                to="/w/$workspaceId/mandates/$mandateId"
                params={{ workspaceId: approval.workspaceId, mandateId: mandate.id }}
                className={linkClass}
              >
                Open the approval in advance
              </Link>
            ) : null}
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
            {subject.kind === "cancel-transaction" ? (
              <CancelOutcome subject={subject} workspaceId={approval.workspaceId} />
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
              {mandate
                ? explainMandateRefusal(approval.failureCode ?? "internal")
                : explainCode(approval.failureCode ?? "internal")}{" "}
              Nothing was signed with this approval.
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
  const grant = approval.subject.kind === "grant-mandate" ? approval.subject : null;
  return (
    <details className="group rounded-lg border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
        Technical details
      </summary>
      <div className="grid grid-cols-1 gap-4 border-t px-4 py-4 text-xs">
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
        {grant ? (
          <>
            <TechBlock label="Mandate hash (SHA-256)" value={grant.mandateHash} />
            <TechBlock
              label="Canonical mandate (exactly what is hashed and what the signer enforces)"
              value={canonicalJson(grant.mandate)}
              pre
            />
          </>
        ) : null}
        <TechBlock
          label="Envelope (what your passkey signs on the signer's page)"
          value={JSON.stringify(approval.envelope, null, 2)}
          pre
        />
        <p className="text-muted-foreground">
          Requested {formatTime(approval.createdAt)} · expires {formatTime(approval.expiresAt)} · id{" "}
          <code className="font-mono break-all">{approval.id}</code>
        </p>
      </div>
    </details>
  );
}
