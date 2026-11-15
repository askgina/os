import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  DeleteWorkspaceEnvelope,
  Envelope,
  envelopeChallenge,
  RetireWalletEnvelope,
  WalletRef,
  walletsToDestroy,
} from "../src/index.ts";
import {
  AuthorizedRequest,
  RetireWalletStepRequest,
  SignerErrorCode,
  signerErrorStatus,
  signerRoutes,
  WalletLifecycle,
  WalletState,
  WorkspaceLifecycle,
  WorkspaceState,
} from "../src/signer/index.ts";
import { approverCredentialOf, assertEnvelope, SoftAuthenticator } from "../src/testing/index.ts";
import { type RelyingParty, verifyAuthorization } from "../src/webauthn/index.ts";
import {
  APPROVAL,
  BOB,
  DESTROY_DELAY,
  deleteWorkspace,
  OTHER_WALLET,
  OTHER_WALLET_ADDRESS,
  resumeWorkspace,
  retireWallet,
  T0,
  USER_A,
  WALLET,
  WALLET_ADDRESS,
  WS,
} from "./fixtures.ts";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const walletRef = { walletId: WALLET, address: WALLET_ADDRESS } as const;
const otherRef = { walletId: OTHER_WALLET, address: OTHER_WALLET_ADDRESS } as const;

// Written out by hand from RFC 8785 (keys in code-unit order, no whitespace, nested keys sorted
// too); the challenges were computed outside this code with
//   printf '%s\n%s' "askgina.os/v1/authorize" '<json>' | openssl dgst -sha256 -binary | basenc --base64url | tr -d '='
// Added with retiring and deleting. Every earlier vector is unchanged (digests.test.ts).
const RETIRE_ENVELOPE_JSON = `{"approvalId":"${APPROVAL}","destroyAfter":1700604800,"expiresAt":1700000600,"issuedAt":1700000000,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","type":"retire-wallet","v":1,"wallet":{"address":"${WALLET_ADDRESS}","walletId":"${WALLET}"},"workspaceId":"${WS}"}`;
const RETIRE_ENVELOPE_CHALLENGE = "sf-9sPBaI68XkcDwsMoRcvXRh0r9Hh-ZlGsDkt1mXSQ";
const DELETE_ENVELOPE_JSON = `{"approvalId":"${APPROVAL}","destroyAfter":1700604800,"expiresAt":1700000600,"issuedAt":1700000000,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","type":"delete-workspace","v":1,"wallets":[{"address":"${WALLET_ADDRESS}","walletId":"${WALLET}"},{"address":"${OTHER_WALLET_ADDRESS}","walletId":"${OTHER_WALLET}"}],"workspaceId":"${WS}"}`;
const DELETE_ENVELOPE_CHALLENGE = "Eh-cbJJV6jfq43fRilytGeljY5_IabAPNBhMfw-GHX4";

const challenge = (envelope: Envelope) =>
  Buffer.from(envelopeChallenge(envelope)).toString("base64url");

describe("retire-wallet", () => {
  it("is an envelope naming one wallet by id and address, and a destroy time", () => {
    expect(ok(RetireWalletEnvelope, retireWallet())).toBe(true);
    expect(ok(Envelope, retireWallet())).toBe(true);
    expect(ok(WalletRef, walletRef)).toBe(true);
  });

  it("refuses a destroy time that is not after issuedAt", () => {
    expect(ok(Envelope, retireWallet({ destroyAfter: T0 + 1 }))).toBe(true);
    for (const destroyAfter of [T0, T0 - 1]) {
      expect(ok(RetireWalletEnvelope, retireWallet({ destroyAfter }))).toBe(false);
      expect(ok(Envelope, retireWallet({ destroyAfter }))).toBe(false);
    }
  });

  it("refuses a wallet without its address, with another key, or a checksummed address", () => {
    for (const wallet of [
      { walletId: WALLET },
      { ...walletRef, label: "Operations" },
      { walletId: WALLET, address: "0x5555555555555555555555555555555555555555".toUpperCase() },
      { walletId: "agt_01jd0000000000000000000002", address: WALLET_ADDRESS },
    ]) {
      expect(ok(Envelope, { ...retireWallet(), wallet }), JSON.stringify(wallet)).toBe(false);
    }
  });

  it("refuses unknown keys, another kind's fields, and a missing destroy time", () => {
    expect(ok(Envelope, { ...retireWallet(), walletId: WALLET })).toBe(false);
    expect(ok(Envelope, { ...retireWallet(), wallets: [walletRef] })).toBe(false);
    expect(ok(Envelope, { ...retireWallet(), type: "delete-workspace" })).toBe(false);
    const { destroyAfter: _, ...withoutTime } = retireWallet();
    expect(ok(Envelope, withoutTime)).toBe(false);
  });
});

