import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Address,
  Cloid,
  Hex32,
  HyperliquidOrderOperation,
  newId,
  policyHash,
} from "@askgina/os-protocol";
import { createSignerClient, type SignerClient } from "@askgina/os-protocol/signer";
import * as ows from "@open-wallet-standard/core";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  erc20Abi,
  http,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSigner, OwsVault, VaultError } from "../src/index.ts";
import { isTypedSignedBy } from "../src/signer.ts";
import {
  cancelByCloidAction,
  type HyperliquidPayload,
  type HyperliquidSignature,
  l1ActionHash,
  orderAction,
} from "../src/venues/hyperliquid.ts";
import {
  approveIntent,
  authorize,
  basePolicy,
  Clock,
  CONFIRMATION_SETTINGS,
  confirmationEnvironment,
  ETH,
  eip1559Serialized,
  grantRequest,
  header,
  intentFor,
  mandateFor,
  newPerson,
  RECIPIENT,
  RP_ID,
  refused,
  TOKEN,
  tokenIntent,
  useRequest,
  type World,
} from "./harness.ts";
import { mapFromJson } from "./hyperliquid-vectors.ts";
import vectors from "./vectors/hyperliquid-python-sdk.json" with { type: "json" };

const RPC = "http://127.0.0.1:55545";

// Below Linux's default ephemeral range, so no "any free port" listener can take it first.
const PORT = 25701;

const anvil = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const chain = createPublicClient({ chain: anvil, transport: http(RPC) });

// Anvil's default test mnemonic. Index 8 keeps clear of the accounts other suites tend to use.
const funder = createWalletClient({
  account: mnemonicToAccount("test test test test test test test test test test test junk", {
    addressIndex: 8,
  }),
  chain: anvil,
  transport: http(RPC),
});

const realClock = () => Math.floor(Date.now() / 1000);

describe("destroying a wallet in the real OWS vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-signer-ows-destroy-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("leaves no wallet or key file naming the wallet, keeps the others, and a repeat succeeds", () => {
    const passphraseFile = join(dir, "passphrase");
    writeFileSync(passphraseFile, "a long enough owner passphrase");
    const vaultPath = join(dir, "vault");
    const vault = new OwsVault({ vaultPath, passphraseFile });
    const [gone, kept] = [newId("wal"), newId("wal")];
    vault.createWallet(gone);
    vault.createWallet(kept);
    const goneId = ows.getWallet(gone, vaultPath).id;

    const naming = (name: string) =>
      ["wallets", "keys"].flatMap((sub) =>
        readdirSync(join(vaultPath, sub)).filter((file) =>
          readFileSync(join(vaultPath, sub, file), "utf8").includes(name),
        ),
      );

    expect(naming(gone).length).toBeGreaterThan(0);

    vault.destroyWallet(gone);
    expect([...naming(gone), ...naming(goneId)]).toEqual([]);
    expect(naming(kept)).toHaveLength(2);
    vault.destroyWallet(gone);
  });
});

