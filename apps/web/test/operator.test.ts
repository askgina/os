import { describe, expect, it } from "vitest";
import { enrollApproverCommand, UnsafeCommandValue } from "../src/lib/operator.ts";

const values = {
  workspaceId: "ws_01HZY",
  userId: "usr_01HZY",
  credentialId: "AbC-_123",
  publicKey: "pQECAyYgASFYIK-_x",
};

const COMPOSE = "docker compose exec signer node src/admin.ts";

describe("enrollApproverCommand", () => {
  it("names the exact workspace, person and passkey to enroll", () => {
    expect(enrollApproverCommand(COMPOSE, values)).toBe(
      "docker compose exec signer node src/admin.ts enroll-approver --workspace ws_01HZY --user usr_01HZY --credential-id=AbC-_123 --public-key=pQECAyYgASFYIK-_x",
    );
  });

  it("starts with the installation's own way to the signer's admin commands", () => {
    const split =
      "docker compose -f deploy/split/signer.compose.yaml exec signer node src/admin.ts";

    expect(enrollApproverCommand(split, values)).toBe(
      `${split} enroll-approver --workspace ws_01HZY --user usr_01HZY --credential-id=AbC-_123 --public-key=pQECAyYgASFYIK-_x`,
    );
  });

  it.each([
    undefined,
    "",
    "docker compose exec signer node src/admin.ts; id",
    "docker compose exec signer $(id)",
    "docker  compose exec signer",
    "ssh 'signer host' docker",
    "docker compose exec signer node src/admin.ts\nid",
  ])("refuses an admin command a root shell would read as more than words: %j", (prefix) => {
    expect(() => enrollApproverCommand(prefix, values)).toThrow(UnsafeCommandValue);
  });

  it.each(["workspaceId", "userId", "credentialId", "publicKey"] as const)(
    "refuses a %s that could inject shell syntax",
    (field) => {
      expect(() => enrollApproverCommand(COMPOSE, { ...values, [field]: "x; rm -rf /" })).toThrow(
        UnsafeCommandValue,
      );
      expect(() => enrollApproverCommand(COMPOSE, { ...values, [field]: "$(id)" })).toThrow(
        UnsafeCommandValue,
      );
      expect(() => enrollApproverCommand(COMPOSE, { ...values, [field]: "" })).toThrow(
        UnsafeCommandValue,
      );
    },
  );
});
