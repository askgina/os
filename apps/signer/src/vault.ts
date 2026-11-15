import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Address, Hex, WalletId } from "@askgina/os-protocol";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as ows from "@open-wallet-standard/core";
import { keccak256, serializeTransaction, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
  eip712Json,
  type HyperliquidPayload,
  type HyperliquidSignature,
  payloadDigest,
} from "./venues/hyperliquid.ts";

/** An EIP-1559 transaction the signer built itself from an approved intent. */
export type EvmTransaction = TransactionSerializableEIP1559 & { chainId: number };

/**
 * Where wallet keys live. The signer decides what to sign; a vault only holds keys and signs the
 * transactions the signer hands it. There is deliberately nothing here for messages, raw hashes
 * or EIP-7702 authorizations, so no code path in the signer can reach them. The one typed-data
 * method takes a `HyperliquidPayload`, not typed data: the vault builds the typed data from it
 * with the signer's own builders (`venues/hyperliquid.ts`), so it can sign nothing else.
 *
 * The signing methods are synchronous because the signer calls them inside a SQLite transaction
 * that must not yield to the event loop between checking the ledger and storing the signature.
 */
export interface Vault {
  /** Create a new wallet with its own key. `credential` is what later unlocks it for signing. */
  createWallet(walletId: WalletId): { address: Address; credential: string };
  /** Sign one transaction and return it serialized, ready to broadcast. */
  signEvmTransaction(walletId: WalletId, credential: string, transaction: EvmTransaction): Hex;
  /** Sign one Hyperliquid L1 action hash or withdrawal with the wallet's own key. */
  signHyperliquid(
    walletId: WalletId,
    credential: string,
    payload: HyperliquidPayload,
  ): HyperliquidSignature;
  /**
   * Delete the wallet's key and every credential that unlocks it. A wallet already gone counts
   * as deleted, so a repeat after a crash completes; anything else throws `VaultError("failed")`.
   */
  destroyWallet(walletId: WalletId): void;
}

/** A vault failed. The message is fixed text from this module; it never carries key material. */
export class VaultError extends Error {
  override readonly name = "VaultError";
  readonly reason: "passphrase_missing" | "credential_rejected" | "wallet_missing" | "failed";

  constructor(reason: VaultError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

const MIN_PASSPHRASE_LENGTH = 12;

// OWS reports every failure as a plain Error whose message is the only distinguishing data, so the
// package version is pinned exactly and the mapping below is checked by the real-OWS test.
function classifyOwsError(error: unknown): VaultError {
  const message = error instanceof Error ? error.message : "";
  if (/API key (not found|expired)|decryption failed/i.test(message)) {
    return new VaultError("credential_rejected", "the vault rejected the wallet credential");
  }
  if (/not found/i.test(message)) {
    return new VaultError("wallet_missing", "the vault has no such wallet");
  }
  return new VaultError("failed", "the vault operation failed");
}

/** OWS's answer when the key or wallet a call names is not in the vault. */
const OWS_GONE = /^(API key not found|wallet not found)/i;

/** Run an OWS call that deletes something; finding nothing to delete is success. */
function owsDelete(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && OWS_GONE.test(error.message)) return;
    throw new VaultError("failed", "the vault could not delete the wallet");
  }
}

function owsCall<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw classifyOwsError(error);
  }
}

function splitSignature(signature: string, recoveryId: number | undefined) {
  const hex = signature.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) {
    throw new VaultError("failed", "the vault returned a malformed signature");
  }
  return {
    r: `0x${hex.slice(0, 64)}` as const,
    s: `0x${hex.slice(64, 128)}` as const,
    yParity: recoveryId ?? Number.parseInt(hex.slice(128), 16) % 27,
  };
}

/**
 * The `{ r, s, v }` form Hyperliquid's request body carries, from a 65-byte `r ‖ s ‖ v`
 * signature. OWS 1.4.5 reports a typed-data signature's recovery as `v` (27 or 28), the same as
 * its last byte; a recovery id that disagrees with that byte is refused.
 */
