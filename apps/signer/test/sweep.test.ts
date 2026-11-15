import {
  type Address,
  type Authorization,
  newId,
  policyHash,
  type Sweep,
  sweepHash,
  type WalletPolicy,
} from "@askgina/os-protocol";
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  approveIntent,
  authorize,
  CHAIN,
  ETH,
  header,
  intentFor,
  type Person,
  refused,
  setUpWorld,
  startSigner,
  TOKEN,
  txParams,
  type World,
} from "./harness.ts";

const ALLOWED = "0x00000000000000000000000000000000000000dd" as const;
const STRANGER = "0x00000000000000000000000000000000000000ee" as const;

/** Replace the wallet's policy with one that allows sending only to `addresses`. */
async function allowOnly(world: World, addresses: Address[]): Promise<World> {
  const policy: WalletPolicy = {
    ...world.policy,
    revision: world.policy.revision + 1,
    previousHash: policyHash(world.policy),
    recipients: { mode: "allowlist", addresses },
  };
  await world.t.client.setPolicy(world.walletId, {
    policy,
    authorization: authorize(
      {
        ...header(world.t.clock, newId("apr"), world.workspaceId),
        type: "set-policy",
        walletId: world.walletId,
        policyHash: policyHash(policy),
        previousPolicyHash: policyHash(world.policy),
      },
      world.people,
    ),
  });
  return { ...world, policy };
}

async function treasuryOf(world: World): Promise<Address> {
  const treasury = await world.t.client.createWallet({
    workspaceId: world.workspaceId,
    walletId: newId("wal"),
    kind: "treasury",
    label: "treasury",
  });
  return treasury.address;
}

function sweepOf(world: World, overrides: Partial<Sweep> = {}): Sweep {
  return {
    v: 1,
    workspaceId: world.workspaceId,
    walletId: world.walletId,
    chainId: CHAIN,
    asset: "native",
    amount: String(3n * ETH),
    to: ALLOWED,
    maxFeeWei: String(10n ** 15n),
    ...overrides,
  };
}

function approveSweep(world: World, sweep: Sweep, people?: Person[]): Authorization {
  return authorize(
    {
      ...header(world.t.clock, newId("apr"), world.workspaceId),
      type: "sweep-wallet",
      walletId: sweep.walletId,
      chainId: sweep.chainId,
      sweepHash: sweepHash(sweep),
    },
    people ?? world.people,
  );
}

