import type { Role } from "@askgina/os-api";
import { WorkspaceId } from "@askgina/os-protocol";
import { and, eq } from "drizzle-orm";
import type { AppContext, Session } from "./context.ts";
import { memberships } from "./db/schema.ts";
import { HttpError } from "./http/errors.ts";

const RANK: Record<Role, number> = { viewer: 0, approver: 1, owner: 2 };

/**
 * The workspace id in a request path. A segment that is not a workspace id names no workspace,
 * so it gets the answer {@link requireMember} gives for a workspace that does not exist.
 */
export function workspaceIdFromPath(segment: string): WorkspaceId {
  const parsed = WorkspaceId.safeParse(segment);

  if (!parsed.success) throw new HttpError("not_found", "no such workspace");

  return parsed.data;
}

/**
 * The signed-in person's role in a workspace, or a refusal. Someone who is not a member gets
 * `not_found`, the same answer as for a workspace that does not exist.
 */
export async function requireMember(
  ctx: Pick<AppContext, "db">,
  session: Session,
  workspaceId: WorkspaceId,
  atLeast: Role = "viewer",
): Promise<Role> {
  const [membership] = await ctx.db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, session.user.id)));

  if (!membership) throw new HttpError("not_found", "no such workspace");

  if (RANK[membership.role] < RANK[atLeast]) {
    throw new HttpError("forbidden", `this needs the ${atLeast} role`);
  }

  return membership.role;
}
