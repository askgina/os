import type { AssetBalance, ChainInfo } from "@askgina/os-api";
import type { Address, AssetRef, ChainId } from "@askgina/os-protocol";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  erc20Abi,
  type Hex,
  http,
  type PublicClient,
  TransactionNotFoundError,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
} from "viem";
import type { ChainConfig, Config } from "../config.ts";
import type { AppContext, Chains } from "../context.ts";

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface SimulationResult {
  ok: boolean;
  blockNumber: number;
  gasEstimate: bigint | null;
  error: string | null;
}

export interface FeeQuote {
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export type ReceiptState =
  | { state: "missing" }
  | { state: "pending"; blockNumber: number }
  | { state: "confirmed" | "reverted"; blockNumber: number };

/** Longest revert reason kept. It is shown to people and agents, so it stays short and plain. */
const REASON_LENGTH = 160;

/** Contract-supplied text, reduced to characters that cannot disguise anything on a card. */
export function sanitizeReason(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 _:.,()'"/#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_LENGTH);
}

/**
 * Read access to the configured chains. Every call goes to the chain's own RPC endpoint; token
 * metadata is cached because it does not change.
 */
export class ChainAccess implements Chains {
  readonly #chains = new Map<ChainId, { config: ChainConfig; client: PublicClient }>();
  readonly #tokens = new Map<string, TokenInfo>();
  /** Chains whose endpoint answered with the configured chain id. */
  readonly #verified = new Set<ChainId>();

  constructor(chains: readonly ChainConfig[]) {
    for (const config of chains) {
      const client = createPublicClient({
        transport: http(config.rpcUrl, { retryCount: 1, timeout: 15_000 }),
      }) as PublicClient;

      this.#chains.set(config.chainId, { config, client });
    }
  }