describe("Hyperliquid signing in the real OWS vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-signer-ows-hyperliquid-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The SDK's test key, imported into a throwaway vault; signatures are deterministic (RFC 6979).
  const passphrase = "a long enough owner passphrase";
  const vaultPath = join(dir, "vault");
  const walletId = newId("wal");
  const privateKey = Hex32.parse(vectors.privateKey);
  const address = privateKeyToAddress(privateKey).toLowerCase();
  let token = "";
  const vault = new OwsVault({ vaultPath, passphraseFile: join(dir, "no-passphrase-file") });

  beforeAll(() => {
    const wallet = ows.importWalletPrivateKey(
      walletId,
      privateKey.slice(2),
      passphrase,
      vaultPath,
      "ethereum",
    );

    token = ows.createApiKey(walletId, [wallet.id], [], passphrase, null, vaultPath).token;
  });

  /** OWS signs `payload`, the signature equals the SDK's, and the signer's check accepts it. */
  function expectVector(
    payload: HyperliquidPayload,
    expected: { r: string; s: string; v: number },
  ): HyperliquidSignature {
    const signature = vault.signHyperliquid(walletId, token, payload);
    expect({ r: BigInt(signature.r), s: BigInt(signature.s), v: signature.v }).toEqual({
      r: BigInt(expected.r),
      s: BigInt(expected.s),
      v: expected.v,
    });
    expect(isTypedSignedBy(signature, payload, address)).toBe(true);

    return signature;
  }

  it("reproduces the SDK's GTC order signatures, with and without a cloid, on both networks", () => {
    const orders = vectors.sdkTests.signatures.filter((vector) => vector.operation !== null);
    expect(orders).toHaveLength(2);

    for (const vector of orders) {
      // The SDK's order without a cloid is not one the signer builds, so that one hashes the
      // SDK's own action; the one with a cloid is built by the signer's `orderAction`.
      const action =
        vector.operation !== null && vector.cloid !== null
          ? orderAction(
              HyperliquidOrderOperation.parse(vector.operation),
              Cloid.parse(vector.cloid),
            )
          : mapFromJson(vector.action);

      const connectionId = l1ActionHash(action, vector.nonce, vector.expiresAfter);
      expectVector({ kind: "l1", network: "hyperliquid:mainnet", connectionId }, vector.mainnet);
      expectVector({ kind: "l1", network: "hyperliquid:testnet", connectionId }, vector.testnet);
    }
  });

  it("reproduces the generated order and cancel signatures that carry expiresAfter", () => {
    const { inputs, output } = vectors.generated;

    const order = orderAction(
      HyperliquidOrderOperation.parse(inputs.order.operation),
      Cloid.parse(inputs.order.cloid),
    );

    const orderId = l1ActionHash(order, output.order.nonce, output.order.expiresAfter);
    expectVector(
      { kind: "l1", network: "hyperliquid:mainnet", connectionId: orderId },
      output.order.mainnet,
    );
    expectVector(
      { kind: "l1", network: "hyperliquid:testnet", connectionId: orderId },
      output.order.testnet,
    );
    const cancel = cancelByCloidAction(inputs.cancel.asset, Cloid.parse(inputs.cancel.cloid));
    const cancelId = l1ActionHash(cancel, output.cancel.nonce, output.cancel.expiresAfter);
    expectVector(
      { kind: "l1", network: "hyperliquid:testnet", connectionId: cancelId },
      output.cancel.testnet,
    );
  });

  it("reproduces the SDK's testnet withdrawal, and a mainnet one recovers to the wallet", () => {
    const vector = vectors.sdkTests.withdraw;

    const withdraw = {
      kind: "withdraw",
      destination: Address.parse(vector.destination),
      amount: vector.amount,
      time: vector.time,
    } as const;

    expectVector({ ...withdraw, network: "hyperliquid:testnet" }, vector.testnet);
    const mainnet = { ...withdraw, network: "hyperliquid:mainnet" } as const;
    const signature = vault.signHyperliquid(walletId, token, mainnet);
    expect(isTypedSignedBy(signature, mainnet, address)).toBe(true);
    expect(isTypedSignedBy(signature, { ...mainnet, amount: "2" }, address)).toBe(false);
  });

  it("refuses the owner passphrase and a token from another wallet", () => {
    const payload: HyperliquidPayload = {
      kind: "l1",
      network: "hyperliquid:testnet",
      connectionId: `0x${"ab".repeat(32)}`,
    };

    expect(() => vault.signHyperliquid(walletId, passphrase, payload)).toThrow(VaultError);
    const otherId = newId("wal");
    const other = ows.createWallet(otherId, passphrase, 24, vaultPath);
    const otherToken = ows.createApiKey(otherId, [other.id], [], passphrase, null, vaultPath).token;
    expect(() => vault.signHyperliquid(walletId, otherToken, payload)).toThrow(VaultError);
  });
});

