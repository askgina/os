import { describe, expect, it } from "vitest";
import { enrollApproverCommand, UnsafeCommandValue } from "../src/lib/operator.ts";

const values = {
  workspaceId: "ws_01HZY",
  userId: "usr_01HZY",
  credentialId: "AbC-_123",
  publicKey: "pQECAyYgASFYIK-_x",
};

describe("enrollApproverCommand", () => {
  it("names the exact workspace, person and passkey to enroll", () => {
    expect(enrollApproverCommand(values)).toBe(
      "docker compose exec signer node src/admin.ts enroll-approver --workspace ws_01HZY --user usr_01HZY --credential-id AbC-_123 --public-key pQECAyYgASFYIK-_x",
    );
  });

  it.each(["workspaceId", "userId", "credentialId", "publicKey"] as const)(
    "refuses a %s that could inject shell syntax",
    (field) => {
      expect(() => enrollApproverCommand({ ...values, [field]: "x; rm -rf /" })).toThrow(
        UnsafeCommandValue,
      );
      expect(() => enrollApproverCommand({ ...values, [field]: "$(id)" })).toThrow(
        UnsafeCommandValue,
      );
      expect(() => enrollApproverCommand({ ...values, [field]: "" })).toThrow(UnsafeCommandValue);
    },
  );
});
