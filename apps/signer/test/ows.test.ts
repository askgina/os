import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, policyHash } from "@askgina/os-protocol";
import { createSignerClient, type SignerClient } from "@askgina/os-protocol/signer";
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
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSigner, OwsVault } from "../src/index.ts";
import {
  approveIntent,
  authorize,
  basePolicy,
  Clock,
  ETH,
  header,
  intentFor,
  newPerson,
  RECIPIENT,
  RP,
  refused,
  TOKEN,
  type World,
} from "./harness.ts";

const RPC = "http://127.0.0.1:55545";
const PORT = 55701;
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

describe("the real OWS vault, across a restart of the signer process", () => {
  const dir = mkdtempSync(join(tmpdir(), "osbuild-signer-ows-"));
  const dataDir = join(dir, "data");
  const files = {
    hmac: join(dir, "hmac"),
    key: join(dir, "key"),
    passphrase: join(dir, "passphrase"),
  };
  const secret = randomBytes(32);
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
      relyingParty: RP,
      requestSecret: secret,
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
      serializedTransaction: signed.signedTransaction as `0x02${string}`,
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
          serializedTransaction: tokenSigned.signedTransaction as `0x02${string}`,
        })
      ).toLowerCase(),
    ).toBe(wallet.address);
    const tokenTx = parseTransaction(tokenSigned.signedTransaction);
    expect(tokenTx.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: erc20Abi, data: tokenTx.data ?? "0x" }).args[1]).toBe(7n);
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
        WEBAUTHN_RP_ID: RP.id,
        WEBAUTHN_ORIGINS: RP.origins.join(","),
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
