import { createHmac } from "node:crypto";
import type { ApprovalKind } from "@askgina/os-api";
import { canonicalJson, type NotificationDeliveryId } from "@askgina/os-protocol";
import type { ApprovalRow } from "../approvals/kinds.ts";
import type { AppContext } from "../context.ts";
import type { NotificationEvent } from "../db/schema.ts";
import { approvalLink, mandateLink } from "./content.ts";
import { isRetryable, postOnce } from "./http.ts";

/**
 * The body of one webhook delivery, version 1: JSON with its keys sorted, identifiers, a time
 * and a link only. Nothing anyone typed (an amount, a recipient, a memo, a name) is ever in it.
 *
 * Headers: `x-os-delivery` (the `deliveryId`, the same on every retry of one delivery, so a
 * receiver dedupes on it), `x-os-timestamp` (Unix seconds when this attempt was sent) and
 * `x-os-signature: v1=<hex HMAC-SHA-256(secret, timestamp + "." + body)>`. A receiver checks
 * the signature over the exact bytes it received and refuses a timestamp over 300 seconds old.
 */
export type WebhookBody =
  | {
      v: 1;
      deliveryId: NotificationDeliveryId;
      event: "approval.opened" | "approval.reminder";
      approvalId: string;
      workspaceId: string;
      kind: ApprovalKind;
      /** Unix seconds. */
      expiresAt: number;
      /** The approval's page in the web app. */
      link: string;
    }
  | {
      v: 1;
      deliveryId: NotificationDeliveryId;
      /**
       * People approved retiring one wallet or deleting the workspace, and the signer destroys
       * the keys at `destroyAfter` unless someone cancels first (`lifecycle.scheduled`), or will
       * in 24 hours (`lifecycle.due_soon`).
       */
      event: "lifecycle.scheduled" | "lifecycle.due_soon";
      /** The `retire-wallet` or `delete-workspace` request people approved. */
      approvalId: string;
      workspaceId: string;
      kind: "retire-wallet" | "delete-workspace";
      /** The retiring wallet; null for a deletion, which destroys every wallet's key. */
      walletId: string | null;
      /** Unix seconds. */
      destroyAfter: number;
      /** The request's page in the web app. */
      link: string;
    }
  | {
      v: 1;
      deliveryId: NotificationDeliveryId;
      event: "mandate.used";
      /** The use's row, not shown to people; the mandate's page lists the use. */
      approvalId: string;
      workspaceId: string;
      mandateId: string;
      /** The mandate's page in the web app. */
      link: string;
    };

/** What one delivery attempt came to. `code` is short and never carries a response body. */
export type DeliveryResult =
  | { ok: true }
  | { ok: false; retry: boolean; code: string; retryAfter?: number };

function webhookBody(
  origin: string,
  delivery: { id: NotificationDeliveryId; event: NotificationEvent },
  approval: ApprovalRow,
): WebhookBody {
  if (delivery.event === "mandate.used") {
    if (approval.mandateId === null) throw new Error("a mandate use without its mandate");

    return {
      v: 1,
      deliveryId: delivery.id,
      event: delivery.event,
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      mandateId: approval.mandateId,
      link: mandateLink(origin, approval.workspaceId, approval.mandateId),
    };
  }

  if (approval.kind === "mandate-use") throw new Error("a mandate use is no approval to announce");

  if (delivery.event === "lifecycle.scheduled" || delivery.event === "lifecycle.due_soon") {
    const envelope = approval.envelope;

    if (envelope?.type !== "retire-wallet" && envelope?.type !== "delete-workspace") {
      throw new Error("a lifecycle notice without a retirement or deletion");
    }

    return {
      v: 1,
      deliveryId: delivery.id,
      event: delivery.event,
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      kind: envelope.type,
      walletId: envelope.type === "retire-wallet" ? envelope.wallet.walletId : null,
      destroyAfter: envelope.destroyAfter,
      link: approvalLink(origin, approval.workspaceId, approval.id),
    };
  }

  return {
    v: 1,
    deliveryId: delivery.id,
    event: delivery.event,
    approvalId: approval.id,
    workspaceId: approval.workspaceId,
    kind: approval.kind,
    expiresAt: Math.floor(approval.expiresAt.getTime() / 1000),
    link: approvalLink(origin, approval.workspaceId, approval.id),
  };
}

/**
 * POST one delivery to the operator's webhook, signed. 2xx delivers; 408, 429, 5xx, a timeout or
 * no answer are worth another try; any other answer (a redirect included) is final.
 */
export async function sendWebhook(
  ctx: Pick<AppContext, "config" | "now">,
  delivery: { id: NotificationDeliveryId; event: NotificationEvent },
  approval: ApprovalRow,
): Promise<DeliveryResult> {
  const webhook = ctx.config.notify.webhook;

  if (webhook === null) throw new Error("no webhook is configured");
  const body = canonicalJson(webhookBody(ctx.config.publicOrigin, delivery, approval));
  const timestamp = ctx.now();

  const signature = createHmac("sha256", webhook.secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const outcome = await postOnce(
    webhook.url,
    {
      "content-type": "application/json",
      "x-os-delivery": delivery.id,
      "x-os-timestamp": String(timestamp),
      "x-os-signature": `v1=${signature}`,
    },
    body,
    timestamp,
  );

  if (outcome.status === null) return { ok: false, retry: true, code: outcome.code };

  if (outcome.status >= 200 && outcome.status < 300) return { ok: true };
  const code = `http_${outcome.status}`;

  if (!isRetryable(outcome.status)) return { ok: false, retry: false, code };

  return outcome.retryAfter === undefined
    ? { ok: false, retry: true, code }
    : { ok: false, retry: true, code, retryAfter: outcome.retryAfter };
}
