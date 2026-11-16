import type { ApprovalDetail, IntentDetail, Role, TransactionInfo } from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Ban, Clock, ExternalLink, Gauge, Hourglass } from "lucide-react";
import { type ReactNode, useId } from "react";
import { FormError, linkClass, useNow } from "@/components/common.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { api, keys, queryClient } from "@/lib/api.ts";
import { explainCancelError, explainSpeedUpError } from "@/lib/codes.ts";
import { formatRelative, formatUnits } from "@/lib/format.ts";
import { stuckReasonSentence } from "@/lib/statuses.ts";
import {
  attemptFeeCeiling,
  attemptKindLabel,
  attemptStatusLabel,
  formatGwei,
  transactionActions,
  transactionOpen,
} from "@/lib/transaction.ts";
import { cn } from "@/lib/utils.ts";

/** A long label wraps on a narrow screen or with large text, instead of widening the page. */
const wrappingButton = "h-auto min-h-12 w-full min-w-0 px-4 py-2 text-center whitespace-normal";

/**
 * What a person may act on: a payment, sped up or cancelled through its intent, or a sweep,
 * cancelled through its request (a sweep is never sped up). `approvalId` is the payment's
 * request, whose page shows it too; null when an approval in advance covered it.
 */
export type TransactionTarget =
  | { kind: "payment"; intentId: IntentDetail["id"]; approvalId: ApprovalDetail["id"] | null }
  | { kind: "sweep"; approvalId: ApprovalDetail["id"] };

/**
 * A link to where a payment is shown in full: its request's page, or, for one an approval in
 * advance covered (it has no request), its own page.
 */
export function IntentLink({
  workspaceId,
  intent,
  className,
  children,
}: {
  workspaceId: string;
  intent: Pick<IntentDetail, "id" | "approvalId">;
  className?: string;
  children: ReactNode;
}) {
  return intent.approvalId ? (
    <Link
      to="/w/$workspaceId/approvals/$approvalId"
      params={{ workspaceId, approvalId: intent.approvalId }}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/w/$workspaceId/payments/$intentId"
      params={{ workspaceId, intentId: intent.id }}
      className={className}
    >
      {children}
    </Link>
  );
}

