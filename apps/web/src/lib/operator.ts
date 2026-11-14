/**
 * The one command an operator runs on the signer's host to make a waiting passkey an approver
 * when no approver is left to accept the request in the inbox.
 *
 * The values come from the API, but this string is pasted into a root shell, so every value is
 * checked against the characters ids and base64url keys are made of. Anything else would be a
 * sign of a broken or hostile server, and no command is offered at all.
 */
const SAFE = /^[A-Za-z0-9_-]+$/;

export class UnsafeCommandValue extends Error {
  override readonly name = "UnsafeCommandValue";
}

export function enrollApproverCommand(input: {
  workspaceId: string;
  userId: string;
  credentialId: string;
  publicKey: string;
}): string {
  for (const value of Object.values(input)) {
    if (!SAFE.test(value)) throw new UnsafeCommandValue("A value is not safe to put in a command.");
  }
  return [
    "docker compose exec signer node src/admin.ts enroll-approver",
    `--workspace ${input.workspaceId}`,
    `--user ${input.userId}`,
    `--credential-id ${input.credentialId}`,
    `--public-key ${input.publicKey}`,
  ].join(" ");
}