describe("sweeping a wallet", () => {
  it("sends the approved amount to an allowlisted address once, and a repeat returns the same transaction", async () => {
    const world = await allowOnly(await setUpWorld(startSigner()), [ALLOWED]);
    // Above the wallet's per-transaction and daily caps: a sweep is not capped.
    const sweep = sweepOf(world);
    const request = { sweep, authorization: approveSweep(world, sweep), transaction: txParams() };

    const first = await world.t.client.sweep(world.walletId, request);
    const tx = parseTransaction(first.signedTransaction);
    expect(tx.to).toBe(ALLOWED);
    expect(tx.value).toBe(3n * ETH);
    expect(tx.data).toBeUndefined();
    const from = await recoverTransactionAddress({
      serializedTransaction: first.signedTransaction as `0x02${string}`,
    });
    expect(from.toLowerCase()).toBe(world.address);

    const again = await world.t.client.sweep(world.walletId, {
      ...request,
      transaction: txParams(),
    });
    expect(again).toEqual(first);
    expect(await world.t.client.getApproval(first.approvalId)).toEqual({
      approvalId: first.approvalId,
      state: "signed",
      transactionHash: first.transactionHash,
      attempts: [
        expect.objectContaining({
          attempt: 0,
          kind: "original",
          transactionHash: first.transactionHash,
        }),
      ],
      cloid: null,
    });
    expect((await world.t.client.getWallet(world.walletId)).spent).toEqual([
      { chainId: CHAIN, asset: "native", amount: String(3n * ETH) },
    ]);
  });

  it("sends an ERC-20 to the workspace's treasury, encoding the transfer itself", async () => {
    const world = await setUpWorld(startSigner());
    const treasury = await treasuryOf(world);
    const sweep = sweepOf(world, { asset: TOKEN, amount: "7000000", to: treasury });
    const signed = await world.t.client.sweep(world.walletId, {
      sweep,
      authorization: approveSweep(world, sweep),
      transaction: txParams({ gas: "60000" }),
    });
    const tx = parseTransaction(signed.signedTransaction);
    expect(tx.to).toBe(TOKEN);
    expect(tx.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data ?? "0x" });
    expect(call.functionName).toBe("transfer");
    expect(call.args.map((arg) => (typeof arg === "string" ? arg.toLowerCase() : arg))).toEqual([
      treasury,
      7000000n,
    ]);
  });

  it("refuses a destination that is neither on the wallet's allowlist nor its workspace's treasury", async () => {
    const world = await allowOnly(await setUpWorld(startSigner()), [ALLOWED]);
    const elsewhere = await setUpWorld(world.t);
    const otherTreasury = await treasuryOf(elsewhere);
    for (const to of [STRANGER, otherTreasury, world.address as Address]) {
      const sweep = sweepOf(world, { to });
      await refused(
        world.t.client.sweep(world.walletId, {
          sweep,
          authorization: approveSweep(world, sweep),
          transaction: txParams(),
        }),
        "sweep_destination_not_allowed",
      );
    }
    // A policy that lets agents pay anyone allows no sweep destination by itself.
    const open = await setUpWorld(world.t);
    const sweep = sweepOf(open, { to: STRANGER });
    await refused(
      open.t.client.sweep(open.walletId, {
        sweep,
        authorization: approveSweep(open, sweep),
        transaction: txParams(),
      }),
      "sweep_destination_not_allowed",
    );
    const { decisions } = await world.t.client.listDecisions(world.workspaceId);
    expect(
      decisions.filter((d) => d.action === "sweep" && d.code === "sweep_destination_not_allowed"),
    ).toHaveLength(3);
  });

  it("refuses an amount, a recipient or an asset other than the approved ones", async () => {
    const world = await setUpWorld(startSigner());
    const treasury = await treasuryOf(world);
    const sweep = sweepOf(world, { to: treasury });
    const authorization = approveSweep(world, sweep);
    const otherTreasury = await treasuryOf(world);
    for (const altered of [
      { ...sweep, amount: String(4n * ETH) },
      { ...sweep, to: otherTreasury },
      { ...sweep, asset: TOKEN },
      { ...sweep, maxFeeWei: String(10n ** 16n) },
    ]) {
      await refused(
        world.t.client.sweep(world.walletId, {
          sweep: altered,
          authorization,
          transaction: txParams(),
        }),
        "envelope_mismatch",
      );
    }
    // Changing the envelope instead breaks the passkey assertion over it.
    await refused(
      world.t.client.sweep(world.walletId, {
        sweep: { ...sweep, amount: "1" },
        authorization: {
          ...authorization,
          envelope: {
            ...authorization.envelope,
            sweepHash: sweepHash({ ...sweep, amount: "1" }),
          } as Authorization["envelope"],
        },
        transaction: txParams(),
      }),
      "assertion_invalid",
    );
    // An intent's approval is not a sweep's.
    const intent = intentFor(world);
    await refused(
      world.t.client.sweep(world.walletId, {
        sweep,
        authorization: approveIntent(world, intent),
        transaction: txParams(),
      }),
      "envelope_mismatch",
    );
  });

  it("needs the workspace's admin threshold, not the wallet's", async () => {
    const world = await setUpWorld(startSigner(), {
      people: 2,
      adminThreshold: 2,
      policyThreshold: 1,
    });
    const treasury = await treasuryOf(world);
    const sweep = sweepOf(world, { to: treasury });
    const [first] = world.people;
    if (!first) throw new Error("no approver");
    await refused(
      world.t.client.sweep(world.walletId, {
        sweep,
        authorization: approveSweep(world, sweep, [first]),
        transaction: txParams(),
      }),
      "insufficient_approvals",
    );
    const signed = await world.t.client.sweep(world.walletId, {
      sweep,
      authorization: approveSweep(world, sweep, world.people),
      transaction: txParams(),
    });
    expect(signed.from).toBe(world.address);
  });

  it("empties a paused workspace's wallet while the same workspace's intents stay refused", async () => {
    const world = await setUpWorld(startSigner());
    const treasury = await treasuryOf(world);
    await world.t.client.pauseWorkspace(world.workspaceId);
    const intent = intentFor(world);
    await refused(
      world.t.client.sign({
        intent,
        authorization: approveIntent(world, intent),
        transaction: txParams(),
      }),
      "workspace_paused",
    );
    const sweep = sweepOf(world, { to: treasury });
    const signed = await world.t.client.sweep(world.walletId, {
      sweep,
      authorization: approveSweep(world, sweep),
      transaction: txParams(),
    });
    expect(parseTransaction(signed.signedTransaction).to).toBe(treasury);
  });

  it("keeps the approved fee ceiling, the wallet's fee limit and its chains", async () => {
    const world = await setUpWorld(startSigner());
    const treasury = await treasuryOf(world);
    const sweep = sweepOf(world, { to: treasury });
    await refused(
      world.t.client.sweep(world.walletId, {
        sweep,
        authorization: approveSweep(world, sweep),
        // 100000 gas at 20 gwei is 0.002 ETH, over the approved 0.001.
        transaction: txParams({ gas: "100000", maxFeePerGas: "20000000000" }),
      }),
      "fee_cap_exceeded",
    );
    const costly = sweepOf(world, { to: treasury, maxFeeWei: String(10n ** 17n) });
    await refused(
      world.t.client.sweep(world.walletId, {
        sweep: costly,
        authorization: approveSweep(world, costly),
        transaction: txParams(),
      }),
      "policy_denied",
      "over_fee_cap",
    );
    const elsewhere = sweepOf(world, { to: treasury, chainId: "eip155:8453" });
    await refused(
      world.t.client.sweep(world.walletId, {
        sweep: elsewhere,
        authorization: approveSweep(world, elsewhere),
        transaction: txParams(),
      }),
      "policy_denied",
      "chain_not_allowed",
    );
  });
});
