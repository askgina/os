import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, policyHash, type WalletId } from "@askgina/os-protocol";
import { parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { createTestVault, OwsVault, type Vault } from "../src/index.ts";
import { isTypedSignedBy } from "../src/signer.ts";
import type { HyperliquidPayload } from "../src/venues/hyperliquid.ts";
import {
  approveIntent,
  authorize,
  header,
  intentFor,
  refused,
  setUpWorld,
  startSigner,
  txParams,
} from "./harness.ts";

/** A vault that creates honest wallets and then signs however the test says. */
function vaultThatSigns(
  sign: (honest: Vault, ...args: Parameters<Vault["signEvmTransaction"]>) => `0x${string}`,
): Vault {
  const honest = createTestVault();
  return {
    createWallet: (walletId) => honest.createWallet(walletId),
    signEvmTransaction: (...args) => sign(honest, ...args),
    signHyperliquid: (...args) => honest.signHyperliquid(...args),
    destroyWallet: (walletId) => honest.destroyWallet(walletId),
  };
}

describe("a vault that misbehaves", () => {
  it("cannot make the signer record a signature from another key", async () => {
    const other = createTestVault();
    const otherId = newId("wal");
    const otherWallet = other.createWallet(otherId);
    const world = await setUpWorld(
      startSigner({
        vault: vaultThatSigns((_honest, _walletId, _credential, transaction) =>
          other.signEvmTransaction(otherId, otherWallet.credential, transaction),
        ),
      }),
    );
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    await refused(
      world.t.client.sign({ intent, authorization, transaction: txParams() }),
      "vault_error",
    );
    // Nothing was spent on the refusal: no signature, no ledger entry.
    expect((await world.t.client.getApproval(authorization.envelope.approvalId)).state).toBe(
      "unknown",
    );
    expect((await world.t.client.getWallet(world.walletId)).spent).toEqual([]);
  });

  it("cannot make the signer record a signature over a different transaction", async () => {
    const world = await setUpWorld(
      startSigner({
        vault: vaultThatSigns((honest, walletId, credential, transaction) =>
          honest.signEvmTransaction(walletId, credential, {
            ...transaction,
            value: (transaction.value ?? 0n) + 1n,
          }),
        ),
      }),
    );
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    await refused(
      world.t.client.sign({ intent, authorization, transaction: txParams() }),
      "vault_error",
    );
    expect((await world.t.client.getWallet(world.walletId)).spent).toEqual([]);
  });

  it("cannot make the signer spend an approval on a high-s signature nodes would reject", async () => {
    // The order of secp256k1's group: (r, n - s) with the other parity is the same signature
    // mathematically and recovers to the same key, but EIP-2 makes nodes refuse it.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const world = await setUpWorld(
      startSigner({
        vault: vaultThatSigns((honest, walletId, credential, transaction) => {
          const { r, s, yParity } = parseTransaction(
            honest.signEvmTransaction(walletId, credential, transaction),
          );
          return serializeTransaction(
            { ...transaction, type: "eip1559" },
            {
              r: r as `0x${string}`,
              s: `0x${(N - BigInt(s as string)).toString(16).padStart(64, "0")}`,
              yParity: yParity === 0 ? 1 : 0,
            },
          );
        }),
      }),
    );
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    await refused(
      world.t.client.sign({ intent, authorization, transaction: txParams() }),
      "vault_error",
    );
    expect((await world.t.client.getApproval(authorization.envelope.approvalId)).state).toBe(
      "unknown",
    );
  });
});

describe("requests the router cannot place", () => {
  it("answers a path that does not decode with the contract's 404 body", async () => {
    const { signer } = startSigner();
    const response = await signer.app.request("http://signer.test/v1/wallets/%zz");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });
});

describe("limits on what the signer accepts", () => {
  it("refuses a policy whose approvals would outlive what this signer accepts", async () => {
    const world = await setUpWorld(startSigner());
    // The harness's signer accepts approvals of intents for at most an hour.
    const policy = {
      ...world.policy,
      revision: 2,
      previousHash: policyHash(world.policy),
      approvals: { threshold: 1, ttlSeconds: 7200 },
    };
    await refused(
      world.t.client.setPolicy(world.walletId, {
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
      }),
      "policy_invalid",
    );
    expect((await world.t.client.getWallet(world.walletId)).policy?.revision).toBe(1);
  });

  it("refuses a request body far larger than any valid request", async () => {
    const { signer } = startSigner();
    const response = await signer.app.request("http://signer.test/v1/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("stops reading a body with no Content-Length once it passes the limit, before authenticating", async () => {
    const { signer } = startSigner();
    let pulls = 0;
    // An endless stream: a signer that buffered before checking would never answer.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
    });
    const request = new Request("http://signer.test/v1/sign", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const response = await signer.app.request(request);
    // Unsigned, yet refused as too large: the limit applies before the signature is checked.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(pulls).toBeLessThan(10);
  });
});