function hyperliquidSignature(
  signature: string,
  recoveryId: number | undefined,
): HyperliquidSignature {
  const hex = signature.replace(/^0x/, "").toLowerCase();
  const malformed = new VaultError("failed", "the vault returned a malformed signature");
  if (!/^[0-9a-f]{130}$/.test(hex)) throw malformed;
  const parity = (value: number) => (value >= 27 ? value - 27 : value);
  const yParity = parity(Number.parseInt(hex.slice(128), 16));
  if (yParity !== 0 && yParity !== 1) throw malformed;
  if (recoveryId !== undefined && parity(recoveryId) !== yParity) throw malformed;
  return {
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
    v: yParity === 0 ? 27 : 28,
  };
}

/** Refuses anything but a scoped `ows_key_` token; anything else would be the owner passphrase. */
function assertScopedToken(credential: string): void {
  if (!credential.startsWith("ows_key_")) {
    throw new VaultError("credential_rejected", "the wallet credential is not a scoped token");
  }
}

/**
 * The Open Wallet Standard vault, used only as an encrypted key store.
 *
 * - One OWS wallet, with its own mnemonic, per wallet id: an OWS key file holds a whole mnemonic,
 *   so wallets derived from one mnemonic would share a blast radius.
 * - One `ows_key_` token per wallet is the credential. It carries no OWS policy: OWS policy sees
 *   only a chain argument the caller supplies and its files can be overwritten without a
 *   credential, so the signer enforces everything itself and OWS enforces nothing.
 * - The owner passphrase is read from its file only while a wallet is created. Without the file
 *   the vault still signs for existing wallets and refuses to create new ones.
 */
export class OwsVault implements Vault {
  readonly #vaultPath: string;
  readonly #passphraseFile: string;

  constructor(options: { vaultPath: string; passphraseFile: string }) {
    this.#vaultPath = options.vaultPath;
    this.#passphraseFile = options.passphraseFile;
  }

