import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Intent,
  type Mandate,
  type MandateId,
  mandateHash,
  newId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { createTestVault, SCHEMA_VERSION, SchemaTooNewError } from "../src/index.ts";
import {
  approveIntent,
  authorize,
  CHAIN,
  Clock,
  ETH,
  grantMandate,
  grantRequest,
  header,
  intentFor,
  mandateFor,
  type Person,
  RECIPIENT,
  ROUTER,
  refused,
  replacePolicy,
  setUpWorld,
  startSigner,
  TOKEN,
  tokenIntent,
  txParams,
  useRequest,
  type World,
} from "./harness.ts";

/** An address on no list. */
const STRANGER = "0x00000000000000000000000000000000000000dd" as const;

const use = (world: World, mandateId: MandateId, intent: Intent) =>
  world.t.client.signUnderMandate(mandateId, useRequest(intent));

async function decisionsOf(world: World) {
  return (await world.t.client.listDecisions(world.workspaceId)).decisions;
}

describe("granting a mandate", () => {
  it("applies with assertions at the admin threshold, records who granted it, and answers a repeat with the same state", async () => {
    const t = startSigner();
    const world = await setUpWorld(t, { people: 2, adminThreshold: 2 });
    const [alice, bob] = world.people as [Person, Person];
    const mandate = mandateFor(world);

    await refused(
      t.client.grantMandate(mandate.id, grantRequest(world, mandate, [alice])),
      "insufficient_approvals",
    );
    const request = grantRequest(world, mandate, [alice, bob]);
    const state = await t.client.grantMandate(mandate.id, request);
    expect(state).toEqual({
      mandate,
      mandateHash: mandateHash(mandate),
      status: "active",
      grantApprovalId: request.authorization.envelope.approvalId,
      grantedAt: t.clock.value,
      grantedBy: [alice.userId, bob.userId].sort(),
      revokedAt: null,
      revokedReason: null,
      usage: {
        uses: 0,
        assets: [{ chainId: CHAIN, asset: TOKEN, total: "0", inWindow: "0" }],
      },
    });

    t.clock.value += 5;
    expect(await t.client.grantMandate(mandate.id, request)).toEqual(state);
    expect(await t.client.getMandate(mandate.id)).toEqual(state);
    expect(await t.client.listMandates(world.walletId)).toEqual({ mandates: [state] });
    await refused(t.client.getMandate(newId("mnd")), "not_found");
    await refused(t.client.listMandates(newId("wal")), "not_found");

    const decisions = await decisionsOf(world);
    expect(
      decisions.filter((d) => d.action === "grant-mandate").map((d) => [d.outcome, d.code]),
    ).toEqual([
      ["denied", "insufficient_approvals"],
      ["allowed", null],
    ]);
  });

  it("refuses a changed mandate, another path id, a reused nonce, an id under another grant, an unknown wallet and a wallet without a policy", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const people = world.people;
    const mandate = mandateFor(world);
    const request = grantRequest(world, mandate);

    // The approved hash names this mandate, not one with more uses.
    await refused(
      t.client.grantMandate(mandate.id, { ...request, mandate: { ...mandate, maxUses: 11 } }),
      "envelope_mismatch",
    );
    await refused(t.client.grantMandate(newId("mnd"), request), "envelope_mismatch");
    await t.client.grantMandate(mandate.id, request);

    // Another grant whose envelope reuses the applied one's nonce.
    const next = mandateFor(world);
    const fresh = grantRequest(world, next);
    await refused(
      t.client.grantMandate(next.id, {
        mandate: next,
        authorization: authorize(
          { ...fresh.authorization.envelope, nonce: request.authorization.envelope.nonce },
          people,
        ),
      }),
      "nonce_reused",
    );
    // The same mandate id under another approval.
    await refused(t.client.grantMandate(mandate.id, grantRequest(world, mandate)), "conflict");

    await refused(
      t.client.grantMandate(next.id, grantRequest(world, { ...next, walletId: newId("wal") })),
      "not_found",
    );
    const bare = await t.client.createWallet({
      workspaceId: world.workspaceId,
      walletId: newId("wal"),
      kind: "agent",
      label: "no policy yet",
    });
    const unpoliced = mandateFor(world, { walletId: bare.walletId });
    await refused(
      t.client.grantMandate(unpoliced.id, grantRequest(world, unpoliced)),
      "policy_missing",
    );
  });

  it("refuses with mandate_invalid each reason the mandate does not fit the policy, the clock or the signer's ceiling", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const now = t.clock.value;
    const token = (limits: { maxPerAction: string; maxPerWindow: string; maxTotal: string }) => [
      { chainId: CHAIN, asset: TOKEN, ...limits },
    ];
    const cases: { reason: string; changes: Partial<Mandate> }[] = [
      { reason: "requester_not_allowed", changes: { agentId: newId("agt") } },
      {
        reason: "chain_not_allowed",
        changes: {
          assets: [
            {
              chainId: "eip155:1",
              asset: "native",
              maxPerAction: "1",
              maxPerWindow: "1",
              maxTotal: "1",
            },
          ],
        },
      },
      {
        reason: "asset_not_allowed",
        changes: {
          assets: [
            {
              chainId: CHAIN,
              asset: STRANGER,
              maxPerAction: "1",
              maxPerWindow: "1",
              maxTotal: "1",
            },
          ],
        },
      },
      {
        reason: "over_per_tx_cap",
        changes: {
          assets: token({ maxPerAction: "1000001", maxPerWindow: "2000000", maxTotal: "3000000" }),
        },
      },
      {
        reason: "over_daily_cap",
        changes: {
          windowSeconds: 86_400,
          assets: token({ maxPerAction: "1000000", maxPerWindow: "5000001", maxTotal: "9000000" }),
        },
      },
      { reason: "over_fee_cap", changes: { maxFeePerActionWei: String(10n ** 16n + 1n) } },
      { reason: "already_expired", changes: { notBefore: now - 7200, notAfter: now } },
      { reason: "lifetime_too_long", changes: { notAfter: now + 604_801 } },
    ];
    for (const { reason, changes } of cases) {
      const mandate = mandateFor(world, changes);
      await refused(
        t.client.grantMandate(mandate.id, grantRequest(world, mandate)),
        "mandate_invalid",
        reason,
      );
    }

    // A window longer than a day may hold more than the policy's daily cap; each use still meets it.
    const weekly = await grantMandate(world, {
      windowSeconds: 172_800,
      assets: token({ maxPerAction: "1000000", maxPerWindow: "5000001", maxTotal: "9000000" }),
    });
    expect(weekly.state.status).toBe("active");
    // Seven days, counted from the start when it is later than now.
    const later = await grantMandate(world, {
      notBefore: now + 3600,
      notAfter: now + 3600 + 604_800,
    });
    expect(later.state.status).toBe("not_yet_valid");

    // A recipient outside the policy's own allowlist.
    world.policy = await replacePolicy(world, {
      recipients: { mode: "allowlist", addresses: [RECIPIENT] },
    });
    const outside = mandateFor(world, { recipients: [RECIPIENT, STRANGER] });
    await refused(
      t.client.grantMandate(outside.id, grantRequest(world, outside)),
      "mandate_invalid",
      "recipient_not_allowed",
    );
  });

  it("refuses a grant past the cap on live mandates per wallet until one of them ends", async () => {
    const t = startSigner({ maxLiveMandatesPerWallet: 2 });
    const world = await setUpWorld(t);
    const first = await grantMandate(world);
    await grantMandate(world, { notAfter: t.clock.value + 3600 });
    const third = mandateFor(world);
    await refused(
      t.client.grantMandate(third.id, grantRequest(world, third)),
      "mandate_invalid",
      "too_many_live_mandates",
    );
    // One that expired no longer counts, and neither does one that was revoked.
    t.clock.value += 3600;
    const fourth = await grantMandate(world);
    expect(fourth.state.status).toBe("active");
    await refused(
      t.client.grantMandate(third.id, grantRequest(world, third)),
      "mandate_invalid",
      "too_many_live_mandates",
    );
    await t.client.revokeMandate(first.mandate.id, world.workspaceId);
    expect((await t.client.grantMandate(third.id, grantRequest(world, third))).status).toBe(
      "active",
    );
  });
});

