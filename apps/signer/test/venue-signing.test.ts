import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Envelope,
  type HyperliquidOrderOperation,
  type HyperliquidRules,
  intentHash,
  newId,
  type VenueIntent,
  type VenueNetwork,
} from "@askgina/os-protocol";
import type { HyperliquidRequest, SignerClient } from "@askgina/os-protocol/signer";
import { referenceMsgpackEncode } from "@askgina/os-testkit/msgpack";
import {
  bytesToHex,
  concat,
  type Hex,
  keccak256,
  numberToHex,
  recoverTypedDataAddress,
} from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { createTestVault, SCHEMA_VERSION, SchemaTooNewError, type Vault } from "../src/index.ts";
import { cloidFor } from "../src/venues/hyperliquid.ts";
import {
  approveIntent,
  authorize,
  Clock,
  header,
  intentFor,
  refused,
  replacePolicy,
  setUpWorld,
  startSigner,
  type TestSigner,
  txParams,
  type World,
} from "./harness.ts";

const NETWORK = "hyperliquid:testnet" as const;

const BTC = 3;

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** BTC up to 1,000 USD an order, ETH up to 500, 1,500 USD a day, IOC and GTC, a 60 s window. */
function rules(overrides: Partial<HyperliquidRules> = {}): HyperliquidRules {
  return {
    network: NETWORK,
    markets: [
      { asset: BTC, coin: "BTC", maxNotionalPerOrderUsd6: "1000000000" },
      { asset: 4, coin: "ETH", maxNotionalPerOrderUsd6: "500000000" },
    ],
    maxNotionalPerDayUsd6: "1500000000",
    timeInForce: ["Gtc", "Ioc"],
    submitWindowSeconds: 60,
    withdrawals: true,
    ...overrides,
  };
}

/** A vault that counts the Hyperliquid signatures it makes. */
function countingVault() {
  const honest = createTestVault();
  const count = { venue: 0 };

  const vault: Vault = {
    createWallet: (walletId) => honest.createWallet(walletId),
    signEvmTransaction: (...args) => honest.signEvmTransaction(...args),
    signHyperliquid: (...args) => {
      count.venue += 1;

      return honest.signHyperliquid(...args);
    },
    destroyWallet: (walletId) => honest.destroyWallet(walletId),
  };

  return { vault, count };
}

async function venueWorld(
  t: TestSigner = startSigner(),
  options: { people?: number; venue?: Partial<HyperliquidRules> } = {},
): Promise<World> {
  const world = await setUpWorld(t, { people: options.people ?? 1, adminThreshold: 1 });
  const policy = await replacePolicy(world, { venues: { hyperliquid: rules(options.venue) } });

  return { ...world, policy };
}

/** Buy 0.01 BTC perpetual at 65,000 USD, immediate or cancel: 650 USD notional. */
function orderIntent(world: World, changes: Partial<HyperliquidOrderOperation> = {}): VenueIntent {
  return {
    v: 1,
    id: newId("int"),
    workspaceId: world.workspaceId,
    agentId: world.agentId,
    walletId: world.walletId,
    chainId: NETWORK,
    operation: {
      type: "hyperliquid.order",
      asset: BTC,
      isBuy: true,
      size: "0.01",
      limitPx: "65000",
      tif: "Ioc",
      reduceOnly: false,
      ...changes,
    },
    memo: "the funding rate turned",
    createdAt: world.t.clock.value,
  };
}

function withdrawIntent(world: World, amount = "25"): VenueIntent {
  return { ...orderIntent(world), operation: { type: "hyperliquid.withdraw", amount } };
}

const signVenue = (world: World, intent: VenueIntent = orderIntent(world)) =>
  world.t.client.signVenue({ intent, authorization: approveIntent(world, intent) });

const signatureHex = ({ r, s, v }: HyperliquidRequest["signature"]) =>
  `${r}${s.slice(2)}${v.toString(16)}` as Hex;

/**
 * Who signed an order or cancel request, recovered with an independent encoder: the reference
 * msgpack of the action exactly as the body carries it, then viem. The agent `source` is "a" on
 * mainnet and "b" on testnet, so a signature recovers to the wallet only for its own network.
 */
async function l1Signer(
  request: HyperliquidRequest,
  network: VenueNetwork = NETWORK,
): Promise<string> {
  const connectionId = keccak256(
    concat([
      bytesToHex(referenceMsgpackEncode(request.action)),
      numberToHex(request.nonce, { size: 8 }),
      "0x00",
      "0x00",
      numberToHex(request.expiresAfter ?? 0, { size: 8 }),
    ]),
  );

  const address = await recoverTypedDataAddress({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: network === "hyperliquid:mainnet" ? "a" : "b", connectionId },
    signature: signatureHex(request.signature),
  });

  return address.toLowerCase();
}

