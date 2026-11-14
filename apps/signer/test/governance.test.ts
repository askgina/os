import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId, policyHash, type WalletPolicy } from "@askgina/os-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveIntent,
  authorize,
  header,
  intentFor,
  newPerson,
  type Person,
  refused,
  setUpWorld,
  startSigner,
  txParams,
  type World,
} from "./harness.ts";

function nextPolicy(world: World, change: Partial<WalletPolicy> = {}): WalletPolicy {
  return {
    ...world.policy,
    revision: world.policy.revision + 1,
    previousHash: policyHash(world.policy),
    ...change,
  };
}

function setPolicyAuthorization(
  world: World,
  policy: WalletPolicy,
  previous: string | null,
  people: readonly Person[] = world.people,
) {
  return authorize(
    {
      ...header(world.t.clock, newId("apr"), world.workspaceId),
      type: "set-policy",
      walletId: world.walletId,
      policyHash: policyHash(policy),
      previousPolicyHash: previous,
    },
    people,
  );
}

describe("workspaces and wallets", () => {
  it("creates workspaces and wallets idempotently and refuses a conflicting repeat", async () => {
    const t = startSigner();
    const alice = newPerson();
    const workspaceId = newId("ws");
    const request = { workspaceId, adminThreshold: 1, approvers: [alice.credential] };
    const first = await t.client.createWorkspace(request);
    expect(await t.client.createWorkspace(request)).toEqual(first);
    await refused(
      t.client.createWorkspace({
        ...request,
        adminThreshold: 1,
        approvers: [newPerson().credential],
      }),
      "conflict",
    );

    const walletId = newId("wal");
    const wallet = { workspaceId, walletId, kind: "agent" as const, label: "a" };
    const created = await t.client.createWallet(wallet);
    expect(created.policy).toBeNull();
    expect(await t.client.createWallet(wallet)).toEqual(created);
    await refused(t.client.createWallet({ ...wallet, label: "b" }), "conflict");
  });

  it("refuses a workspace whose admin threshold its approvers cannot meet", async () => {
    const t = startSigner();
    await refused(
      t.client.createWorkspace({
        workspaceId: newId("ws"),
        adminThreshold: 2,
        approvers: [newPerson().credential],
      }),
      "threshold_unreachable",
    );
  });

  it("answers not_found for workspaces, wallets and approvals it does not hold", async () => {
    const t = startSigner();
    await refused(t.client.getWorkspace(newId("ws")), "not_found");
    await refused(t.client.getWallet(newId("wal")), "not_found");
    expect((await t.client.getApproval(newId("apr"))).state).toBe("unknown");
  });
});

describe("policy changes", () => {
  it("accepts the next revision of the chain and records it as applied", async () => {
    const world = await setUpWorld(startSigner());
    const next = nextPolicy(world, { fees: { maxPerTxWei: "1" } });
    const authorization = setPolicyAuthorization(world, next, policyHash(world.policy));
    const wallet = await world.t.client.setPolicy(world.walletId, { policy: next, authorization });
    expect(wallet.policyHash).toBe(policyHash(next));
    // Repeating the identical request is a no-op, not a second change.
    expect(await world.t.client.setPolicy(world.walletId, { policy: next, authorization })).toEqual(
      wallet,
    );
    expect((await world.t.client.getApproval(authorization.envelope.approvalId)).state).toBe(
      "applied",
    );
  });

  it("refuses a stale previous hash, a broken chain, a mismatched hash and an unmeetable threshold", async () => {
    const world = await setUpWorld(startSigner());
    const current = policyHash(world.policy);
    const next = nextPolicy(world);
    await refused(
      world.t.client.setPolicy(world.walletId, {
        policy: next,
        authorization: setPolicyAuthorization(world, next, null),
      }),
      "policy_changed",
    );
    const skipped = nextPolicy(world, { revision: 3 });
    await refused(
      world.t.client.setPolicy(world.walletId, {
        policy: skipped,
        authorization: setPolicyAuthorization(world, skipped, current),
      }),
      "policy_invalid",
    );
    await refused(
      world.t.client.setPolicy(world.walletId, {
        policy: nextPolicy(world, { fees: { maxPerTxWei: "5" } }),
        authorization: setPolicyAuthorization(world, next, current),
      }),
      "envelope_mismatch",
    );
    const twoPeople = nextPolicy(world, { approvals: { threshold: 2, ttlSeconds: 600 } });
    await refused(
      world.t.client.setPolicy(world.walletId, {
        policy: twoPeople,
        authorization: setPolicyAuthorization(world, twoPeople, current),
      }),
      "threshold_unreachable",
    );
  });

  it("refuses an admin authorization signed under a threshold that was raised since", async () => {
    const world = await setUpWorld(startSigner(), { people: 2 });
    const next = nextPolicy(world);
    const signedByOne = setPolicyAuthorization(
      world,
      next,
      policyHash(world.policy),
      world.people.slice(0, 1),
    );
    await world.t.client.setAdminThreshold(
      world.workspaceId,
      authorize(
        {
          ...header(world.t.clock, newId("apr"), world.workspaceId),
          type: "set-admin-threshold",
          adminThreshold: 2,
        },
        world.people.slice(0, 1),
      ),
    );
    await refused(
      world.t.client.setPolicy(world.walletId, { policy: next, authorization: signedByOne }),
      "insufficient_approvals",
    );
    await refused(
      world.t.client.setAdminThreshold(
        world.workspaceId,
        authorize(
          {
            ...header(world.t.clock, newId("apr"), world.workspaceId),
            type: "set-admin-threshold",
            adminThreshold: 3,
          },
          world.people,
        ),
      ),
      "threshold_unreachable",
    );
  });
});