describe("signing under a mandate", () => {
  it("signs a transfer to a listed recipient with no assertions, once per use id, and counts it once", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const { mandate } = await grantMandate(world);
    const intent = tokenIntent(world, 500_000n);
    const request = useRequest(intent);

    const signed = await t.client.signUnderMandate(mandate.id, request);
    expect(signed.from).toBe(world.address);
    const recovered = await recoverTransactionAddress({
      serializedTransaction: signed.signedTransaction as `0x02${string}`,
    });
    expect(recovered.toLowerCase()).toBe(world.address);
    const transaction = parseTransaction(signed.signedTransaction);
    expect(transaction.to).toBe(TOKEN);
    const call = decodeFunctionData({ abi: erc20Abi, data: transaction.data ?? "0x" });
    expect(call.functionName).toBe("transfer");
    expect(call.args.map((arg) => (typeof arg === "string" ? arg.toLowerCase() : arg))).toEqual([
      RECIPIENT,
      500_000n,
    ]);

    // A retry returns the same transaction, even with other fees, and counts nothing more.
    expect(
      await t.client.signUnderMandate(mandate.id, { ...request, transaction: txParams() }),
    ).toEqual(signed);
    const state = await t.client.getMandate(mandate.id);
    expect(state.usage).toEqual({
      uses: 1,
      assets: [{ chainId: CHAIN, asset: TOKEN, total: "500000", inWindow: "500000" }],
    });
    expect(await t.client.getApproval(request.approvalId)).toEqual({
      approvalId: request.approvalId,
      state: "signed",
      transactionHash: signed.transactionHash,
      attempts: [
        expect.objectContaining({
          attempt: 0,
          kind: "original",
          transactionHash: signed.transactionHash,
        }),
      ],
    });
    // Mandated spending is the wallet's spending.
    expect((await t.client.getWallet(world.walletId)).spent).toEqual([
      { chainId: CHAIN, asset: TOKEN, amount: "500000" },
    ]);

    // Another intent under the used id, and the same intent under a new id.
    await refused(
      t.client.signUnderMandate(mandate.id, {
        ...request,
        intent: tokenIntent(world, 1n),
      }),
      "conflict",
    );
    await refused(t.client.signUnderMandate(mandate.id, useRequest(intent)), "conflict");
    // An approval id the signer acted on for a person is not a use either.
    const paid = intentFor(world);
    const authorization = approveIntent(world, paid);
    await t.client.sign({ intent: paid, authorization, transaction: txParams() });
    await refused(
      t.client.signUnderMandate(mandate.id, {
        approvalId: authorization.envelope.approvalId,
        intent: tokenIntent(world, 1n),
        transaction: txParams(),
      }),
      "conflict",
    );
    // A use id revoked before it was signed.
    const revokedUse = useRequest(tokenIntent(world, 1n));
    await t.client.revokeApproval(revokedUse.approvalId, world.workspaceId);
    await refused(t.client.signUnderMandate(mandate.id, revokedUse), "approval_revoked");
    await refused(t.client.signUnderMandate(newId("mnd"), useRequest(intent)), "not_found");
    expect((await t.client.getMandate(mandate.id)).usage.uses).toBe(1);
  });

  it("refuses with mandate_denied whatever the mandate does not cover, after the policy allowed it", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const helper = newId("agt");
    world.policy = await replacePolicy(world, {
      requesters: [world.agentId, helper].sort(),
    });
    const { mandate } = await grantMandate(world, { maxFeePerActionWei: String(10n ** 14n) });
    const cheap = (intent: Intent): Intent => ({ ...intent, maxFeeWei: String(10n ** 14n) });
    const cases: [Intent, string][] = [
      [{ ...cheap(tokenIntent(world, 1n)), agentId: helper }, "mandate_agent_mismatch"],
      // A contract call is never signed under a mandate, not even one that moves no coin.
      [
        cheap(
          intentFor(world, { type: "evm.call", to: ROUTER, valueWei: "0", data: "0x12345678" }),
        ),
        "mandate_operation_not_allowed",
      ],
      [
        cheap(intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "1" })),
        "mandate_asset_not_allowed",
      ],
      [cheap(tokenIntent(world, 1n, STRANGER)), "mandate_recipient_not_allowed"],
      [tokenIntent(world, 1n), "mandate_over_fee_cap"],
      [cheap(tokenIntent(world, 500_001n)), "mandate_over_per_action_cap"],
    ];
    for (const [intent, code] of cases) {
      await refused(use(world, mandate.id, intent), "mandate_denied", code);
    }
    // An intent for another wallet or workspace fails the wallet's policy first.
    await refused(
      use(world, mandate.id, { ...cheap(tokenIntent(world, 1n)), walletId: newId("wal") }),
      "policy_denied",
      "wallet_mismatch",
    );
    await refused(
      use(world, mandate.id, { ...cheap(tokenIntent(world, 1n)), workspaceId: newId("ws") }),
      "policy_denied",
      "wallet_mismatch",
    );
    expect((await t.client.getMandate(mandate.id)).usage.uses).toBe(0);
    const denied = (await decisionsOf(world)).filter(
      (d) => d.action === "sign-under-mandate" && d.outcome === "denied",
    );
    expect(denied.map((d) => d.code)).toEqual([
      ...cases.map(() => "mandate_denied"),
      "policy_denied",
      "policy_denied",
    ]);

    // The use count holds for the mandate's life.
    const once = await grantMandate(world, { maxUses: 1 });
    await use(world, once.mandate.id, tokenIntent(world, 1n));
    await refused(
      use(world, once.mandate.id, tokenIntent(world, 1n)),
      "mandate_denied",
      "mandate_uses_exhausted",
    );
    expect((await t.client.getMandate(once.mandate.id)).status).toBe("exhausted");
  });

  it("counts the window over the last windowSeconds and the total over the mandate's life", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const { mandate } = await grantMandate(world);
    await use(world, mandate.id, tokenIntent(world, 500_000n));
    await use(world, mandate.id, tokenIntent(world, 500_000n));
    await refused(
      use(world, mandate.id, tokenIntent(world, 1n)),
      "mandate_denied",
      "mandate_over_window_cap",
    );
    t.clock.value += 3599;
    await refused(
      use(world, mandate.id, tokenIntent(world, 1n)),
      "mandate_denied",
      "mandate_over_window_cap",
    );
    expect((await t.client.getMandate(mandate.id)).usage).toEqual({
      uses: 2,
      assets: [{ chainId: CHAIN, asset: TOKEN, total: "1000000", inWindow: "1000000" }],
    });

    // A full window after them, both uses have left it.
    t.clock.value += 1;
    await use(world, mandate.id, tokenIntent(world, 500_000n));
    await refused(
      use(world, mandate.id, tokenIntent(world, 1n)),
      "mandate_denied",
      "mandate_over_total_cap",
    );
    const state = await t.client.getMandate(mandate.id);
    expect(state.status).toBe("exhausted");
    expect(state.usage).toEqual({
      uses: 3,
      assets: [{ chainId: CHAIN, asset: TOKEN, total: "1500000", inWindow: "500000" }],
    });
  });

  it("keeps the wallet's policy as the outer limit, and counts mandated spending in its daily cap", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const native = (wei: bigint) =>
      intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: String(wei) });
    const { mandate } = await grantMandate(world, {
      windowSeconds: 172_800,
      assets: [
        {
          chainId: CHAIN,
          asset: "native",
          maxPerAction: String(ETH),
          maxPerWindow: String(3n * ETH),
          maxTotal: String(3n * ETH),
        },
      ],
    });

    await use(world, mandate.id, native(ETH));
    // The mandate allows another ether; the policy's 1.5 ether a day does not.
    await refused(use(world, mandate.id, native(ETH)), "policy_denied", "over_daily_cap");
    // What was signed under the mandate counts against a person's approval too.
    const extra = native((ETH * 6n) / 10n);
    await refused(
      t.client.sign({
        intent: extra,
        authorization: approveIntent(world, extra),
        transaction: txParams(),
      }),
      "policy_denied",
      "over_daily_cap",
    );

    // Lowering the policy narrows the mandate at once.
    world.policy = await replacePolicy(world, {
      assets: [
        { chainId: CHAIN, asset: TOKEN, maxPerTx: "1000000", maxPerDay: "5000000" },
        {
          chainId: CHAIN,
          asset: "native",
          maxPerTx: String((ETH * 4n) / 10n),
          maxPerDay: String((ETH * 3n) / 2n),
        },
      ],
    });
    await refused(use(world, mandate.id, native(ETH / 2n)), "policy_denied", "over_per_tx_cap");
    const fits = await use(world, mandate.id, native((ETH * 4n) / 10n));
    expect(fits.from).toBe(world.address);
    expect((await t.client.getMandate(mandate.id)).usage.uses).toBe(2);
  });

  it("signs only from notBefore and until just before notAfter", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const start = t.clock.value + 600;
    const { mandate, state } = await grantMandate(world, {
      notBefore: start,
      notAfter: start + 600,
    });
    expect(state.status).toBe("not_yet_valid");
    await refused(use(world, mandate.id, tokenIntent(world, 1n)), "mandate_not_yet_valid");

    t.clock.value = start;
    await use(world, mandate.id, tokenIntent(world, 1n));
    t.clock.value = start + 599;
    await use(world, mandate.id, tokenIntent(world, 1n));
    expect((await t.client.getMandate(mandate.id)).status).toBe("active");

    t.clock.value = start + 600;
    await refused(use(world, mandate.id, tokenIntent(world, 1n)), "mandate_expired");
    expect((await t.client.getMandate(mandate.id)).status).toBe("expired");
  });

  it("refuses a use while the workspace is paused, but still returns one already signed", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const { mandate } = await grantMandate(world);
    const first = useRequest(tokenIntent(world, 1n));
    const signed = await t.client.signUnderMandate(mandate.id, first);

    await t.client.pauseWorkspace(world.workspaceId);
    await refused(use(world, mandate.id, tokenIntent(world, 1n)), "workspace_paused");
    expect(
      await t.client.signUnderMandate(mandate.id, { ...first, transaction: txParams() }),
    ).toEqual(signed);
  });

  it("lets two concurrent uses against a window cap that fits one produce exactly one signature", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const { mandate } = await grantMandate(world, {
      assets: [
        {
          chainId: CHAIN,
          asset: TOKEN,
          maxPerAction: "600000",
          maxPerWindow: "1000000",
          maxTotal: "1500000",
        },
      ],
    });
    const outcomes = await Promise.allSettled([
      use(world, mandate.id, tokenIntent(world, 600_000n)),
      use(world, mandate.id, tokenIntent(world, 600_000n)),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(SignerError);
    expect([(rejected[0] as SignerError).code, (rejected[0] as SignerError).detail]).toEqual([
      "mandate_denied",
      "mandate_over_window_cap",
    ]);
    expect((await t.client.getMandate(mandate.id)).usage.uses).toBe(1);
  });
});

