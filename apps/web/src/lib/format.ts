import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/** EIP-55 mixed-case form of a lowercase address. For display only; the contract stays lowercase. */
export function checksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = keccak_256(utf8ToBytes(lower));
  let out = "0x";
  for (let index = 0; index < lower.length; index += 1) {
    const character = lower[index] ?? "";
    const byte = hash[index >> 1] ?? 0;
    const nibble = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? character.toUpperCase() : character;
  }
  return out;
}

/** "0x1234…cdef": enough to recognise an address in a list, never enough to verify one. */
export function shortAddress(address: string): string {
  const checksummed = checksumAddress(address);
  return `${checksummed.slice(0, 6)}…${checksummed.slice(-4)}`;
}

/** The full checksummed address in groups of four after the 0x, so a person can compare it piece by piece. */
export function groupedAddress(address: string): string[] {
  const body = checksumAddress(address).slice(2);
  const groups: string[] = [];
  for (let index = 0; index < body.length; index += 4) groups.push(body.slice(index, index + 4));
  return groups;
}

/** Base units to whole units without floating point: "15000000000000000", 18 → "0.015". */
export function formatUnits(amount: string | bigint, decimals: number): string {
  const value = BigInt(amount);
  if (decimals === 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeText = whole.toLocaleString("en-US");
  return fraction === "" ? wholeText : `${wholeText}.${fraction}`;
}

export class UnitsError extends Error {
  override readonly name = "UnitsError";
}

/** Whole units typed by a person to base units: "0.015", 18 → 15000000000000000n. */
export function parseUnits(text: string, decimals: number): bigint {
  const trimmed = text.trim().replaceAll(",", "");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new UnitsError("Enter a number such as 25 or 0.5.");
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new UnitsError(`This asset has at most ${decimals} decimal places.`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Share of `part` in `whole` as 0–100, for limit bars. */
export function percentOf(part: string | bigint, whole: string | bigint): number {
  const total = BigInt(whole);
  if (total === 0n) return 100;
  const share = Number((BigInt(part) * 10_000n) / total) / 100;
  return Math.min(100, Math.max(0, share));
}

const dateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function formatTime(epochSeconds: number): string {
  return dateTime.format(new Date(epochSeconds * 1000));
}

export function formatRelative(epochSeconds: number, nowSeconds: number): string {
  const delta = nowSeconds - epochSeconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)} h ago`;
  return formatTime(epochSeconds);
}

/** "4:05" or "1 h 12 min": the time left before something expires. */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "expired";
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
