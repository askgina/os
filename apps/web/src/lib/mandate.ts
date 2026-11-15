import { MandateDraft, type MandateEndedReason, type MandateStatus } from "@askgina/os-api";
import { MANDATE_MAX_SECONDS } from "@askgina/os-protocol";
import { parseUnits, UnitsError } from "./format.ts";

/**
 * Pure helpers for approving payments in advance (mandates): the editor's choices, its draft, the
 * worst case and the sentences the pages show. Nothing here talks to the server.
 */

/** The longest life the signer grants unless its operator chose otherwise (`SIGNER_MAX_MANDATE_SECONDS`). */
export const DEFAULT_LONGEST_MANDATE_SECONDS = 604_800;

/**
 * How far the "In 7 days" choice stays inside that longest life. The server starts a mandate when
 * the request reaches it, and this browser's clock may run a little ahead of the server's.
 */
export const CLOCK_SLACK_SECONDS = 300;

/** The windows the editor offers: the wallet policy's own 24 hours, one hour, and a week. */
export const WINDOW_CHOICES = [3_600, 86_400, 604_800] as const;

/**
 * The most that can leave the wallet in one asset under a mandate: `min(maxTotal, maxUses ×
 * maxPerAction)`, as `mandateWorstCase` in the protocol computes it for a granted one.
 */
export function worstCase(
  limit: { maxPerAction: bigint; maxTotal: bigint },
  maxUses: number,
): bigint {
  const byUses = BigInt(maxUses) * limit.maxPerAction;
  // biome-ignore lint/complexity/useMathMinMax: Math.min does not take bigints
  return byUses < limit.maxTotal ? byUses : limit.maxTotal;
}

// --- when it ends -------------------------------------------------------------------------------

export type EndChoiceId = "today" | "friday" | "week";

export interface EndChoice {
  id: EndChoiceId;
  label: string;
  /** Epoch seconds: the first second no payment may be signed under it. */
  notAfter: number;
}

const FRIDAY = 5;

/** 23:59 on the day `days` after `now`'s, in the viewer's own time zone, as epoch seconds. */
function endOfDay(now: Date, days: number): number {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59, 0, 0);
  return Math.floor(end.getTime() / 1000);
}

/**
 * The end times the editor offers, in the viewer's own time zone: the end of today, the end of
 * the coming Friday (not offered on a Friday, where it is today), and 7 days from now. Only
 * choices still ahead and inside the signer's default longest life are returned.
 */