describe("delete-workspace", () => {
  it("is an envelope listing the workspace's wallets, possibly none", () => {
    expect(ok(DeleteWorkspaceEnvelope, deleteWorkspace())).toBe(true);
    expect(ok(Envelope, deleteWorkspace())).toBe(true);
    expect(ok(Envelope, deleteWorkspace({ wallets: [] }))).toBe(true);
  });

  it("refuses wallets that are not sorted by id, or listed twice", () => {
    expect(ok(Envelope, deleteWorkspace({ wallets: [otherRef, walletRef] }))).toBe(false);
    expect(ok(Envelope, deleteWorkspace({ wallets: [walletRef, walletRef] }))).toBe(false);
    // The same id at two addresses is still listed twice.
    expect(
      ok(Envelope, deleteWorkspace({ wallets: [walletRef, { walletId: WALLET, address: BOB }] })),
    ).toBe(false);
  });

  it("lists at most 256 wallets", () => {
    const ULID_CHARACTERS = "0123456789abcdefghjkmnpqrstvwxyz";
    const many = [...ULID_CHARACTERS].flatMap((first) =>
      [...ULID_CHARACTERS].map((second) => ({
        walletId: `wal_01jd00000000000000000000${first}${second}` as const,
        address: WALLET_ADDRESS,
      })),
    );
    expect(ok(Envelope, deleteWorkspace({ wallets: many.slice(0, 256) }))).toBe(true);
    expect(ok(Envelope, deleteWorkspace({ wallets: many.slice(0, 257) }))).toBe(false);
  });

  it("refuses a destroy time that is not after issuedAt", () => {
    for (const destroyAfter of [T0, T0 - 1]) {
      expect(ok(DeleteWorkspaceEnvelope, deleteWorkspace({ destroyAfter }))).toBe(false);
      expect(ok(Envelope, deleteWorkspace({ destroyAfter }))).toBe(false);
    }
  });

  it("refuses unknown keys and another kind's fields", () => {
    expect(ok(Envelope, { ...deleteWorkspace(), wallet: walletRef })).toBe(false);
    expect(ok(Envelope, { ...deleteWorkspace(), type: "retire-wallet" })).toBe(false);
    expect(ok(Envelope, { ...deleteWorkspace(), paused: true })).toBe(false);
  });
});

describe("walletsToDestroy", () => {
  it("names the one wallet of a retirement, every wallet of a deletion, none otherwise", () => {
    expect(walletsToDestroy(retireWallet())).toEqual([walletRef]);
    expect(walletsToDestroy(deleteWorkspace())).toEqual([walletRef, otherRef]);
    expect(walletsToDestroy(deleteWorkspace({ wallets: [] }))).toEqual([]);
    expect(walletsToDestroy(resumeWorkspace())).toEqual([]);
  });
});