async function decisionCount(client: SignerClient, world: World, action: string) {
  const { decisions } = await client.listDecisions(world.workspaceId);

  return decisions.filter((d) => d.action === action && d.outcome === "allowed").length;
}

describe("signing an approved venue order", () => {
  it("signs one order built from the intent, by the wallet's key, and records its spend", async () => {
    const world = await venueWorld();
    const intent = orderIntent(world);
    const authorization = approveIntent(world, intent);
    const now = world.t.clock.value * 1000;
    const signed = await world.t.client.signVenue({ intent, authorization });
    const cloid = cloidFor(authorization.envelope.approvalId);

    expect(signed).toMatchObject({
      approvalId: authorization.envelope.approvalId,
      walletId: world.walletId,
      network: NETWORK,
      account: world.address,
      cloid,
    });
    // The body in the venue's key order: what is posted encodes to what was hashed.
    expect(JSON.stringify(signed.request)).toBe(
      JSON.stringify({
        action: {
          type: "order",
          orders: [
            {
              a: BTC,
              b: true,
              p: "65000",
              s: "0.01",
              r: false,
              t: { limit: { tif: "Ioc" } },
              c: cloid,
            },
          ],
          grouping: "na",
        },
        nonce: now,
        signature: signed.request.signature,
        vaultAddress: null,
        expiresAfter: now + 60_000,
      }),
    );
    expect(await l1Signer(signed.request)).toBe(world.address);

    const wallet = await world.t.client.getWallet(world.walletId);
    expect([wallet.spent, wallet.venueSpent]).toEqual([
      [],
      [{ chainId: NETWORK, asset: "usd6", amount: "650000000" }],
    ]);
    expect(await world.t.client.getApproval(authorization.envelope.approvalId)).toEqual({
      approvalId: authorization.envelope.approvalId,
      state: "signed",
      transactionHash: null,
      attempts: [],
      cloid,
    });
  });

  it("returns the stored answer for a repeat, also concurrent and while paused, and signs once", async () => {
    const { vault, count } = countingVault();
    const world = await venueWorld(startSigner({ vault }));
    const intent = orderIntent(world);
    const request = { intent, authorization: approveIntent(world, intent) };

    const [first, second] = await Promise.all([
      world.t.client.signVenue(request),
      world.t.client.signVenue(request),
    ]);

    expect(second).toEqual(first);
    await world.t.client.pauseWorkspace(world.workspaceId);
    world.t.clock.value += 30;
    expect(await world.t.client.signVenue(request)).toEqual(first);
    expect(count.venue).toBe(1);
    expect(await decisionCount(world.t.client, world, "sign-venue")).toBe(1);
  });

  it("refuses an intent changed after approval in any field that is signed or shown", async () => {
    const world = await venueWorld();
    const intent = orderIntent(world);
    const authorization = approveIntent(world, intent);
    const order = intent.operation as HyperliquidOrderOperation;

    const changed: [VenueIntent, string][] = [
      [{ ...intent, operation: { ...order, asset: 4 } }, "intent_mismatch"],
      [{ ...intent, operation: { ...order, isBuy: false } }, "intent_mismatch"],
      [{ ...intent, operation: { ...order, size: "0.02" } }, "intent_mismatch"],
      [{ ...intent, operation: { ...order, limitPx: "64000" } }, "intent_mismatch"],
      [{ ...intent, operation: { ...order, tif: "Gtc" } }, "intent_mismatch"],
      [{ ...intent, operation: { ...order, reduceOnly: true } }, "intent_mismatch"],
      [{ ...intent, memo: "something else" }, "intent_mismatch"],
      [{ ...intent, chainId: "hyperliquid:mainnet" }, "envelope_mismatch"],
      [{ ...intent, walletId: newId("wal") }, "envelope_mismatch"],
      [{ ...intent, agentId: newId("agt") }, "envelope_mismatch"],
    ];

    for (const [other, code] of changed) {
      await refused(world.t.client.signVenue({ intent: other, authorization }), code);
    }

    const withdrawal = withdrawIntent(world);
    await refused(
      world.t.client.signVenue({
        intent: withdrawIntent(world, "26"),
        authorization: approveIntent(world, withdrawal),
      }),
      "intent_mismatch",
    );
    // Nothing was spent by the refusals: the approved intent still signs.
    expect((await world.t.client.signVenue({ intent, authorization })).cloid).toBe(
      cloidFor(authorization.envelope.approvalId),
    );
  });

  it("refuses a second approval that reuses an envelope nonce", async () => {
    const world = await venueWorld();
    const first = orderIntent(world);
    const used = approveIntent(world, first);
    await world.t.client.signVenue({ intent: first, authorization: used });
    const second = orderIntent(world);

    const envelope = {
      ...used.envelope,
      approvalId: newId("apr"),
      intentHash: intentHash(second),
    } as Envelope;

    await refused(
      world.t.client.signVenue({
        intent: second,
        authorization: authorize(envelope, world.people),
      }),
      "nonce_reused",
    );
  });

  it("signs one of two concurrent approvals that together exceed the daily cap", async () => {
    const world = await venueWorld();

    // 780 USD each against a 1,500 USD day.
    const results = await Promise.allSettled([
      signVenue(world, orderIntent(world, { size: "0.012" })),
      signVenue(world, orderIntent(world, { size: "0.012" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "policy_denied", detail: "over_daily_cap" });
  });

  it("signs a reduce-only order with the daily cap spent, without counting it", async () => {
    const world = await venueWorld();
    await signVenue(world);
    await signVenue(world);
    await refused(signVenue(world), "policy_denied", "over_daily_cap");
    await signVenue(world, orderIntent(world, { isBuy: false, reduceOnly: true }));
    expect((await world.t.client.getWallet(world.walletId)).venueSpent).toEqual([
      { chainId: NETWORK, asset: "usd6", amount: "1300000000" },
    ]);
  });

  it("refuses what the policy does not allow", async () => {
    const world = await venueWorld();
    await refused(
      signVenue(world, orderIntent(world, { asset: 5 })),
      "policy_denied",
      "market_not_allowed",
    );
    await refused(
      signVenue(world, orderIntent(world, { tif: "Alo" })),
      "policy_denied",
      "order_type_not_allowed",
    );
    await refused(
      signVenue(world, orderIntent(world, { size: "0.02" })),
      "policy_denied",
      "over_per_tx_cap",
    );

    const without = await setUpWorld(startSigner());
    await refused(signVenue(without, orderIntent(without)), "policy_denied", "venue_not_allowed");
  });

  it("signs a mainnet order under a mainnet policy, and refuses the other network both ways", async () => {
    const mainnet = await venueWorld(startSigner(), { venue: { network: "hyperliquid:mainnet" } });
    const intent: VenueIntent = { ...orderIntent(mainnet), chainId: "hyperliquid:mainnet" };
    const authorization = approveIntent(mainnet, intent);
    const signed = await mainnet.t.client.signVenue({ intent, authorization });
    expect(signed).toMatchObject({
      approvalId: authorization.envelope.approvalId,
      network: "hyperliquid:mainnet",
      account: mainnet.address,
      cloid: cloidFor(authorization.envelope.approvalId),
    });
    expect(await l1Signer(signed.request, "hyperliquid:mainnet")).toBe(mainnet.address);
    expect(await l1Signer(signed.request, "hyperliquid:testnet")).not.toBe(mainnet.address);
    expect((await mainnet.t.client.getWallet(mainnet.walletId)).venueSpent).toEqual([
      { chainId: "hyperliquid:mainnet", asset: "usd6", amount: "650000000" },
    ]);

    // A testnet intent is refused under the mainnet policy.
    await refused(signVenue(mainnet, orderIntent(mainnet)), "policy_denied", "venue_not_allowed");

    // A mainnet intent is refused under a testnet policy.
    const testnet = await venueWorld();
    await refused(
      signVenue(testnet, { ...orderIntent(testnet), chainId: "hyperliquid:mainnet" }),
      "policy_denied",
      "venue_not_allowed",
    );
    // Neither refusal spent anything: each wallet still signs on its own network.
    expect((await signVenue(testnet)).network).toBe(NETWORK);
    expect(
      (await signVenue(mainnet, { ...orderIntent(mainnet), chainId: "hyperliquid:mainnet" }))
        .network,
    ).toBe("hyperliquid:mainnet");
  });

  it("refuses an expired envelope, a revoked approval, a removed approver, a paused workspace and a changed policy", async () => {
    const world = await venueWorld(startSigner(), { people: 2 });
    const [alice, bob] = world.people as [World["people"][0], World["people"][0]];

    const expiring = orderIntent(world);
    const expired = approveIntent(world, expiring, { ttlSeconds: 60 });
    world.t.clock.value += 61;
    await refused(
      world.t.client.signVenue({ intent: expiring, authorization: expired }),
      "envelope_expired",
    );

    const revoked = orderIntent(world);
    const revokedAuthorization = approveIntent(world, revoked);
    await world.t.client.revokeApproval(
      revokedAuthorization.envelope.approvalId,
      world.workspaceId,
    );
    await refused(
      world.t.client.signVenue({ intent: revoked, authorization: revokedAuthorization }),
      "approval_revoked",
    );

    const byBob = orderIntent(world);
    const bobsApproval = approveIntent(world, byBob, { people: [bob] });
    await world.t.client.removeApprover(
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
    );
    await refused(
      world.t.client.signVenue({ intent: byBob, authorization: bobsApproval }),
      "approver_unknown",
    );

    const stale = orderIntent(world);
    const staleApproval = approveIntent(world, stale, { people: [alice] });

    const changedPolicy = await replacePolicy(
      { ...world, people: [alice] },
      { venues: { hyperliquid: rules({ submitWindowSeconds: 30 }) } },
    );

    await refused(
      world.t.client.signVenue({ intent: stale, authorization: staleApproval }),
      "policy_changed",
    );

    const current = { ...world, people: [alice], policy: changedPolicy };
    await world.t.client.pauseWorkspace(world.workspaceId);
    await refused(signVenue(current), "workspace_paused");
  });

  it("refuses an envelope issued before the restore fence", async () => {
    const t = startSigner();
    const world = await venueWorld(t);
    const intent = orderIntent(world);
    const authorization = approveIntent(world, intent);
    t.signer.fence();
    await refused(world.t.client.signVenue({ intent, authorization }), "envelope_fenced");
  });

  it("expires at the signer's clock plus the policy's window, and nonces always increase", async () => {
    const world = await venueWorld();
    const start = world.t.clock.value;
    const first = await signVenue(world);
    expect([first.request.nonce, first.request.expiresAfter]).toEqual([
      start * 1000,
      start * 1000 + 60_000,
    ]);

    // The clock stepped back: the nonce still rises; the expiry follows the clock, never more.
    world.t.clock.value = start - 10;
    const second = await signVenue(world, orderIntent(world, { size: "0.001" }));
    expect(second.request.nonce).toBe(first.request.nonce + 1);
    expect(second.request.expiresAfter).toBe((start - 10) * 1000 + 60_000);

    world.t.clock.value = start + 100;

    const policy = await replacePolicy(world, {
      venues: { hyperliquid: rules({ submitWindowSeconds: 30 }) },
    });

    const third = await signVenue({ ...world, policy });
    expect([third.request.nonce, third.request.expiresAfter]).toEqual([
      (start + 100) * 1000,
      (start + 100) * 1000 + 30_000,
    ]);
  });

  it("withdraws only to the wallet's own address, with no expiry and no spend", async () => {
    const world = await venueWorld();
    const intent = withdrawIntent(world);
    const signed = await signVenue(world, intent);
    const { action } = signed.request;
    expect(action).toEqual({
      type: "withdraw3",
      hyperliquidChain: "Testnet",
      signatureChainId: "0x66eee",
      amount: "25",
      time: signed.request.nonce,
      destination: world.address,
    });
    expect([signed.cloid, signed.request.expiresAfter]).toEqual([null, null]);

    if (action.type !== "withdraw3") throw new Error("expected a withdrawal");

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 421614,
        verifyingContract: ZERO,
      },
      types: {
        "HyperliquidTransaction:Withdraw": [
          { name: "hyperliquidChain", type: "string" },
          { name: "destination", type: "string" },
          { name: "amount", type: "string" },
          { name: "time", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:Withdraw",
      message: { ...action, time: BigInt(action.time) },
      signature: signatureHex(signed.request.signature),
    });

    expect(recovered.toLowerCase()).toBe(world.address);
    expect((await world.t.client.getWallet(world.walletId)).venueSpent).toEqual([]);

    // There is no field to name another destination.
    const elsewhere = {
      ...intent,
      id: newId("int"),
      operation: { ...intent.operation, destination: ZERO },
    } as unknown as VenueIntent;

    await refused(
      world.t.client.signVenue({ intent: elsewhere, authorization: approveIntent(world, intent) }),
      "invalid_request",
    );

    const closed = await venueWorld(startSigner(), { venue: { withdrawals: false } });
    await refused(
      signVenue(closed, withdrawIntent(closed)),
      "policy_denied",
      "withdrawal_not_allowed",
    );
  });
});

describe("cancelling a signed order", () => {
  it("is not found for an approval never signed or of another workspace, and a conflict for a withdrawal", async () => {
    const world = await venueWorld();
    await refused(world.t.client.cancelVenueOrder(newId("apr"), world.workspaceId), "not_found");
    const order = await signVenue(world);
    const other = await setUpWorld(world.t);
    await refused(
      world.t.client.cancelVenueOrder(order.approvalId, other.workspaceId),
      "not_found",
    );
    const withdrawal = await signVenue(world, withdrawIntent(world));
    await refused(
      world.t.client.cancelVenueOrder(withdrawal.approvalId, world.workspaceId),
      "conflict",
    );
  });

  it("works while paused, repeats within its expiry, and is new with a larger nonce after it", async () => {
    const world = await venueWorld();
    const order = await signVenue(world);
    await world.t.client.pauseWorkspace(world.workspaceId);
    world.t.clock.value += 5;

    const cancel = await world.t.client.cancelVenueOrder(order.approvalId, world.workspaceId);
    expect(cancel.cloid).toBe(order.cloid);
    expect(cancel.request.action).toEqual({
      type: "cancelByCloid",
      cancels: [{ asset: BTC, cloid: order.cloid }],
    });
    expect(cancel.request.nonce).toBe(world.t.clock.value * 1000);
    expect(cancel.request.expiresAfter).toBe(world.t.clock.value * 1000 + 60_000);
    expect(await l1Signer(cancel.request)).toBe(world.address);

    world.t.clock.value += 59;
    expect(await world.t.client.cancelVenueOrder(order.approvalId, world.workspaceId)).toEqual(
      cancel,
    );

    world.t.clock.value += 2;
    const again = await world.t.client.cancelVenueOrder(order.approvalId, world.workspaceId);
    expect(again.request.nonce).toBeGreaterThan(cancel.request.nonce);
    expect(again.request.signature).not.toEqual(cancel.request.signature);
    expect(await l1Signer(again.request)).toBe(world.address);
    expect(await decisionCount(world.t.client, world, "cancel-venue-order")).toBe(2);
  });
});

describe("the confirmation view of an order", () => {
  it("shows the usd6 spend of the last 24 hours from the signer's own ledger", async () => {
    const t = startSigner();
    const world = await venueWorld(t);
    await signVenue(world);
    const intent = orderIntent(world);
    const { envelope } = approveIntent(world, intent, { people: [] });

    const { path } = await t.client.openConfirmation(envelope.approvalId, {
      envelope,
      subject: { kind: "approve-intent", intent },
    });

    const view = await t.confirm.getConfirmation(
      envelope.approvalId,
      path.slice(path.indexOf("#") + 1),
    );

    expect(view.lines.find((line) => line.label === "Spent in the last 24 hours")?.value).toBe(
      "650 USD of 1,500 USD",
    );
  });
});

describe("schema version 8", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a version 7 file, keeping its rows; a newer file is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-signer-venues-"));
    dirs.push(dir);
    const sqlitePath = join(dir, "signer.sqlite");

    const host = {
      sqlitePath,
      clock: new Clock(),
      vault: createTestVault(),
      tokenKey: new Uint8Array(32).fill(7),
    };

    let t = startSigner(host);
    const world = await venueWorld(t);
    const payment = intentFor(world);

    const signed = await t.client.sign({
      intent: payment,
      authorization: approveIntent(world, payment),
      transaction: txParams(),
    });

    t.signer.close();

    // What a signer at version 7 left behind.
    const old = new DatabaseSync(sqlitePath);
    old.exec(
      "DROP TABLE venue_cancels; DROP TABLE venue_signatures; DROP TABLE venue_nonces; PRAGMA user_version = 7;",
    );
    old.close();

    t = startSigner(host);
    const upgraded: World = { ...world, t };
    expect((await t.client.getApproval(signed.approvalId)).transactionHash).toBe(
      signed.transactionHash,
    );
    expect((await t.client.getWallet(world.walletId)).policy).toEqual(world.policy);
    expect((await signVenue(upgraded)).network).toBe(NETWORK);
    t.signer.close();
    const db = new DatabaseSync(sqlitePath);
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(SCHEMA_VERSION);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(SCHEMA_VERSION).toBe(8);
    expect(() => startSigner(host)).toThrow(SchemaTooNewError);
  });
});
