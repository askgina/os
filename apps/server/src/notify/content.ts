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

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

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
    title = `${KIND_LABEL[facts.kind]} waiting`;
    body = `${facts.requesterName} in ${facts.workspaceName}`;
  } else {
    title = "Approval waiting";
    body = count === 1 ? "1 request needs your passkey" : `${many} requests need your passkey`;
  }
  const message: DeclarativePush = {
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
  };
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
