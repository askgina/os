import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../context.ts";
import { credentials, sessions } from "../db/schema.ts";

/** Stop a passkey signing in, and end the sessions it signed in. */
export async function revokePasskey(tx: Executor, credentialId: string, at: Date): Promise<void> {
  await tx
    .update(credentials)
    .set({ revokedAt: at })
    .where(and(eq(credentials.id, credentialId), isNull(credentials.revokedAt)));
  await tx
    .update(sessions)
    .set({ revokedAt: at })
    .where(and(eq(sessions.credentialId, credentialId), isNull(sessions.revokedAt)));
}
