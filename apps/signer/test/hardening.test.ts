import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, policyHash, type WalletId } from "@askgina/os-protocol";
import { recoverTransactionAddress } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { createTestVault, OwsVault, type Vault } from "../src/index.ts";
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
});

describe("the OWS vault after a crash during wallet creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "osbuild-signer-adopt-"));
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
