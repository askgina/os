import type { AssetBalance, ChainInfo } from "@askgina/os-api";
import { formatUnits, shortAddress } from "@/lib/format.ts";

/** Native coins on EVM chains have 18 decimals. */
export const NATIVE_DECIMALS = 18;

export interface AssetInfo {
  symbol: string;
  /** Null for a token this page has no balance for: its amounts are shown in base units. */
  decimals: number | null;
}

/** What to call an asset and how to scale it, from the chain list and the wallet's balances. */
export function assetInfo(
  chainId: string,
  asset: string,
  chains: readonly ChainInfo[],
  balances: readonly AssetBalance[] = [],
): AssetInfo {
  const balance = balances.find((item) => item.chainId === chainId && item.asset === asset);

  if (balance) return { symbol: balance.symbol, decimals: balance.decimals };

  if (asset === "native") {
    const chain = chains.find((item) => item.chainId === chainId);

    return { symbol: chain?.nativeSymbol ?? "native coin", decimals: NATIVE_DECIMALS };
  }

  return { symbol: `token ${shortAddress(asset)}`, decimals: null };
}

/** "0.5 ETH", or "500000 base units of token 0x12…" when the decimals are unknown. */
export function formatAsset(amount: string, info: AssetInfo): string {
  if (info.decimals === null) return `${amount} base units of ${info.symbol}`;

  return `${formatUnits(amount, info.decimals)} ${info.symbol}`;
}

export function chainName(chainId: string, chains: readonly ChainInfo[]): string {
  return chains.find((item) => item.chainId === chainId)?.name ?? chainId;
}
