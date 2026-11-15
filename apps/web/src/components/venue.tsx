import type { ApprovalDetail, IntentDetail, OrderDisplay, Role } from "@askgina/os-api";
import { useMutation } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import type { ReactNode } from "react";
import { FormError, IntentStatusBadge } from "@/components/common.tsx";
import { Button } from "@/components/ui/button.tsx";
import { api, keys, queryClient } from "@/lib/api.ts";
import { explainCancelOrderError, explainCode } from "@/lib/codes.ts";
import { formatTime } from "@/lib/format.ts";
import { orderStatusSentence } from "@/lib/statuses.ts";
import { formatDecimal, VENUE_REPORTED } from "@/lib/venue.ts";

/**
 * Where an approved order stands at the venue, as this server last read it, and the way to
 * cancel it. Cancelling needs no passkey: approving the order included the right to cancel it,
 * and a cancel only removes what was approved. Owners and approvers may cancel; a viewer reads.
 */
export function VenueOrderStatus({
  intent,
  display,
  workspaceId,
  role,
}: {
  intent: IntentDetail;
  display: OrderDisplay;
  workspaceId: string;
  role: Role;
}) {
  const order = intent.order;
  const cancel = useMutation({
    mutationFn: () => api.call("cancelOrder", { params: { intentId: intent.id }, body: {} }),
    onSuccess: async (next) => {
      queryClient.setQueryData(keys.intent(next.id), next);
      if (next.approvalId) {
        queryClient.setQueryData<ApprovalDetail>(keys.approval(next.approvalId), (old) =>
          old?.subject.kind === "approve-intent"
            ? { ...old, subject: { ...old.subject, intent: next } }
            : old,
        );
        await queryClient.invalidateQueries({ queryKey: keys.approval(next.approvalId) });
      }
      await queryClient.invalidateQueries({ queryKey: keys.intents(workspaceId) });
    },
  });
  const canCancel = order?.canCancel === true;
  const acts = role !== "viewer";
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <IntentStatusBadge status={intent.status} />
        <span className="text-muted-foreground">
          {orderStatusSentence(intent.status, order !== null)}
        </span>
      </div>
      {intent.failureCode ? (
        <p className="text-muted-foreground">{explainCode(intent.failureCode)}</p>
      ) : null}
      {order ? (
        <>
          {order.venueError ? (
            <figure className="rounded-md border-l-4 border-muted-foreground/40 bg-muted px-3 py-2">
              <figcaption className="text-xs text-muted-foreground">Hyperliquid said:</figcaption>
              <blockquote className="text-sm wrap-anywhere">{order.venueError}</blockquote>
            </figure>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <OrderFact label="Filled">
              {order.filledSize === null
                ? "Nothing reported yet"
                : `${formatDecimal(order.filledSize)} of ${formatDecimal(display.size)} ${display.coin}`}
            </OrderFact>
            <OrderFact label="Average price">
              {order.averagePrice === null
                ? "None yet"
                : `${formatDecimal(order.averagePrice)} USD`}
            </OrderFact>
            <OrderFact label="Venue order id">
              {order.venueOrderId === null ? "None yet" : String(order.venueOrderId)}
            </OrderFact>
            <OrderFact label="Venue accepts it until">{formatTime(order.submitBy)}</OrderFact>
            <OrderFact label="Client order id" wide>
              <code className="font-mono text-xs break-all">{order.cloid}</code>
            </OrderFact>
          </dl>
          <p className="text-xs text-muted-foreground">{VENUE_REPORTED}</p>
        </>
      ) : null}
      {canCancel && acts ? (
        <>
          <Button
            size="lg"
            variant="outline"
            className="h-auto min-h-12 w-full min-w-0 px-4 py-2 text-center whitespace-normal sm:w-fit"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
          >
            <Ban aria-hidden />
            {cancel.isPending ? "Cancelling…" : "Cancel order"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Approving the order included the right to cancel it, so this needs no passkey; the agent
            may cancel it too. Whatever has already filled stays filled.
          </p>
        </>
      ) : null}
      {canCancel && !acts ? (
        <p className="text-xs text-muted-foreground">Owners and approvers can cancel it.</p>
      ) : null}
      <FormError error={cancel.error} explain={explainCancelOrderError} />
    </div>
  );
}

function OrderFact({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-anywhere">{children}</dd>
    </div>
  );
}