describe("pinned digest vectors", () => {
  it("the retire-wallet challenge matches its vector", () => {
    expect(canonicalJson(retireWallet())).toBe(RETIRE_ENVELOPE_JSON);
    expect(challenge(retireWallet())).toBe(RETIRE_ENVELOPE_CHALLENGE);
  });

  it("the delete-workspace challenge matches its vector", () => {
    expect(canonicalJson(deleteWorkspace())).toBe(DELETE_ENVELOPE_JSON);
    expect(challenge(deleteWorkspace())).toBe(DELETE_ENVELOPE_CHALLENGE);
  });

  it("binds every wallet's id and address, the set, and the destroy time", () => {
    const retire = challenge(retireWallet());
    for (const wallet of [
      { walletId: OTHER_WALLET, address: WALLET_ADDRESS },
      { walletId: WALLET, address: OTHER_WALLET_ADDRESS },
    ]) {
      expect(challenge(retireWallet({ wallet }))).not.toBe(retire);
    }
    expect(challenge(retireWallet({ destroyAfter: T0 + DESTROY_DELAY - 1 }))).not.toBe(retire);

    const remove = challenge(deleteWorkspace());
    for (const wallets of [
      [],
      [walletRef],
      [otherRef],
      [walletRef, { walletId: OTHER_WALLET, address: BOB }],
      [walletRef, otherRef, { walletId: "wal_01jd000000000000000000000z" as const, address: BOB }],
    ]) {
      expect(challenge(deleteWorkspace({ wallets }))).not.toBe(remove);
    }
    expect(challenge(deleteWorkspace({ destroyAfter: T0 + 1 }))).not.toBe(remove);
  });

  it("refuses to hash an unsorted wallet set rather than hash it in another order", () => {
    expect(() => envelopeChallenge(deleteWorkspace({ wallets: [otherRef, walletRef] }))).toThrow();
  });
});

describe("an assertion over one kind does not verify as another", () => {
  const ORIGIN = "https://approve.os.example.com";
  const RP: RelyingParty = { id: "os.example.com", origins: [ORIGIN] };
  const device = new SoftAuthenticator();
  const { credential } = device.register({ rpId: RP.id, challenge: "c2V0dXA" });
  const approver = approverCredentialOf(USER_A, credential);

  const sign = (envelope: Envelope) =>
    assertEnvelope(device, {
      userId: USER_A,
      credentialId: approver.credentialId,
      envelope,
      origin: ORIGIN,
    });
  const verify = async (envelope: Envelope, signedOver: Envelope) => {
    const verdict = await verifyAuthorization({
      authorization: { envelope, assertions: [sign(signedOver)] },
      approvers: [approver],
      relyingParty: RP,
      threshold: 1,
      maxTtlSeconds: 3600,
      now: T0 + 10,
    });
    return verdict.ok ? "ok" : verdict.code;
  };

  it("each verifies for itself, and travels in the signer's authorized request", async () => {
    expect(await verify(retireWallet(), retireWallet())).toBe("ok");
    expect(await verify(deleteWorkspace(), deleteWorkspace())).toBe("ok");
    for (const envelope of [retireWallet(), deleteWorkspace()]) {
      const authorization = { envelope, assertions: [sign(envelope)] };
      expect(ok(AuthorizedRequest, { authorization })).toBe(true);
      expect(ok(AuthorizedRequest, { authorization, destroyAfter: T0 })).toBe(false);
    }
  });

  it("a retirement's approval is not a deletion's, nor the reverse, for the same wallet", async () => {
    const onlyWallet = deleteWorkspace({ wallets: [walletRef] });
    expect(await verify(onlyWallet, retireWallet())).toBe("assertion_invalid");
    expect(await verify(retireWallet(), onlyWallet)).toBe("assertion_invalid");
  });

  it("an approval for one wallet set or time does not cover another", async () => {
    expect(await verify(deleteWorkspace({ wallets: [walletRef] }), deleteWorkspace())).toBe(
      "assertion_invalid",
    );
    expect(
      await verify(
        retireWallet({ wallet: { walletId: OTHER_WALLET, address: WALLET_ADDRESS } }),
        retireWallet(),
      ),
    ).toBe("assertion_invalid");
    expect(await verify(retireWallet({ destroyAfter: T0 + 60 }), retireWallet())).toBe(
      "assertion_invalid",
    );
    expect(await verify(resumeWorkspace(), retireWallet())).toBe("assertion_invalid");
  });
});