export function endChoices(now: Date): EndChoice[] {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const latest = nowSeconds + DEFAULT_LONGEST_MANDATE_SECONDS - CLOCK_SLACK_SECONDS;
  const choices: EndChoice[] = [{ id: "today", label: "End of today", notAfter: endOfDay(now, 0) }];
  const toFriday = (FRIDAY - now.getDay() + 7) % 7;
  if (toFriday > 0) {
    choices.push({ id: "friday", label: "End of Friday", notAfter: endOfDay(now, toFriday) });
  }
  choices.push({ id: "week", label: "In 7 days", notAfter: Math.floor(latest / 60) * 60 });
  return choices.filter((choice) => choice.notAfter > nowSeconds && choice.notAfter <= latest);
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The value of an `<input type="datetime-local">` ("2026-11-21T18:00") as epoch seconds in the
 * viewer's own time zone, or null when it is not a real date and time.
 */
export function parseLocalDateTime(text: string): number | null {
  const match = LOCAL_DATE_TIME.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const date = new Date(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
    second ?? 0,
    0,
  );
  // `Date` rolls an impossible date (Feb 30) over into the next month; such input is refused.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== (month ?? 1) - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

/** Epoch seconds as an `<input type="datetime-local">` value, in the viewer's own time zone. */
export function localDateTimeValue(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

const endTime = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const zoneName = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" });

/** "Fri, Nov 21, 6:00 PM (your time, GMT+1)": an end time in the viewer's own time zone, named. */
export function formatEndTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const zone = zoneName.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  return `${endTime.format(date)} (your time${zone ? `, ${zone}` : ""})`;
}

/** "6 days 23 h", "3 h 12 min", "12 min": how long until something ends. */
export function formatTimeLeft(seconds: number): string {
  if (seconds <= 0) return "no time";
  if (seconds < 60) return "less than a minute";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    const dayText = `${days} ${days === 1 ? "day" : "days"}`;
    return hours > 0 ? `${dayText} ${hours} h` : dayText;
  }
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

/** "1 hour", "24 hours", "7 days": the rolling window a mandate's window cap is counted over. */
export function formatWindow(seconds: number): string {
  if (seconds === 3_600) return "1 hour";
  if (seconds % 86_400 === 0 && seconds > 86_400) return `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

// --- the sentences ------------------------------------------------------------------------------

export interface SentenceAsset {
  /** Each amount already formatted with its unit, for example "100 USDC". */
  perAction: string;
  perWindow: string;
  total: string;
}

/**
 * The whole mandate in one sentence a person can check, for example "Let Invoice payer pay up to
 * 100 USDC at a time to 3 listed recipients, at most 500 USDC in any 24 hours and 1,000 USDC in
 * total, at most 20 payments, until Fri, Nov 21, 6:00 PM (your time, GMT+1)."
 */
export function mandateSentence(input: {
  agent: string;
  assets: readonly SentenceAsset[];
  recipients: number;
  windowSeconds: number;
  maxUses: number;
  ends: string;
}): string {
  const to =
    input.recipients === 1 ? "1 listed recipient" : `${input.recipients} listed recipients`;
  const payments = input.maxUses === 1 ? "1 payment" : `${input.maxUses} payments`;
  const window = formatWindow(input.windowSeconds);
  const [only] = input.assets;
  if (only && input.assets.length === 1) {
    return `Let ${input.agent} pay up to ${only.perAction} at a time to ${to}, at most ${only.perWindow} in any ${window} and ${only.total} in total, at most ${payments}, until ${input.ends}.`;
  }
  const caps = input.assets
    .map(
      (asset) =>
        `up to ${asset.perAction} at a time, ${asset.perWindow} in any ${window} and ${asset.total} in total`,
    )
    .join("; ");
  return `Let ${input.agent} pay ${to}, at most ${payments}, until ${input.ends}: ${caps}.`;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The worst case, set apart on every card: "At most 1,000 USDC can leave this wallet under this
 * approval, plus network fees of at most 0.002 ETH per payment (0.04 ETH in all)."
 */
export function worstCaseSentence(input: {
  amounts: readonly string[];
  feePerPayment: string;
  feeTotal: string;
}): string {
  return `At most ${listed(input.amounts)} can leave this wallet under this approval, plus network fees of at most ${input.feePerPayment} per payment (${input.feeTotal} in all).`;
}

export const mandateStatusLabel: Record<MandateStatus, string> = {
  active: "Active",
  not_yet_valid: "Not started",
  expired: "Ended",
  exhausted: "Used up",
  revoked: "Revoked",
};

/** Why a mandate ended, in words. Typed as a complete record, so a new reason fails the type check. */
export const endedReasonSentence: Record<MandateEndedReason, string> = {
  revoked: "Someone who can approve revoked it.",
  grantor_removed:
    "A passkey that approved it no longer approves in this workspace, so it ended with it.",
  operator:
    "The operator ended it on the signer's host, or the signer was restored from a backup that does not hold it.",
  expired: "Its end time passed.",
  exhausted: "Its payments, or every amount it allowed, are used up.",
  agent_disabled: "Its agent was disabled.",
};

// --- the editor's draft -------------------------------------------------------------------------

export interface MandateAssetInput {
  chainId: string;
  asset: string;
  /** Null when the token's decimals are not known here: its amounts are typed in base units. */
  decimals: number | null;
  /** How the asset is named in messages, for example "ETH on Base". */
  label: string;
  maxPerAction: string;
  maxPerWindow: string;
  maxTotal: string;
}

export interface MandateForm {
  agentId: string;
  /** One address per line (spaces and commas also separate them). */
  recipients: string;
  /** One row per asset the wallet's limits allow; a row left empty is left out. */
  assets: readonly MandateAssetInput[];
  windowSeconds: number;
  maxUses: string;
  /** The network fee ceiling per payment, in whole units of the native coin. */
  feePerPayment: string;
  /** Null until the person chooses when it ends. */
  notAfter: number | null;
  purpose: string;
}

/** A form that cannot become a draft, with the sentence to show next to it. */
export class MandateFormError extends Error {
  override readonly name = "MandateFormError";
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_DECIMALS = 18;

function parseRecipients(text: string): `0x${string}`[] {
  const words = text.split(/[\s,]+/).filter((word) => word !== "");
  if (words.length === 0) {
    throw new MandateFormError(
      "Add at least one recipient: an approval in advance pays only listed addresses.",
    );
  }
  const addresses = new Set<`0x${string}`>();
  for (const word of words) {
    const lower = word.toLowerCase();
    if (!ADDRESS.test(lower))
      throw new MandateFormError(`Recipients: "${word}" is not an address.`);
    if (lower === ZERO_ADDRESS) {
      throw new MandateFormError("Recipients: the zero address cannot receive a payment.");
    }
    addresses.add(lower as `0x${string}`);
  }
  if (addresses.size > 64) throw new MandateFormError("Recipients: at most 64 addresses.");
  return [...addresses];
}

function amountOf(text: string, decimals: number | null, label: string, field: string): bigint {
  try {
    const amount = parseUnits(text, decimals ?? 0);
    if (amount === 0n) throw new MandateFormError(`${label}: ${field} must be above zero.`);
    return amount;
  } catch (error) {
    if (error instanceof UnitsError)
      throw new MandateFormError(`${label}, ${field}: ${error.message}`);
    throw error;
  }
}

function assetLimit(input: MandateAssetInput) {
  const typed = [input.maxPerAction, input.maxPerWindow, input.maxTotal].map((text) => text.trim());
  if (typed.every((text) => text === "")) return null;
  if (typed.some((text) => text === "")) {
    throw new MandateFormError(
      `${input.label}: fill in all three limits, or none to leave this asset out.`,
    );
  }
  const maxPerAction = amountOf(
    input.maxPerAction,
    input.decimals,
    input.label,
    "the most per payment",
  );
  const maxPerWindow = amountOf(
    input.maxPerWindow,
    input.decimals,
    input.label,
    "the most in the window",
  );
  const maxTotal = amountOf(input.maxTotal, input.decimals, input.label, "the most in total");
  if (maxPerAction > maxPerWindow) {
    throw new MandateFormError(
      `${input.label}: the most per payment cannot be more than the most in the window.`,
    );
  }
  if (maxPerWindow > maxTotal) {
    throw new MandateFormError(
      `${input.label}: the most in the window cannot be more than the most in total.`,
    );
  }
  return {
    chainId: input.chainId,
    asset: input.asset,
    maxPerAction: maxPerAction.toString(),
    maxPerWindow: maxPerWindow.toString(),
    maxTotal: maxTotal.toString(),
  };
}

/**
 * The request the editor sends, from what a person typed: whole units become base units and
 * every rule the protocol enforces on a mandate's own fields is checked here, with a sentence
 * that names the field. Whether the wallet's limits allow it is the server's and the signer's
 * to decide; their refusal is shown with its reason.
 */
export function mandateDraft(form: MandateForm, nowSeconds: number): MandateDraft {
  if (form.agentId === "") throw new MandateFormError("Choose the agent that may pay.");
  const recipients = parseRecipients(form.recipients);
  const assets = form.assets.flatMap((input) => {
    const limit = assetLimit(input);
    return limit ? [limit] : [];
  });
  if (assets.length === 0) {
    throw new MandateFormError("Fill in the limits of at least one asset.");
  }
  const maxUses = /^\d{1,5}$/.test(form.maxUses.trim()) ? Number(form.maxUses.trim()) : 0;
  if (maxUses < 1 || maxUses > 10_000) {
    throw new MandateFormError("Number of payments: a whole number from 1 to 10,000.");
  }
  let fee: bigint;
  try {
    fee = parseUnits(form.feePerPayment, NATIVE_DECIMALS);
  } catch (error) {
    if (error instanceof UnitsError) {
      throw new MandateFormError(`Network fee per payment: ${error.message}`);
    }
    throw error;
  }
  if (fee === 0n) throw new MandateFormError("Network fee per payment must be above zero.");
  if (form.windowSeconds < 3_600 || form.windowSeconds > 604_800) {
    throw new MandateFormError("The window must be from 1 hour to 7 days.");
  }
  if (form.notAfter === null) throw new MandateFormError("Choose when it ends.");
  if (form.notAfter <= nowSeconds) throw new MandateFormError("The end time has already passed.");
  if (form.notAfter - nowSeconds > MANDATE_MAX_SECONDS) {
    throw new MandateFormError("It can last at most 30 days, and the signer usually allows 7.");
  }
  const parsed = MandateDraft.safeParse({
    agentId: form.agentId,
    assets,
    windowSeconds: form.windowSeconds,
    recipients,
    maxUses,
    maxFeePerActionWei: fee.toString(),
    notAfter: form.notAfter,
    purpose: form.purpose.trim(),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new MandateFormError(
      field === "purpose"
        ? "Purpose: at most 280 characters, on one line, without control characters."
        : field === "assets"
          ? "An asset's limits are too large to be valid."
          : "This approval in advance is not valid.",
    );
  }
  return parsed.data;
}
