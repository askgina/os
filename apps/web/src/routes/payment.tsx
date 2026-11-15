import type { IntentDetail, WorkspaceDetail } from "@askgina/os-api";
import { canonicalJson } from "@askgina/os-protocol";
import { Link, useParams } from "@tanstack/react-router";
import {
  backLinkClass,
  ErrorState,
  Field,
  FullAddress,
  IntentStatusBadge,
  Loading,
  linkClass,
  PageHeader,
  TechBlock,
} from "@/components/common.tsx";
import { TransactionPanel } from "@/components/transaction.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { useIntent, useWorkspace } from "@/lib/api.ts";
import { chainName } from "@/lib/assets.ts";
import { explainCode } from "@/lib/codes.ts";
import { formatTime, formatUnits, shortAddress } from "@/lib/format.ts";
import { intentStatusSentence } from "@/lib/statuses.ts";
import { paymentTitle } from "@/lib/transaction.ts";

/**
 * One payment and the transaction it sent, with every attempt. It is the page of a payment an
 * approval in advance covered, which has no request of its own: there, as on a request's page,
 * owners and approvers can speed up or cancel it while it is not mined.
 */
export function PaymentPage() {
  const { workspaceId, intentId } = useParams({ from: "/w/$workspaceId/payments/$intentId" });
  const workspace = useWorkspace(workspaceId);
  const intent = useIntent(intentId);
  if (intent.isPending || !workspace.data) return <Loading label="Loading the payment" />;
  if (intent.isError) {
    return <ErrorState error={intent.error} retry={() => void intent.refetch()} />;
  }
  return <PaymentView intent={intent.data} workspace={workspace.data} />;
}

function PaymentView({ intent, workspace }: { intent: IntentDetail; workspace: WorkspaceDetail }) {
  const { display } = intent;
  const wallet = workspace.wallets.find((item) => item.id === intent.walletId);
  const chain = workspace.chains.find((item) => item.chainId === intent.chainId);
  const nativeSymbol = chain?.nativeSymbol ?? "native coin";
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title={paymentTitle(display)}
        back={
          intent.mandateId ? (
            <Link
              to="/w/$workspaceId/mandates/$mandateId"
              params={{ workspaceId: workspace.id, mandateId: intent.mandateId }}
              className={backLinkClass}
            >
              ← Approved in advance for {intent.agent.name}
            </Link>
          ) : (
            <Link
              to="/w/$workspaceId/agents/$agentId"
              params={{ workspaceId: workspace.id, agentId: intent.agent.id }}
              className={backLinkClass}
            >
              ← {intent.agent.name}
            </Link>
          )
        }
        description={`Asked by agent ${intent.agent.name}, ${formatTime(intent.createdAt)}`}
        actions={<IntentStatusBadge status={intent.status} />}
      />

      <Alert className="items-start">
        <div className="grid grid-cols-1 gap-1">
          <p>{intentStatusSentence(intent.status, intent.mandateId !== null)}</p>
          {intent.failureCode ? (
            <p className="text-muted-foreground">{explainCode(intent.failureCode)}</p>
          ) : null}
        </div>
      </Alert>

      {intent.transaction ? (
        <TransactionPanel
          transaction={intent.transaction}
          workspaceId={workspace.id}
          nativeSymbol={nativeSymbol}
          role={workspace.role}
          target={{ kind: "payment", intentId: intent.id, approvalId: intent.approvalId }}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3">
            <Field label="Amount">
              <span className="wrap-anywhere">
                {display.amountFormatted} {display.assetSymbol}{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  ({display.amount} base units)
                </span>
              </span>
            </Field>
            <Field label={display.rawCall ? "Contract" : "Recipient"}>
              <FullAddress address={display.to} />
            </Field>
            <Field label="From wallet">
              {wallet?.label ?? intent.walletId}{" "}
              {wallet ? (
                <span className="font-mono text-xs">{shortAddress(wallet.address)}</span>
              ) : null}
            </Field>
            <Field label="Network">{chainName(intent.chainId, workspace.chains)}</Field>
            <Field label="Network fee, at most">
              {formatUnits("maxFeeWei" in intent.intent ? intent.intent.maxFeeWei : "0", 18)}{" "}
              {nativeSymbol}
            </Field>
            <Field label="Approved">
              {intent.mandateId ? (
                <Link
                  to="/w/$workspaceId/mandates/$mandateId"
                  params={{ workspaceId: workspace.id, mandateId: intent.mandateId }}
                  className={linkClass}
                >
                  In advance: nobody was asked
                </Link>
              ) : intent.approvalId ? (
                <Link
                  to="/w/$workspaceId/approvals/$approvalId"
                  params={{ workspaceId: workspace.id, approvalId: intent.approvalId }}
                  className={linkClass}
                >
                  By people, on its request
                </Link>
              ) : null}
            </Field>
            <Field label="The agent's memo">
              <span className="whitespace-pre-wrap wrap-anywhere">
                {intent.memo === "" ? (
                  <span className="text-muted-foreground">(no memo)</span>
                ) : (
                  intent.memo
                )}
              </span>
            </Field>
          </dl>
        </CardContent>
      </Card>

      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium select-none">
          Technical details
        </summary>
        <div className="grid grid-cols-1 gap-4 border-t px-4 py-4 text-xs">
          <TechBlock label="Intent hash (SHA-256)" value={intent.intentHash} />
          <TechBlock
            label="Canonical intent (exactly what is hashed)"
            value={canonicalJson(intent.intent)}
            pre
          />
          <p className="text-muted-foreground">
            id <code className="font-mono break-all">{intent.id}</code>
          </p>
        </div>
      </details>
    </div>
  );
}