/** A transaction hash, linked to the block explorer when the chain has one. */
export function HashLink({ hash, explorerUrl }: { hash: string; explorerUrl: string | null }) {
  if (!explorerUrl) {
    return <code className="font-mono text-xs wrap-anywhere text-muted-foreground">{hash}</code>;
  }

  return (
    <a
      href={explorerUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="flex min-w-0 items-start gap-1 font-mono text-xs text-accent underline-offset-4 hover:underline"
    >
      <span className="min-w-0 wrap-anywhere">{hash}</span>
      <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span className="sr-only">(opens the block explorer)</span>
    </a>
  );
}

/**
 * A sent transaction with every attempt the signer signed for it, oldest first: what each one is,
 * its fee, its hash and whether the network mined it, why it is not mined yet, and, for owners
 * and approvers when the transaction allows it, Speed up and Cancel. Without `target` it only
 * shows (a cancel request's page shows the transaction it would stop this way).
 */
export function TransactionPanel({
  transaction,
  workspaceId,
  nativeSymbol,
  role,
  target,
}: {
  transaction: TransactionInfo;
  workspaceId: string;
  nativeSymbol: string;
  role: Role;
  target?: TransactionTarget;
}) {
  const titleId = useId();
  const now = useNow();
  const open = transactionOpen(transaction.status);
  const cancelSigned = transaction.attempts.some((attempt) => attempt.kind === "cancel");

  return (
    <section
      aria-labelledby={titleId}
      className="grid grid-cols-1 gap-3 rounded-lg border bg-card px-4 py-4"
    >
      <div className="grid grid-cols-1 gap-1">
        <h2 id={titleId} className="text-base font-semibold">
          Transaction
        </h2>
        <p className="text-sm text-muted-foreground">
          {transaction.attempts.length === 1
            ? "Signed once."
            : `Signed ${transaction.attempts.length} times at the same place in line, so the network includes at most one of them.`}
        </p>
      </div>

      {open && transaction.stuckReason ? (
        <Alert tone="warning" className="items-start py-2.5">
          <Hourglass aria-hidden />
          <p>
            <span className="font-medium">Not mined yet. </span>
            {stuckReasonSentence[transaction.stuckReason]}
          </p>
        </Alert>
      ) : null}
      {open && cancelSigned ? (
        <Alert tone="accent" className="items-start py-2.5">
          <Ban aria-hidden />
          <p>
            A cancel was signed and sent. If the network includes it first, nothing moves and only
            the network fee is paid. If it includes the{" "}
            {target?.kind === "sweep" ? "sweep" : "payment"} first, that goes through as sent.
          </p>
        </Alert>
      ) : null}

      {target ? (
        <Actions transaction={transaction} workspaceId={workspaceId} role={role} target={target} />
      ) : null}

      <ol aria-label="Attempts" className="grid grid-cols-1 divide-y rounded-md border">
        {transaction.attempts.map((attempt) => (
          <li key={attempt.attempt} className="grid min-w-0 grid-cols-1 gap-1 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="min-w-0 text-sm font-medium">
                Attempt {attempt.attempt + 1}: {attemptKindLabel[attempt.kind]}
              </p>
              <span
                className={cn(
                  "text-xs font-medium",
                  attempt.status === "mined" ? "text-success" : "text-muted-foreground",
                )}
              >
                {attemptStatusLabel[attempt.status]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Up to {formatGwei(attempt.maxFeePerGas)} per gas (tip{" "}
              {formatGwei(attempt.maxPriorityFeePerGas)}), at most{" "}
              {formatUnits(attemptFeeCeiling(attempt), 18)} {nativeSymbol} in fees · signed{" "}
              {formatRelative(attempt.signedAt, now)}
            </p>
            <HashLink hash={attempt.hash} explorerUrl={attempt.explorerUrl} />
            {attempt.cancelApprovalId ? (
              <Link
                to="/w/$workspaceId/approvals/$approvalId"
                params={{ workspaceId, approvalId: attempt.cancelApprovalId }}
                className={cn(linkClass, "w-fit text-xs")}
              >
                The cancel request it was approved under
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Speed up and Cancel, for the people who may use them. Speeding up needs no passkey: it changes
 * only the fees, within the ceiling people approved. Cancelling opens a request that approvers
 * approve with passkeys on the signer's page; this goes to it.
 */
function Actions({
  transaction,
  workspaceId,
  role,
  target,
}: {
  transaction: TransactionInfo;
  workspaceId: string;
  role: Role;
  target: TransactionTarget;
}) {
  const navigate = useNavigate();
  const allowed = transactionActions(transaction, role);
  const what = target.kind === "payment" ? "payment" : "sweep";

  const refresh = async () => {
    if (target.approvalId) {
      await queryClient.invalidateQueries({ queryKey: keys.approval(target.approvalId) });
    }

    if (target.kind === "payment") {
      await queryClient.invalidateQueries({ queryKey: keys.intent(target.intentId) });
    }

    await queryClient.invalidateQueries({ queryKey: keys.intents(workspaceId) });
    await queryClient.invalidateQueries({ queryKey: keys.mandates(workspaceId) });
    await queryClient.invalidateQueries({ queryKey: ["approvals", workspaceId] });
  };

  const speedUp = useMutation({
    mutationFn: (intentId: IntentDetail["id"]) =>
      api.call("speedUp", { params: { intentId }, body: {} }),
    onSuccess: async (next) => {
      queryClient.setQueryData(keys.intent(next.id), next);

      if (next.approvalId) {
        queryClient.setQueryData<ApprovalDetail>(keys.approval(next.approvalId), (old) =>
          old?.subject.kind === "approve-intent"
            ? { ...old, subject: { ...old.subject, intent: next } }
            : old,
        );
      }

      await refresh();
    },
  });

  const cancel = useMutation({
    mutationFn: () =>
      target.kind === "payment"
        ? api.call("requestCancel", { params: { intentId: target.intentId }, body: {} })
        : api.call("requestSweepCancel", { params: { approvalId: target.approvalId }, body: {} }),
    onSuccess: async (request) => {
      await refresh();
      await navigate({
        to: "/w/$workspaceId/approvals/$approvalId",
        params: { workspaceId, approvalId: request.id },
      });
    },
  });

  // What could be done now: a viewer reads that owners and approvers may do it.
  const possible = [
    transaction.canSpeedUp && target.kind === "payment" ? "speed it up" : null,
    transaction.canCancel ? "cancel it" : null,
  ].filter((verb) => verb !== null);

  const viewerNote = role === "viewer" && possible.length > 0;

  if (
    !transaction.pendingCancelApprovalId &&
    !allowed.speedUp &&
    !allowed.cancel &&
    !viewerNote &&
    !speedUp.error &&
    !cancel.error
  ) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-2">
      {transaction.pendingCancelApprovalId ? (
        <Alert className="items-start py-2.5">
          <Clock aria-hidden />
          <p>
            A request to cancel this {what} waits for approval.{" "}
            <Link
              to="/w/$workspaceId/approvals/$approvalId"
              params={{ workspaceId, approvalId: transaction.pendingCancelApprovalId }}
              className={linkClass}
            >
              Open the cancel request
            </Link>
          </p>
        </Alert>
      ) : null}
      {allowed.speedUp || allowed.cancel ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {allowed.speedUp && target.kind === "payment" ? (
            <Button
              size="lg"
              className={wrappingButton}
              onClick={() => speedUp.mutate(target.intentId)}
              disabled={speedUp.isPending}
            >
              <Gauge aria-hidden />
              {speedUp.isPending ? "Speeding up…" : "Speed up"}
            </Button>
          ) : null}
          {allowed.cancel ? (
            <Button
              size="lg"
              variant="outline"
              className={wrappingButton}
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              <Ban aria-hidden />
              {cancel.isPending ? "Asking…" : `Cancel ${what}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      <FormError error={speedUp.error} explain={explainSpeedUpError} />
      <FormError error={cancel.error} explain={explainCancelError} />
      {allowed.speedUp && target.kind === "payment" ? (
        <p className="text-xs text-muted-foreground">
          Speed up signs the same payment again with a higher network fee, within the fee ceiling
          people approved. It needs no passkey.
        </p>
      ) : null}
      {allowed.cancel ? (
        <p className="text-xs text-muted-foreground">
          Cancel asks this wallet's approvers to approve, with passkeys on the signer's page, a
          transfer of nothing from the wallet to itself in its place. It is an attempt, not a
          guarantee: if the network includes the {what} first, the {what} goes through.
        </p>
      ) : null}
      {viewerNote ? (
        <p className="text-xs text-muted-foreground">
          Owners and approvers can {possible.join(" or ")}.
        </p>
      ) : null}
    </div>
  );
}