describe("the signer contract", () => {
  const workspace = {
    workspaceId: WS,
    adminThreshold: 1,
    paused: false,
    approvers: [],
    state: "active",
    destroyAfter: null,
    minDestroyDelaySeconds: DESTROY_DELAY,
  };
  const wallet = {
    walletId: WALLET,
    workspaceId: WS,
    kind: "agent",
    label: "Operations",
    address: WALLET_ADDRESS,
    policy: null,
    policyHash: null,
    spent: [],
    venueSpent: [],
    state: "active",
    destroyAfter: null,
  };

  it("lists the lifecycle states", () => {
    expect(WorkspaceLifecycle.options).toEqual(["active", "deleting", "deleted"]);
    expect(WalletLifecycle.options).toEqual(["active", "retiring", "held", "destroyed"]);
  });

  it("a workspace has a destroy time exactly when it is not active", () => {
    const destroyAfter = T0 + DESTROY_DELAY;
    expect(ok(WorkspaceState, workspace)).toBe(true);
    expect(
      ok(WorkspaceState, { ...workspace, state: "deleting", paused: true, destroyAfter }),
    ).toBe(true);
    expect(ok(WorkspaceState, { ...workspace, state: "deleted", paused: true, destroyAfter })).toBe(
      true,
    );
    expect(ok(WorkspaceState, { ...workspace, destroyAfter })).toBe(false);
    expect(ok(WorkspaceState, { ...workspace, state: "deleting" })).toBe(false);
    expect(ok(WorkspaceState, { ...workspace, state: "removed" })).toBe(false);
    expect(ok(WorkspaceState, { ...workspace, minDestroyDelaySeconds: -1 })).toBe(false);
    const { state: _, ...withoutState } = workspace;
    expect(ok(WorkspaceState, withoutState)).toBe(false);
  });

  it("a wallet has a destroy time exactly when it is retiring or destroyed", () => {
    const destroyAfter = T0 + DESTROY_DELAY;
    expect(ok(WalletState, wallet)).toBe(true);
    expect(ok(WalletState, { ...wallet, state: "held" })).toBe(true);
    expect(ok(WalletState, { ...wallet, state: "retiring", destroyAfter })).toBe(true);
    expect(ok(WalletState, { ...wallet, state: "destroyed", destroyAfter })).toBe(true);
    expect(ok(WalletState, { ...wallet, state: "retiring" })).toBe(false);
    expect(ok(WalletState, { ...wallet, state: "held", destroyAfter })).toBe(false);
    expect(ok(WalletState, { ...wallet, destroyAfter })).toBe(false);
    const { destroyAfter: _, ...withoutTime } = wallet;
    expect(ok(WalletState, withoutTime)).toBe(false);
  });

  it("a wallet's cancel and finalize steps name only the workspace", () => {
    expect(ok(RetireWalletStepRequest, { workspaceId: WS })).toBe(true);
    expect(ok(RetireWalletStepRequest, { workspaceId: WS, destroyAfter: T0 })).toBe(false);
    expect(ok(RetireWalletStepRequest, {})).toBe(false);
  });

  it("serves six control-scope routes", () => {
    expect(
      [
        signerRoutes.retireWallet,
        signerRoutes.cancelRetireWallet,
        signerRoutes.finalizeRetireWallet,
        signerRoutes.deleteWorkspace,
        signerRoutes.cancelDeleteWorkspace,
        signerRoutes.finalizeDeleteWorkspace,
      ].map((route) => `${route.scope} ${route.method} ${route.path}`),
    ).toEqual([
      "control POST /v1/wallets/:walletId/retire",
      "control POST /v1/wallets/:walletId/retire/cancel",
      "control POST /v1/wallets/:walletId/retire/finalize",
      "control POST /v1/workspaces/:workspaceId/delete",
      "control POST /v1/workspaces/:workspaceId/delete/cancel",
      "control POST /v1/workspaces/:workspaceId/delete/finalize",
    ]);
  });

  it("refuses with six new codes: five are 403 and a finalize before its time is 409", () => {
    const codes = [
      "workspace_deleting",
      "workspace_deleted",
      "wallet_retired",
      "wallet_set_mismatch",
      "destroy_delay_out_of_range",
      "destroy_not_due",
    ] as const;
    for (const code of codes) expect(SignerErrorCode.options).toContain(code);
    expect(codes.map((code) => signerErrorStatus[code])).toEqual([403, 403, 403, 403, 403, 409]);
  });
});
