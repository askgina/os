import { SignerAdminCommand } from "@askgina/os-api";

/**
 * The one command an operator runs on the signer's host to make a waiting passkey an approver
 * when no approver is left to accept the request in the inbox. It starts with the installation's
 * own way to reach the signer's admin commands (`signerAdminCommand`, the server's
 * `SIGNER_ADMIN_COMMAND`), which differs when the signer runs on a host of its own.
 *
 * The values come from the API, but this string is pasted into a root shell, so every value is
 * checked against the characters ids and base64url keys are made of, and the prefix against
 * plain words of a fixed set. Anything else would be a sign of a broken or hostile server, and
 * no command is offered at all.
 */
const SAFE = /^[A-Za-z0-9_-]+$/;

export class UnsafeCommandValue extends Error {
  override readonly name = "UnsafeCommandValue";
}

export function enrollApproverCommand(
  signerAdminCommand: string | undefined,
  input: {
    workspaceId: string;
    userId: string;
    credentialId: string;
    publicKey: string;
  },
): string {
  const prefix = SignerAdminCommand.safeParse(signerAdminCommand);

  if (!prefix.success) {
    throw new UnsafeCommandValue("The signer's admin command is not safe to put in a command.");
  }

  for (const value of Object.values(input)) {
    if (!SAFE.test(value)) throw new UnsafeCommandValue("A value is not safe to put in a command.");
  }

  return [
    `${prefix.data} enroll-approver`,
    `--workspace ${input.workspaceId}`,
    `--user ${input.userId}`,
    // base64url values may start with "-", which an option parser reads as another option
    // unless the value is attached with "=".
    `--credential-id=${input.credentialId}`,
    `--public-key=${input.publicKey}`,
  ].join(" ");
}
