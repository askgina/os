import type { ApprovalKind, NotificationDetail } from "@askgina/os-api";
import { ApprovalId, MandateId, WorkspaceId } from "@askgina/os-protocol";

/**
 * Links handed out to people and to the webhook. They are built from checked identifiers only,
 * on the control plane's own origin, and carry no token: a link is never a capability, and
 * opening one needs a passkey sign-in like any other page.
 */

/** Where a person decides on a request in the web app. Every approval link points here. */
export function approvalLink(origin: string, workspaceId: string, approvalId: string): string {
  return `${origin}/w/${WorkspaceId.parse(workspaceId)}/approvals/${ApprovalId.parse(approvalId)}`;
}

/** The page of a mandate, where its uses are listed. */
export function mandateLink(origin: string, workspaceId: string, mandateId: string): string {
  return `${origin}/w/${WorkspaceId.parse(workspaceId)}/mandates/${MandateId.parse(mandateId)}`;
}

/**
 * The longest push message, as UTF-8 JSON: the sender pads every message to 512 bytes, one of
 * which is the padding delimiter.
 */
export const PUSH_PAYLOAD_MAX_BYTES = 511;

/** The longest title or body, in characters. */
const TEXT_MAX_CHARACTERS = 60;

/** The badge counts up to this; more read as this many. */
const BADGE_MAX = 99;

/**
 * Everything a push message may be built from. There is no field for an amount, an address, a
 * memo or anything else an agent typed about an operation, so no level can show one.
 */
export interface PushFacts {
  approvalId: ApprovalId;
  /** Requests waiting for this person's passkey, this one included. */
  pendingCount: number;
  kind: ApprovalKind;
  /**
   * For `approve-intent`: whether the intent is a payment (a transfer, a contract call or a
   * venue withdrawal) or a venue order, so an order is not announced as a payment. Null for
   * every other kind. No order field (market, side, size, price, notional) has a place here.
   */
  operation: "payment" | "order" | null;
  workspaceName: string;
  /** The agent's or the person's name. */
  requesterName: string;
}

/**
 * A Declarative Web Push message (`web_push: 8030`): Safari 18.4 and later shows `notification`
 * by itself; every other browser hands the same JSON to the service worker, which shows it.
 * `navigate` is the approval page on the control plane's own origin; `tag` is the same for a
 * request's reminder, so the reminder replaces the first notification on the device.
 */
export interface DeclarativePush {
  web_push: 8030;
  notification: {
    title: string;
    body: string;
    navigate: string;
    tag: string;
    lang: "en";
    silent: false;
    app_badge: string;
  };
}

const KIND_LABEL: Record<ApprovalKind, string> = {
  "approve-intent": "Payment",
  "set-policy": "Policy change",
  "add-approver": "New approver passkey",
  "remove-approver": "Approver removal",
  "set-admin-threshold": "Admin threshold change",
  "resume-workspace": "Workspace resume",
  "sweep-wallet": "Wallet sweep",
  "grant-mandate": "Approval in advance",
  "cancel-transaction": "Cancel request",
  "retire-wallet": "Wallet retirement",
  "delete-workspace": "Workspace deletion",
};

/** One line of at most {@link TEXT_MAX_CHARACTERS}: control, format and separator characters out. */
function line(text: string): string {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const characters = Array.from(flat);

  if (characters.length <= TEXT_MAX_CHARACTERS) return flat;

  return `${characters.slice(0, TEXT_MAX_CHARACTERS - 1).join("")}…`;
}

const bytes = (message: DeclarativePush) =>
  new TextEncoder().encode(JSON.stringify(message)).length;

/** Shorten a body, then a title, that is too long in bytes; throw when even that is not enough. */
function fit(message: DeclarativePush): DeclarativePush {
  const { notification } = message;

  for (const field of ["body", "title"] as const) {
    while (bytes(message) > PUSH_PAYLOAD_MAX_BYTES && notification[field].length > 1) {
      notification[field] = `${Array.from(notification[field]).slice(0, -2).join("")}…`;
    }
  }

  if (bytes(message) > PUSH_PAYLOAD_MAX_BYTES) {
    throw new Error("the approval link leaves no room for a push message");
  }

  return message;
}

/**
 * What a person's device shows when a retirement or deletion people approved was applied, and
 * again 24 hours before its keys are destroyed (`dueSoon`), so someone who did not mean it can
 * still cancel. `count`: only that keys are scheduled for destruction. `summary`: also which
 * workspace, whether one wallet or the whole workspace, and when. Nothing anyone typed beyond
 * the workspace's name, and no address or amount. Tagged with the request, so the second
 * notice replaces the first.
 */
export function lifecycleMessage(input: {
  level: NotificationDetail;
  approvalId: ApprovalId;
  kind: "retire-wallet" | "delete-workspace";
  workspaceName: string;
  destroyAfter: number;
  /** Requests waiting for this person's passkey, for the badge. */
  pendingCount: number;
  link: string;
  dueSoon: boolean;
}): DeclarativePush {
  let title: string;
  let body: string;

  if (input.level === "summary") {
    // `2026-11-22 14:05 UTC`: the same for every reader, whatever their time zone.
    const when = new Date(input.destroyAfter * 1000).toISOString().slice(0, 16).replace("T", " ");
    title = `${KIND_LABEL[input.kind]} scheduled`;
    // The time first: a long workspace name is what gets cut.
    body = `Keys destroyed ${when} UTC in ${input.workspaceName}`;
  } else {
    title = "Keys scheduled for destruction";
    body = "Open to review or cancel";
  }

  return fit({
    web_push: 8030,
    notification: {
      title: line(input.dueSoon ? `In 24 hours: ${title}` : title),
      body: line(body),
      navigate: input.link,
      tag: `lifecycle-${ApprovalId.parse(input.approvalId)}`,
      lang: "en",
      silent: false,
      app_badge: String(Math.min(Math.max(0, input.pendingCount), BADGE_MAX)),
    },
  });
}

/**
 * What a person's device shows for a waiting request, at the workspace's level. `count`: only
 * how many requests wait. `summary`: the kind of request, who asked and in which workspace,
 * each line cut to 60 characters with control characters removed. A reminder's title starts
 * with "Expiring soon: ". The JSON never exceeds {@link PUSH_PAYLOAD_MAX_BYTES}: a body, then a
 * title, too long in bytes loses characters from its end.
 */
export function pushMessage(input: {
  level: NotificationDetail;
  facts: PushFacts;
  link: string;
  reminder: boolean;
}): DeclarativePush {
  const { facts } = input;
  const count = Math.min(Math.max(1, facts.pendingCount), BADGE_MAX);
  const many = facts.pendingCount > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
  let title: string;
  let body: string;

  if (input.level === "summary") {
    const label =
      facts.kind === "approve-intent" && facts.operation === "order"
        ? "Order"
        : KIND_LABEL[facts.kind];

    title = `${label} waiting`;
    body = `${facts.requesterName} in ${facts.workspaceName}`;
  } else {
    title = "Approval waiting";
    body = count === 1 ? "1 request needs your passkey" : `${many} requests need your passkey`;
  }

  return fit({
    web_push: 8030,
    notification: {
      title: line(input.reminder ? `Expiring soon: ${title}` : title),
      body: line(body),
      navigate: input.link,
      tag: `approval-${ApprovalId.parse(facts.approvalId)}`,
      lang: "en",
      silent: false,
      app_badge: String(count),
    },
  });
}