describe("ending a mandate", () => {
  it("revokes on request with no passkey, for good, once, and only from its own workspace", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const other = await setUpWorld(t);
    const mandate = mandateFor(world);
    const grant = grantRequest(world, mandate);
    await t.client.grantMandate(mandate.id, grant);
    const first = useRequest(tokenIntent(world, 1n));
    const signed = await t.client.signUnderMandate(mandate.id, first);

    await refused(t.client.revokeMandate(mandate.id, other.workspaceId), "not_found");
    await refused(t.client.revokeMandate(mandate.id, newId("ws")), "not_found");
    await refused(t.client.revokeMandate(newId("mnd"), world.workspaceId), "not_found");

    const revoked = await t.client.revokeMandate(mandate.id, world.workspaceId);
    expect(revoked).toMatchObject({
      status: "revoked",
      revokedAt: t.clock.value,
      revokedReason: "requested",
    });
    t.clock.value += 10;
    expect(await t.client.revokeMandate(mandate.id, world.workspaceId)).toEqual(revoked);
    await refused(use(world, mandate.id, tokenIntent(world, 1n)), "mandate_revoked");
    // A use already signed stays signed.
    expect(
      await t.client.signUnderMandate(mandate.id, { ...first, transaction: txParams() }),
    ).toEqual(signed);
    // There is no resume: repeating the grant answers with the revoked mandate.
    expect((await t.client.grantMandate(mandate.id, grant)).status).toBe("revoked");

    const decisions = await decisionsOf(world);
    expect(decisions.filter((d) => d.action === "revoke-mandate")).toEqual([
      expect.objectContaining({
        approvalId: grant.authorization.envelope.approvalId,
        outcome: "allowed",
      }),
    ]);
    expect(decisions.filter((d) => d.outcome === "denied").map((d) => [d.action, d.code])).toEqual([
      ["sign-under-mandate", "mandate_revoked"],
    ]);
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: true, brokenAt: null });
    expect((await decisionsOf(other)).some((d) => d.action === "revoke-mandate")).toBe(false);
  });

  it("revokes every mandate a removed passkey granted, in the removal itself, and no other", async () => {
    const t = startSigner();
    const world = await setUpWorld(t, { people: 3 });
    const [alice, bob, carol] = world.people as [Person, Person, Person];
    const byAlice = await grantMandate(world, {}, [alice]);
    const byBob = await grantMandate(world, {}, [bob]);
    const removal = (person: Person, by: Person) =>
      authorize(
        {
          ...header(t.clock, newId("apr"), world.workspaceId),
          type: "remove-approver",
          userId: person.userId,
          credentialId: person.credential.credentialId,
        },
        [by],
      );

    await t.client.removeApprover(world.workspaceId, removal(carol, bob));
    expect((await t.client.getMandate(byAlice.mandate.id)).status).toBe("active");

    const removeAlice = removal(alice, bob);
    await t.client.removeApprover(world.workspaceId, removeAlice);
    expect(await t.client.getMandate(byAlice.mandate.id)).toMatchObject({
      status: "revoked",
      revokedAt: t.clock.value,
      revokedReason: "grantor_removed",
    });
    expect((await t.client.getMandate(byBob.mandate.id)).status).toBe("active");
    await refused(use(world, byAlice.mandate.id, tokenIntent(world, 1n)), "mandate_revoked");
    await use(world, byBob.mandate.id, tokenIntent(world, 1n));

    // Recorded next to the removal, which committed with it.
    const decisions = await decisionsOf(world);
    const removed = decisions.findIndex(
      (d) => d.action === "remove-approver" && d.approvalId === removeAlice.envelope.approvalId,
    );
    expect(decisions[removed - 1]).toMatchObject({
      action: "revoke-mandate-on-grantor-removal",
      approvalId: byAlice.state.grantApprovalId,
      outcome: "allowed",
    });
    expect(decisions.filter((d) => d.action === "revoke-mandate-on-grantor-removal")).toHaveLength(
      1,
    );
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: true, brokenAt: null });
  });

  it("stops the uses of a mandate whose grantors are fewer than a raised admin threshold", async () => {
    const t = startSigner();
    const world = await setUpWorld(t, { people: 2 });
    const [alice, bob] = world.people as [Person, Person];
    const { mandate } = await grantMandate(world, {}, [alice]);
    await use(world, mandate.id, tokenIntent(world, 1n));

    await t.client.setAdminThreshold(
      world.workspaceId,
      authorize(
        {
          ...header(t.clock, newId("apr"), world.workspaceId),
          type: "set-admin-threshold",
          adminThreshold: 2,
        },
        [alice],
      ),
    );
    await refused(
      use(world, mandate.id, tokenIntent(world, 1n)),
      "mandate_denied",
      "mandate_grant_below_threshold",
    );
    // One granted by both people works under the new threshold.
    const both = await grantMandate(world, {}, [alice, bob]);
    await use(world, both.mandate.id, tokenIntent(world, 1n));
  });

  it("revokes every live mandate when the restore fence is set; a grant after the fence works", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const mandate = mandateFor(world);
    const grant = grantRequest(world, mandate);
    await t.client.grantMandate(mandate.id, grant);
    const first = useRequest(tokenIntent(world, 1n));
    const signed = await t.client.signUnderMandate(mandate.id, first);
    // One that already ended stays as it was.
    const ended = await grantMandate(world, { notAfter: t.clock.value + 3600 });

    t.clock.value += 3600;
    t.signer.fence();
    expect(await t.client.getMandate(mandate.id)).toMatchObject({
      status: "revoked",
      revokedAt: t.clock.value,
      revokedReason: "operator",
    });
    expect((await t.client.getMandate(ended.mandate.id)).status).toBe("expired");
    await refused(use(world, mandate.id, tokenIntent(world, 1n)), "mandate_revoked");
    expect(
      await t.client.signUnderMandate(mandate.id, { ...first, transaction: txParams() }),
    ).toEqual(signed);
    const decisions = await decisionsOf(world);
    expect(decisions.filter((d) => d.action === "revoke-mandate-on-fence")).toEqual([
      expect.objectContaining({ approvalId: grant.authorization.envelope.approvalId }),
    ]);

    // Grants issued inside the fence's clock skew are fenced like every envelope.
    const early = mandateFor(world);
    await refused(t.client.grantMandate(early.id, grantRequest(world, early)), "envelope_fenced");
    t.clock.value += 30;
    const again = await grantMandate(world);
    expect(again.state.status).toBe("active");
    await use(world, again.mandate.id, tokenIntent(world, 1n));
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: true, brokenAt: null });
  });
});