describe("approvers and recovery", () => {
  it("adds an approver only with an existing approver's passkey", async () => {
    const world = await setUpWorld(startSigner());
    const carol = newPerson();
    const addCarol = (people: Person[]) =>
      authorize(
        {
          ...header(world.t.clock, newId("apr"), world.workspaceId),
          type: "add-approver",
          userId: carol.userId,
          credentialId: carol.credential.credentialId,
          publicKey: carol.credential.publicKey,
        },
        people,
      );
    await refused(
      world.t.client.addApprover(world.workspaceId, { authorization: addCarol([carol]) }),
      "approver_unknown",
    );
    const state = await world.t.client.addApprover(world.workspaceId, {
      authorization: addCarol(world.people),
    });
    expect(state.approvers.map((approver) => approver.userId)).toContain(carol.userId);
  });

  it("refuses to remove an approver when the thresholds would become unreachable", async () => {
    const world = await setUpWorld(startSigner(), { people: 2, policyThreshold: 2 });
    const [alice, bob] = world.people as [Person, Person];
    await refused(
      world.t.client.removeApprover(
        world.workspaceId,
        authorize(
          {
            ...header(world.t.clock, newId("apr"), world.workspaceId),
            type: "remove-approver",
            userId: bob.userId,
            credentialId: bob.credential.credentialId,
          },
          [alice],
        ),
      ),
      "threshold_unreachable",
    );
  });

  it("recovers a workspace whose passkeys are lost: a single-use code enrolls a new approver", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [lost] = world.people as [Person];
    const replacement = newPerson();
    const code = t.signer.issueRecoveryCode(world.workspaceId);

    await refused(
      world.t.client.addApprover(newId("ws"), {
        recovery: { code },
        approver: replacement.credential,
      }),
      "not_found",
    );
    await world.t.client.addApprover(world.workspaceId, {
      recovery: { code },
      approver: replacement.credential,
    });
    await refused(
      world.t.client.addApprover(world.workspaceId, {
        recovery: { code },
        approver: newPerson().credential,
      }),
      "recovery_code_invalid",
    );

    // The new approver removes the lost passkey; the wallet and its key are untouched.
    await world.t.client.removeApprover(
      world.workspaceId,
      authorize(
        {
          ...header(world.t.clock, newId("apr"), world.workspaceId),
          type: "remove-approver",
          userId: lost.userId,
          credentialId: lost.credential.credentialId,
        },
        [replacement],
      ),
    );
    const wallet = await world.t.client.getWallet(world.walletId);
    expect(wallet.address).toBe(world.address);
    const intent = intentFor(world);
    const signed = await world.t.client.sign({
      intent,
      authorization: approveIntent(world, intent, { people: [replacement] }),
      transaction: txParams(),
    });
    expect(signed.from).toBe(world.address);
    const byLost = intentFor(world);
    await refused(
      world.t.client.sign({
        intent: byLost,
        authorization: approveIntent(world, byLost, { people: [lost] }),
        transaction: txParams(),
      }),
      "approver_unknown",
    );
  });

  it("refuses an expired recovery code and a code for another workspace", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const other = await setUpWorld(t);
    const expired = t.signer.issueRecoveryCode(world.workspaceId);
    t.clock.value += 15 * 60;
    await refused(
      t.client.addApprover(world.workspaceId, {
        recovery: { code: expired },
        approver: newPerson().credential,
      }),
      "recovery_code_invalid",
    );
    const foreign = t.signer.issueRecoveryCode(other.workspaceId);
    await refused(
      t.client.addApprover(world.workspaceId, {
        recovery: { code: foreign },
        approver: newPerson().credential,
      }),
      "recovery_code_invalid",
    );
  });
});

describe("decision log", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("records allowed and denied decisions with codes, never intent contents, and detects an edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbuild-signer-log-"));
    dirs.push(dir);
    const sqlitePath = join(dir, "signer.sqlite");
    const t = startSigner({ sqlitePath });
    const world = await setUpWorld(t);
    const marker = "MARKER-memo-7f3a";
    const intent = intentFor(world, undefined, marker);
    await t.client.sign({
      intent,
      authorization: approveIntent(world, intent),
      transaction: txParams(),
    });
    await t.client.pauseWorkspace(world.workspaceId);
    const blocked = intentFor(world);
    await refused(
      t.client.sign({
        intent: blocked,
        authorization: approveIntent(world, blocked),
        transaction: txParams(),
      }),
      "workspace_paused",
    );

    const { decisions } = await t.client.listDecisions(world.workspaceId);
    expect(decisions.map((d) => [d.action, d.outcome, d.code])).toEqual([
      ["create-workspace", "allowed", null],
      ["create-wallet", "allowed", null],
      ["set-policy", "allowed", null],
      ["sign", "allowed", null],
      ["pause-workspace", "allowed", null],
      ["sign", "denied", "workspace_paused"],
    ]);
    expect(
      (await t.client.listDecisions(world.workspaceId, { after: 4, limit: 1 })).decisions.map(
        (d) => d.seq,
      ),
    ).toEqual([5]);
    expect(JSON.stringify(decisions)).not.toContain(marker);
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: true, brokenAt: null });

    const editor = new DatabaseSync(sqlitePath);
    editor
      .prepare(
        "UPDATE decisions SET outcome = 'allowed', code = NULL WHERE workspace_id = ? AND seq = 6",
      )
      .run(world.workspaceId);
    editor.close();
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: false, brokenAt: 6 });
    t.signer.close();
  });
});
