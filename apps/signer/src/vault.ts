import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Address, Hex, WalletId } from "@askgina/os-protocol";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as ows from "@open-wallet-standard/core";
import { keccak256, serializeTransaction, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/** An EIP-1559 transaction the signer built itself from an approved intent. */
export type EvmTransaction = TransactionSerializableEIP1559 & { chainId: number };

/**
 * Where wallet keys live. The signer decides what to sign; a vault only holds keys and signs the
 * transactions the signer hands it. There is deliberately nothing here for messages, typed data,
 * raw hashes or EIP-7702 authorizations, so no code path in the signer can reach them.
 *
 * Both methods are synchronous because the signer calls `signEvmTransaction` inside a SQLite
 * transaction that must not yield to the event loop between checking the ledger and storing the
 * signature.
 */
export interface Vault {
  /** Create a new wallet with its own key. `credential` is what later unlocks it for signing. */
  createWallet(walletId: WalletId): { address: Address; credential: string };
  /** Sign one transaction and return it serialized, ready to broadcast. */
  signEvmTransaction(walletId: WalletId, credential: string, transaction: EvmTransaction): Hex;
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
    if (!credential.startsWith("ows_key_")) {
      // Anything else would be taken as the owner passphrase, which bypasses OWS entirely.
      throw new VaultError("credential_rejected", "the wallet credential is not a scoped token");
    }
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
}

/**
 * An in-memory vault with real secp256k1 keys, for tests in this and other packages. Its
 * transactions verify on chain and recover to the wallet's address. Never use it for real funds:
 * keys vanish with the process.
 */
export function createTestVault(): Vault {
  const wallets = new Map<string, { privateKey: Uint8Array; credential: string }>();
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
      const wallet = wallets.get(walletId);
      if (!wallet) throw new VaultError("wallet_missing", "the vault has no such wallet");
      const expected = Buffer.from(wallet.credential);
      const given = Buffer.from(credential);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        throw new VaultError("credential_rejected", "the vault rejected the wallet credential");
      }
      const unsigned = serializeTransaction({ ...transaction, type: "eip1559" });
      const hash = Buffer.from(keccak256(unsigned).slice(2), "hex");
      const signature = secp256k1.Signature.fromBytes(
        secp256k1.sign(hash, wallet.privateKey, { prehash: false, format: "recovered" }),
        "recovered",
      );
      return serializeTransaction(
        { ...transaction, type: "eip1559" },
        {
          r: `0x${signature.r.toString(16).padStart(64, "0")}`,
          s: `0x${signature.s.toString(16).padStart(64, "0")}`,
          yParity: signature.recovery ?? 0,
        },
      ) as Hex;
    },
  };
}