describe("the database's schema version 5", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const userVersion = (path: string) => {
    const db = new DatabaseSync(path);
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    db.close();
    return user_version;
  };

  it("a version 4 file gains the mandate tables, keeps its signatures and signs under a new mandate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-signer-mandates-"));
    dirs.push(dir);
    const sqlitePath = join(dir, "signer.sqlite");
    const host = {
      sqlitePath,
      clock: new Clock(),
      vault: createTestVault(),
      tokenKey: randomBytes(32),
    };
    let t = startSigner(host);
    const world = await setUpWorld(t);
    const intent = intentFor(world);
    const request = {
      intent,
      authorization: approveIntent(world, intent),
      transaction: txParams(),
    };
    const signed = await t.client.sign(request);
    t.signer.close();

    // What a signer at version 4 left behind.
    const old = new DatabaseSync(sqlitePath);
    old.exec(
      "DROP TABLE mandate_uses; DROP TABLE mandate_grantors; DROP TABLE mandates; PRAGMA user_version = 4;",
    );
    old.close();

    t = startSigner(host);
    const upgraded: World = { ...world, t };
    expect(await t.client.sign({ ...request, transaction: txParams() })).toEqual(signed);
    const { mandate } = await grantMandate(upgraded);
    expect((await use(upgraded, mandate.id, tokenIntent(upgraded, 1n))).from).toBe(world.address);
    t.signer.close();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect(userVersion(sqlitePath)).toBe(SCHEMA_VERSION);

    // A signer that knows only version 4 refuses this file, as this one refuses a newer file.
    const newer = new DatabaseSync(sqlitePath);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    expect(() => startSigner(host)).toThrow(SchemaTooNewError);
  });
});