describe("a Hyperliquid signature the vault returns", () => {
  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const vault = createTestVault();
  const walletId = newId("wal");
  const { address, credential } = vault.createWallet(walletId);
  const payload: HyperliquidPayload = {
    kind: "l1",
    network: "hyperliquid:testnet",
    connectionId: `0x${"ab".repeat(32)}`,
  };
  const signature = vault.signHyperliquid(walletId, credential, payload);

  it("is accepted only from the wallet's key, over the payload the signer built", () => {
    expect(isTypedSignedBy(signature, payload, address)).toBe(true);

    const other = createTestVault();
    const otherId = newId("wal");
    const otherWallet = other.createWallet(otherId);
    const fromOtherKey = other.signHyperliquid(otherId, otherWallet.credential, payload);
    expect(isTypedSignedBy(fromOtherKey, payload, address)).toBe(false);

    const otherAction = { ...payload, connectionId: `0x${"cd".repeat(32)}` } as const;
    expect(isTypedSignedBy(signature, otherAction, address)).toBe(false);
    expect(
      isTypedSignedBy(signature, { ...payload, network: "hyperliquid:mainnet" }, address),
    ).toBe(false);
    const withdraw: HyperliquidPayload = {
      kind: "withdraw",
      network: "hyperliquid:testnet",
      destination: address,
      amount: "1",
      time: 1,
    };
    expect(
      isTypedSignedBy(vault.signHyperliquid(walletId, credential, withdraw), withdraw, address),
    ).toBe(true);
    expect(isTypedSignedBy(signature, withdraw, address)).toBe(false);
  });

  it("is refused with a high s, though it recovers to the same key, or when malformed", () => {
    const highS = {
      r: signature.r,
      s: `0x${(SECP256K1_N - BigInt(signature.s)).toString(16).padStart(64, "0")}`,
      v: signature.v === 27 ? 28 : 27,
    } as const;
    expect(isTypedSignedBy(highS, payload, address)).toBe(false);
    expect(isTypedSignedBy({ ...signature, v: 29 as 27 }, payload, address)).toBe(false);
    expect(isTypedSignedBy({ ...signature, r: `0x${"00".repeat(32)}` }, payload, address)).toBe(
      false,
    );
    expect(
      isTypedSignedBy(
        { ...signature, s: signature.s.toUpperCase() as `0x${string}` },
        payload,
        address,
      ),
    ).toBe(false);
  });
});

describe("the OWS vault after a crash during wallet creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-signer-adopt-"));
  const passphraseFile = join(dir, "passphrase");
  writeFileSync(passphraseFile, "a long enough owner passphrase");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("adopts the wallet that was created but never recorded, instead of failing forever", async () => {
    const vault = new OwsVault({ vaultPath: join(dir, "vault"), passphraseFile });
    const walletId: WalletId = newId("wal");
    // The first attempt reached the vault and then the process died: the signer has no row.
    const orphan = vault.createWallet(walletId);

    const t = startSigner({ vault });
    const workspaceId = newId("ws");
    const person = (await setUpWorld(t)).people[0];
    if (!person) throw new Error("the test world has no approver");
    await t.client.createWorkspace({
      workspaceId,
      adminThreshold: 1,
      approvers: [person.credential],
    });
    const wallet = await t.client.createWallet({
      workspaceId,
      walletId,
      kind: "agent",
      label: "retried",
    });
    expect(wallet.address).toBe(orphan.address);

    // The adopted wallet signs with its new credential.
    const adopted = vault.createWallet(walletId);
    const signed = vault.signEvmTransaction(walletId, adopted.credential, {
      chainId: 31337,
      nonce: 0,
      to: "0x00000000000000000000000000000000000000aa",
      value: 1n,
      gas: 21000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    const from = await recoverTransactionAddress({
      serializedTransaction: signed as `0x02${string}`,
    });
    expect(from.toLowerCase()).toBe(orphan.address);
  });
});