  list(): ChainInfo[] {
    return [...this.#chains.values()].map(({ config }) => ({
      chainId: config.chainId,
      name: config.name,
      nativeSymbol: config.nativeSymbol,
      explorerUrl: config.explorerUrl,
    }));
  }

  has(chainId: string): chainId is ChainId {
    return this.#chains.has(chainId as ChainId);
  }

  config(chainId: ChainId): ChainConfig {
    return this.#entry(chainId).config;
  }

  client(chainId: ChainId): PublicClient {
    return this.#entry(chainId).client;
  }

  /**
   * The chain's client, after checking once that its endpoint serves the configured chain. A
   * misconfigured endpoint would otherwise show one chain's balances and simulations on another
   * chain's approval card. An RPC failure is not cached, so the check runs again next time.
   */
  async #ready(chainId: ChainId): Promise<PublicClient> {
    const { client, config } = this.#entry(chainId);

    if (this.#verified.has(chainId)) return client;
    let answered: number;

    try {
      answered = await client.getChainId();
    } catch {
      throw new ChainError("rpc_unavailable");
    }

    if (`eip155:${answered}` !== config.chainId) throw new ChainError("chain_mismatch");
    this.#verified.add(chainId);

    return client;
  }

  explorerLink(chainId: ChainId, hash: string): string | null {
    const base = this.#chains.get(chainId)?.config.explorerUrl;

    return base ? `${base.replace(/\/$/, "")}/tx/${hash}` : null;
  }

  async balances(
    address: Address,
    assets: readonly { chainId: ChainId; asset: AssetRef }[],
  ): Promise<AssetBalance[]> {
    return Promise.all(
      assets.map(async ({ chainId, asset }) => {
        const client = await this.#ready(chainId);

        if (asset === "native") {
          return {
            chainId,
            asset,
            symbol: this.config(chainId).nativeSymbol,
            decimals: 18,
            amount: (await client.getBalance({ address })).toString(),
          };
        }

        const [info, amount] = await Promise.all([
          this.token(chainId, asset),
          client.readContract({
            address: asset,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }),
        ]);

        return { chainId, asset, ...info, amount: amount.toString() };
      }),
    );
  }

  async token(chainId: ChainId, token: Address): Promise<TokenInfo> {
    const key = `${chainId}|${token}`;
    const cached = this.#tokens.get(key);

    if (cached) return cached;
    const client = await this.#ready(chainId);

    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);

    const info = { symbol: sanitizeReason(symbol).slice(0, 12) || "TOKEN", decimals };
    this.#tokens.set(key, info);

    return info;
  }

  /** Run the call against the latest block and estimate its gas. A revert is a result, not an error. */
  async simulate(input: {
    chainId: ChainId;
    from: Address;
    to: Address;
    value: bigint;
    data: Hex | undefined;
  }): Promise<SimulationResult> {
    const client = await this.#ready(input.chainId);
    const block = await client.getBlock({ blockTag: "latest" });

    const request = {
      account: input.from,
      to: input.to,
      value: input.value,
      ...(input.data === undefined ? {} : { data: input.data }),
      blockNumber: block.number,
    };

    try {
      await client.call(request);

      const gasEstimate = await client.estimateGas({
        account: input.from,
        to: input.to,
        value: input.value,
        ...(input.data === undefined ? {} : { data: input.data }),
      });

      return { ok: true, blockNumber: Number(block.number), gasEstimate, error: null };
    } catch (error) {
      return {
        ok: false,
        blockNumber: Number(block.number),
        gasEstimate: null,
        error: revertReason(error),
      };
    }
  }

  async fees(chainId: ChainId): Promise<FeeQuote> {
    const client = await this.#ready(chainId);

    const [block, tip] = await Promise.all([
      client.getBlock({ blockTag: "latest" }),
      client.estimateMaxPriorityFeePerGas().catch(() => 1_000_000_000n),
    ]);

    return { baseFeePerGas: block.baseFeePerGas ?? 0n, maxPriorityFeePerGas: tip };
  }

  async pendingNonce(chainId: ChainId, address: Address): Promise<number> {
    return (await this.#ready(chainId)).getTransactionCount({ address, blockTag: "pending" });
  }

  /** The newest block's number, read fresh. An RPC failure throws `rpc_unavailable`. */
  async head(chainId: ChainId): Promise<bigint> {
    const client = await this.#ready(chainId);

    try {
      return await client.getBlockNumber({ cacheTime: 0 });
    } catch {
      throw new ChainError("rpc_unavailable");
    }
  }

  /**
   * The account nonce of `address` as of block `blockNumber`: how many of its transactions the
   * chain up to that block includes. An RPC failure throws `rpc_unavailable`, never a guess.
   */
  async latestNonce(chainId: ChainId, address: Address, blockNumber: bigint): Promise<number> {
    const client = await this.#ready(chainId);

    try {
      return await client.getTransactionCount({ address, blockNumber });
    } catch {
      throw new ChainError("rpc_unavailable");
    }
  }

  /**
   * Send a signed transaction. Sending the same bytes again is harmless, so a node that already
   * has it ("already known") or already mined it ("nonce too low" while our hash exists) counts
   * as success.
   */
  async broadcast(chainId: ChainId, raw: Hex, hash: Hex): Promise<void> {
    const client = await this.#ready(chainId);

    try {
      await client.sendRawTransaction({ serializedTransaction: raw });
    } catch (error) {
      const text = errorText(error);

      if (/already known|known transaction|already imported/i.test(text)) return;

      if (/nonce too low|nonce has already been used/i.test(text)) {
        const existing = await client.getTransaction({ hash }).catch(() => null);

        if (existing !== null) return;
      }

      throw new ChainError("broadcast_failed");
    }
  }

  /**
   * Whether the chain knows the transaction (pending or mined). Only a definite "not found" is
   * `false`; an RPC failure throws, because it says nothing about the transaction.
   */
  async known(chainId: ChainId, hash: Hex): Promise<boolean> {
    const client = await this.#ready(chainId);

    try {
      await client.getTransaction({ hash });

      return true;
    } catch (error) {
      if (error instanceof TransactionNotFoundError) return false;
      throw new ChainError("rpc_unavailable");
    }
  }

  /**
   * The transaction's receipt. `missing` means the node answered and has none; an RPC failure
   * throws, so an outage is never read as a missing transaction.
   */
  async receipt(chainId: ChainId, hash: Hex): Promise<ReceiptState> {
    const client = await this.#ready(chainId);
    let receipt: TransactionReceipt;
    let head: bigint;

    try {
      receipt = await client.getTransactionReceipt({ hash });
      // viem caches the block number for a few seconds; a stale head would undercount depth.
      head = await client.getBlockNumber({ cacheTime: 0 });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return { state: "missing" };
      throw new ChainError("rpc_unavailable");
    }

    const depth = head - receipt.blockNumber + 1n;
    const blockNumber = Number(receipt.blockNumber);

    if (depth < BigInt(this.config(chainId).confirmations))
      return { state: "pending", blockNumber };

    return { state: receipt.status === "success" ? "confirmed" : "reverted", blockNumber };
  }

  #entry(chainId: ChainId) {
    const entry = this.#chains.get(chainId);

    if (!entry) throw new ChainError("chain_not_configured");

    return entry;
  }
}

/** A chain call failed. The code is stable; the RPC's own message is never passed on. */
export class ChainError extends Error {
  override readonly name = "ChainError";
  readonly code: string;

  constructor(code: string) {
    super(`chain access failed: ${code}`);
    this.code = code;
  }
}

function errorText(error: unknown): string {
  if (error instanceof BaseError) return `${error.shortMessage} ${error.details ?? ""}`;

  return error instanceof Error ? error.message : String(error);
}

function revertReason(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);

    if (reverted instanceof ContractFunctionRevertedError && reverted.reason) {
      return sanitizeReason(reverted.reason) || "reverted";
    }

    return sanitizeReason(error.details || error.shortMessage) || "reverted";
  }

  return "reverted";
}

export function createChains(config: Config): ChainAccess {
  return new ChainAccess(config.chains);
}

/** The context's chains with the parts only execution uses. */
export function chainAccess(ctx: Pick<AppContext, "chains">): ChainAccess {
  if (!(ctx.chains instanceof ChainAccess)) {
    throw new Error("the context's chains were not created by createChains()");
  }

  return ctx.chains;
}
