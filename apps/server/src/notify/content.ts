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