describe("the real OWS vault, across a restart of the signer process", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-signer-ows-"));
  const dataDir = join(dir, "data");

  const files = {
    hmac: join(dir, "hmac"),
    key: join(dir, "key"),
    passphrase: join(dir, "passphrase"),
  };

  const secret = randomBytes(32);
  const confirmSecret = randomBytes(32);
  const tokenKey = randomBytes(32);
  let child: ChildProcess | undefined;

  beforeAll(() => {
    mkdirSync(join(dataDir, "vault"), { recursive: true });
    writeFileSync(files.hmac, secret.toString("base64"));
    writeFileSync(files.key, tokenKey.toString("base64"));
    writeFileSync(files.passphrase, "a long enough owner passphrase");
  });

  afterAll(() => {
    child?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates wallets, signs both transfer kinds, lands one on chain, and keeps state across a restart", async () => {
    // First life: in-process, the same factory the server's tests use.
    const clock = new Clock();
    clock.now = realClock;
    clock.value = realClock();

    const first = createSigner({
      sqlitePath: join(dataDir, "signer.sqlite"),
      vault: new OwsVault({ vaultPath: join(dataDir, "vault"), passphraseFile: files.passphrase }),
      rpId: RP_ID,
      requestSecret: secret,
      confirmSecret,
      ...CONFIRMATION_SETTINGS,
      tokenKey,
      maxIntentTtlSeconds: 3600,
      maxAdminTtlSeconds: 86_400,
      now: realClock,
    });

    const inProcess = createSignerClient({
      baseUrl: "http://signer.test",
      secret,
      fetch: (url, init) => Promise.resolve(first.app.request(String(url), init)),
    });

    const alice = newPerson();
    const workspaceId = newId("ws");
    const walletId = newId("wal");
    const agentId = newId("agt");
    await inProcess.createWorkspace({
      workspaceId,
      adminThreshold: 1,
      approvers: [alice.credential],
    });

    const wallet = await inProcess.createWallet({
      workspaceId,
      walletId,
      kind: "agent",
      label: "w",
    });

    const policy = basePolicy({ workspaceId, walletId, agentId });
    await inProcess.setPolicy(walletId, {
      policy,
      authorization: authorize(
        {
          ...header(clock, newId("apr"), workspaceId),
          type: "set-policy",
          walletId,
          policyHash: policyHash(policy),
          previousPolicyHash: null,
        },
        [alice],
      ),
    });

    const world: World = {
      t: { client: inProcess, clock },
      workspaceId,
      walletId,
      agentId,
      people: [alice],
      address: wallet.address,
      policy,
    };

    // Fund the wallet, then sign a transfer at its real chain nonce and broadcast it.
    const funding = await funder.sendTransaction({ to: wallet.address, value: ETH });
    await chain.waitForTransactionReceipt({ hash: funding });
    const fees = await chain.estimateFeesPerGas();
    const transfer = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "1000" });

    const transferRequest = {
      intent: transfer,
      authorization: approveIntent(world, transfer),
      transaction: {
        nonce: await chain.getTransactionCount({ address: wallet.address, blockTag: "pending" }),
        gas: "21000",
        maxFeePerGas: String(fees.maxFeePerGas),
        maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
      },
    };

    const signed = await inProcess.sign(transferRequest);

    const from = await recoverTransactionAddress({
      serializedTransaction: eip1559Serialized(signed.signedTransaction),
    });

    expect(from.toLowerCase()).toBe(wallet.address);
    const before = await chain.getBalance({ address: RECIPIENT });

    const hash = await chain.sendRawTransaction({
      serializedTransaction: signed.signedTransaction,
    });

    expect(hash).toBe(signed.transactionHash);
    const receipt = await chain.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect((await chain.getBalance({ address: RECIPIENT })) - before).toBe(1000n);

    // A token transfer is signed by the same key with calldata the signer encoded.
    const token = intentFor(world, {
      type: "evm.erc20.transfer",
      token: TOKEN,
      to: RECIPIENT,
      amount: "7",
    });

    const tokenSigned = await inProcess.sign({
      intent: token,
      authorization: approveIntent(world, token),
      transaction: {
        ...transferRequest.transaction,
        nonce: transferRequest.transaction.nonce + 1,
        gas: "60000",
      },
    });

    expect(
      (
        await recoverTransactionAddress({
          serializedTransaction: eip1559Serialized(tokenSigned.signedTransaction),
        })
      ).toLowerCase(),
    ).toBe(wallet.address);
    const tokenTx = parseTransaction(tokenSigned.signedTransaction);
    expect(tokenTx.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: erc20Abi, data: tokenTx.data ?? "0x" }).args[1]).toBe(7n);
    // Granted now, used by the second life with no passkey.
    const mandate = mandateFor(world);
    await inProcess.grantMandate(mandate.id, grantRequest(world, mandate));
    first.close();

    // Second life: a new process from `node src/main.ts`, same SQLite and vault, and no owner
    // passphrase. It must still sign for existing wallets and refuse to create new ones.
    rmSync(files.passphrase);
    child = spawn(process.execPath, ["src/main.ts"], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        SIGNER_PORT: String(PORT),
        SIGNER_DATA_DIR: dataDir,
        SIGNER_HMAC_SECRET_FILE: files.hmac,
        SIGNER_KEY_FILE: files.key,
        SIGNER_VAULT_PASSPHRASE_FILE: files.passphrase,
        WEBAUTHN_RP_ID: RP_ID,
        ...confirmationEnvironment(dir, confirmSecret),
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const listening = Promise.withResolvers<void>();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes('"message":"listening"')) listening.resolve();
    });
    child.once("exit", (code) => listening.reject(new Error(`signer exited with ${code}`)));
    await listening.promise;

    const remote: SignerClient = createSignerClient({
      baseUrl: `http://127.0.0.1:${PORT}`,
      secret,
    });

    expect(await remote.health()).toEqual({ ok: true, version: "0.1.0" });

    expect(
      await remote.sign({
        ...transferRequest,
        transaction: { ...transferRequest.transaction, gas: "30000" },
      }),
    ).toEqual(signed);
    // The account nonce is the caller's to choose and may repeat under a new approval.
    const reuse = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "1" });

    const reused = await remote.sign({
      intent: reuse,
      authorization: approveIntent(world, reuse),
      transaction: transferRequest.transaction,
    });

    expect(reused.transactionHash).not.toBe(signed.transactionHash);
    await refused(
      remote.sign({
        ...transferRequest,
        authorization: {
          ...transferRequest.authorization,
          envelope: { ...transferRequest.authorization.envelope, approvalId: newId("apr") },
        },
      }),
      "assertion_invalid",
    );
    const fresh = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "2" });

    const freshSigned = await remote.sign({
      intent: fresh,
      authorization: approveIntent(world, fresh),
      transaction: { ...transferRequest.transaction, nonce: transferRequest.transaction.nonce + 2 },
    });

    expect(freshSigned.from).toBe(wallet.address);

    // A transfer under the mandate is signed by the same key, once per use.
    const mandated = {
      ...useRequest(tokenIntent(world, 9n)),
      transaction: {
        ...transferRequest.transaction,
        nonce: transferRequest.transaction.nonce + 3,
        gas: "60000",
      },
    };

    const underMandate = await remote.signUnderMandate(mandate.id, mandated);
    expect(
      (
        await recoverTransactionAddress({
          serializedTransaction: eip1559Serialized(underMandate.signedTransaction),
        })
      ).toLowerCase(),
    ).toBe(wallet.address);
    expect(await remote.signUnderMandate(mandate.id, mandated)).toEqual(underMandate);
    expect((await remote.getMandate(mandate.id)).usage.uses).toBe(1);
    await refused(
      remote.createWallet({ workspaceId, walletId: newId("wal"), kind: "agent", label: "x" }),
      "vault_error",
    );

    const exited = new Promise((resolve) => child?.once("exit", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    child = undefined;
  });
});