  createWallet(walletId: WalletId): { address: Address; credential: string } {
    if (!existsSync(this.#passphraseFile)) {
      throw new VaultError("passphrase_missing", "the vault passphrase file is absent");
    }
    const passphrase = readFileSync(this.#passphraseFile, "utf8").trim();
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new VaultError("passphrase_missing", "the vault passphrase is too short");
    }
    let wallet: ows.WalletInfo;
    try {
      wallet = ows.createWallet(walletId, passphrase, 24, this.#vaultPath);
    } catch (error) {
      // An earlier attempt may have created the wallet and then died before the signer recorded
      // it. Wallet names are wallet ids that only the signer asks for, so a wallet with this
      // name is that leftover: adopt it and give it a fresh token (the old one was never stored).
      try {
        wallet = ows.getWallet(walletId, this.#vaultPath);
      } catch {
        throw classifyOwsError(error);
      }
    }
    const account = wallet.accounts.find((candidate) => candidate.chainId.startsWith("eip155:"));
    if (!account) throw new VaultError("failed", "the new wallet has no EVM account");
    const key = owsCall(() =>
      ows.createApiKey(walletId, [wallet.id], [], passphrase, null, this.#vaultPath),
    );
    return { address: account.address.toLowerCase() as Address, credential: key.token };
  }

  signEvmTransaction(walletId: WalletId, credential: string, transaction: EvmTransaction): Hex {
    // Anything else would be taken as the owner passphrase, which bypasses OWS entirely.
    assertScopedToken(credential);
    const unsigned = serializeTransaction({ ...transaction, type: "eip1559" });
    // The chain handed to OWS comes from the transaction itself; OWS would sign any bytes for
    // whatever chain it is told.
    const result = owsCall(() =>
      ows.signTransaction(
        walletId,
        `eip155:${transaction.chainId}`,
        unsigned,
        credential,
        0,
        this.#vaultPath,
      ),
    );
    return serializeTransaction(
      { ...transaction, type: "eip1559" },
      splitSignature(result.signature, result.recoveryId ?? undefined),
    ) as Hex;
  }

  /**
   * Sign the typed data built from `payload` here, never typed data from a caller. OWS checks the
   * domain's `chainId` against the chain argument, so the argument is that same domain chain:
   * `eip155:1337` for an L1 action, the user-signed chain for a withdrawal.
   */
  signHyperliquid(
    walletId: WalletId,
    credential: string,
    payload: HyperliquidPayload,
  ): HyperliquidSignature {
    assertScopedToken(credential);
    const { chain, json } = eip712Json(payload);
    const result = owsCall(() =>
      ows.signTypedData(walletId, chain, json, credential, 0, this.#vaultPath),
    );
    return hyperliquidSignature(result.signature, result.recoveryId ?? undefined);
  }

  /**
   * Revoke every token named after the wallet (an OWS key file holds its own encrypted copy of
   * the wallet's secret), then delete the wallet file. Tokens first: a crash in between leaves a
   * wallet file nothing can unlock but the owner passphrase, and the repeat deletes it.
   */
  destroyWallet(walletId: WalletId): void {
    let keys: unknown[];
    try {
      keys = ows.listApiKeys(this.#vaultPath);
    } catch {
      throw new VaultError("failed", "the vault could not list its keys");
    }
    for (const key of keys) {
      const { id, name } = (key ?? {}) as { id?: unknown; name?: unknown };
      if (name !== walletId || typeof id !== "string") continue;
      owsDelete(() => ows.revokeApiKey(id, this.#vaultPath));
    }
    owsDelete(() => ows.deleteWallet(walletId, this.#vaultPath));
  }
}

/**
 * The wallet's secret (its mnemonic) from the OWS vault, unlocked with the owner passphrase. A
 * module function and not a `Vault` method, so nothing the HTTP routes reach can call it: only the
 * admin CLI on the signer host (`export-wallet`, owner decision D4).
 */
export function exportOwsWalletSecret(
  options: { vaultPath: string; passphraseFile: string },
  walletId: WalletId,
): string {
  if (!existsSync(options.passphraseFile)) {
    throw new VaultError("passphrase_missing", "the vault passphrase file is absent");
  }
  const passphrase = readFileSync(options.passphraseFile, "utf8").trim();
  return owsCall(() => ows.exportWallet(walletId, passphrase, options.vaultPath));
}

/**
 * An in-memory vault with real secp256k1 keys, for tests in this and other packages. Its
 * transactions verify on chain and recover to the wallet's address. Never use it for real funds:
 * keys vanish with the process.
 */
export function createTestVault(): Vault {
  const wallets = new Map<string, { privateKey: Uint8Array; credential: string }>();
  const unlock = (walletId: WalletId, credential: string) => {
    const wallet = wallets.get(walletId);
    if (!wallet) throw new VaultError("wallet_missing", "the vault has no such wallet");
    const expected = Buffer.from(wallet.credential);
    const given = Buffer.from(credential);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new VaultError("credential_rejected", "the vault rejected the wallet credential");
    }
    return wallet;
  };
  const signDigest = (digest: Hex, privateKey: Uint8Array) =>
    secp256k1.Signature.fromBytes(
      secp256k1.sign(Buffer.from(digest.slice(2), "hex"), privateKey, {
        prehash: false,
        format: "recovered",
      }),
      "recovered",
    );
  return {
    createWallet(walletId) {
      if (wallets.has(walletId)) throw new VaultError("failed", "the wallet already exists");
      const privateKey = secp256k1.utils.randomSecretKey();
      const credential = `test_${randomBytes(24).toString("base64url")}`;
      wallets.set(walletId, { privateKey, credential });
      const address = privateKeyToAddress(`0x${Buffer.from(privateKey).toString("hex")}`);
      return { address: address.toLowerCase() as Address, credential };
    },
    signEvmTransaction(walletId, credential, transaction) {
      const wallet = unlock(walletId, credential);
      const unsigned = serializeTransaction({ ...transaction, type: "eip1559" });
      const signature = signDigest(keccak256(unsigned), wallet.privateKey);
      return serializeTransaction(
        { ...transaction, type: "eip1559" },
        {
          r: `0x${signature.r.toString(16).padStart(64, "0")}`,
          s: `0x${signature.s.toString(16).padStart(64, "0")}`,
          yParity: signature.recovery ?? 0,
        },
      ) as Hex;
    },
    signHyperliquid(walletId, credential, payload) {
      const wallet = unlock(walletId, credential);
      const signature = signDigest(payloadDigest(payload), wallet.privateKey);
      return {
        r: `0x${signature.r.toString(16).padStart(64, "0")}`,
        s: `0x${signature.s.toString(16).padStart(64, "0")}`,
        v: signature.recovery === 1 ? 28 : 27,
      };
    },
    destroyWallet(walletId) {
      wallets.delete(walletId);
    },
  };
}
