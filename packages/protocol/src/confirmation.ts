import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { DomainTag, digest } from "./canonical.ts";
import {
  type ApproveIntentEnvelope,
  Envelope,
  type EnvelopeType,
  type SetPolicyEnvelope,
  type SweepWalletEnvelope,
} from "./envelopes.ts";
import { Intent, intentHash, intentSpend } from "./intent.ts";
import { assetLimitKey, policyHash, WalletPolicy } from "./policy.ts";
import {
  Address,
  ApprovalId,
  type AssetRef,
  Base64Url,
  ChainId,
  EpochSeconds,
  Nonce,
  PROTOCOL_VERSION,
  WorkspaceId,
} from "./primitives.ts";
import type { SignerErrorCode } from "./signer/api.ts";
import { Sweep, sweepHash } from "./sweep.ts";

/**
 * What a person reads before they approve, built by the signer from what it holds: the envelope,
 * the subject whose hash the envelope names, and the signer's own records. Nothing here comes
 * from the control plane unchecked; text that nobody checked (an agent's note, a wallet's name)
 * is shown in lines of kind `unchecked` and never in a title or a label.
 */

// --- operator labels --------------------------------------------------------------------------

const LabelSymbol = z
  .string()
  .regex(/^[A-Za-z0-9.]{1,11}$/, "expected 1 to 11 letters, digits or dots");

/** A chain's name and native coin, from the operator's chains file mounted into the signer. */
export const ChainLabel = z.strictObject({
  chainId: ChainId,
  name: z
    .string()
    .regex(
      /^[!-~](?:[ -~]{0,38}[!-~])?$/,
      "expected up to 40 printable ASCII characters without leading or trailing spaces",
    ),
  nativeSymbol: LabelSymbol,
});
export type ChainLabel = z.infer<typeof ChainLabel>;

/** A token's symbol and decimals, from the operator's assets file mounted into the signer. */
export const AssetLabel = z.strictObject({
  chainId: ChainId,
  asset: Address,
  symbol: LabelSymbol,
  decimals: z.number().int().min(0).max(36),
});
export type AssetLabel = z.infer<typeof AssetLabel>;

/** The whole chains file. One name per chain. */
export const ChainLabels = z
  .array(ChainLabel)
  .max(1024)
  .refine(
    (labels) => new Set(labels.map((label) => label.chainId)).size === labels.length,
    "a chain is named twice",
  );
export type ChainLabels = z.infer<typeof ChainLabels>;

/** The whole assets file. One label per token on each chain. */
export const AssetLabels = z
  .array(AssetLabel)
  .max(4096)
  .refine(
    (labels) => new Set(labels.map(assetLimitKey)).size === labels.length,
    "a token is named twice on the same chain",
  );
export type AssetLabels = z.infer<typeof AssetLabels>;

// --- subjects ---------------------------------------------------------------------------------

/**
 * The structure an envelope names by hash, kept by the signer next to the envelope so it can
 * show exactly what the approval authorizes. Envelopes that carry everything themselves have an
 * `envelope-only` subject.
 */
export const ConfirmationSubject = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("approve-intent"), intent: Intent }),
  z.strictObject({ kind: z.literal("set-policy"), policy: WalletPolicy }),
  z.strictObject({ kind: z.literal("sweep-wallet"), sweep: Sweep }),
  z.strictObject({ kind: z.literal("envelope-only") }),
]);
export type ConfirmationSubject = z.infer<typeof ConfirmationSubject>;

/** Why a subject is not what an envelope names. The signer refuses with the same code. */
export type SubjectMismatch = Extract<SignerErrorCode, "envelope_mismatch" | "intent_mismatch">;

type EnvelopeOnly = Exclude<Envelope, { type: "approve-intent" | "set-policy" | "sweep-wallet" }>;

/** An envelope paired with its validated subject. */
type Matched =
  | { kind: "approve-intent"; envelope: ApproveIntentEnvelope; intent: Intent }
  | { kind: "set-policy"; envelope: SetPolicyEnvelope; policy: WalletPolicy }
  | { kind: "sweep-wallet"; envelope: SweepWalletEnvelope; sweep: Sweep }
  | { kind: "envelope-only"; envelope: EnvelopeOnly };

// The fields are compared before the hash, in the same order as the signer's own checks, so a
// subject refused here is refused with the code the signer would give when signing it.
function matchSubject(envelope: Envelope, subject: ConfirmationSubject): Matched | SubjectMismatch {
  switch (envelope.type) {
    case "approve-intent": {
      if (subject.kind !== "approve-intent") return "envelope_mismatch";
      const { intent } = subject;
      if (
        intent.workspaceId !== envelope.workspaceId ||
        intent.walletId !== envelope.walletId ||
        intent.agentId !== envelope.agentId ||
        intent.chainId !== envelope.chainId
      ) {
        return "envelope_mismatch";
      }
      const parsed = Intent.safeParse(intent);
      if (!parsed.success || intentHash(parsed.data) !== envelope.intentHash) {
        return "intent_mismatch";
      }
      return { kind: "approve-intent", envelope, intent: parsed.data };
    }
    case "set-policy": {
      if (subject.kind !== "set-policy") return "envelope_mismatch";
      const parsed = WalletPolicy.safeParse(subject.policy);
      if (!parsed.success) return "envelope_mismatch";
      const policy = parsed.data;
      if (
        policy.workspaceId !== envelope.workspaceId ||
        policy.walletId !== envelope.walletId ||
        policy.previousHash !== envelope.previousPolicyHash ||
        policyHash(policy) !== envelope.policyHash
      ) {
        return "envelope_mismatch";
      }
      return { kind: "set-policy", envelope, policy };
    }
    case "sweep-wallet": {
      if (subject.kind !== "sweep-wallet") return "envelope_mismatch";
      const parsed = Sweep.safeParse(subject.sweep);
      if (!parsed.success) return "envelope_mismatch";
      const sweep = parsed.data;
      if (
        sweep.workspaceId !== envelope.workspaceId ||
        sweep.walletId !== envelope.walletId ||
        sweep.chainId !== envelope.chainId ||
        sweepHash(sweep) !== envelope.sweepHash
      ) {
        return "envelope_mismatch";
      }
      return { kind: "sweep-wallet", envelope, sweep };
    }
    case "add-approver":
    case "remove-approver":
    case "set-admin-threshold":
    case "resume-workspace":
      return subject.kind === "envelope-only"
        ? { kind: "envelope-only", envelope }
        : "envelope_mismatch";
  }
}

/**
 * `null` when the subject is exactly what the envelope names, otherwise the signer error code to
 * refuse with. Never throws, also not for a subject that fails its schema.
 */
export function checkSubject(
  envelope: Envelope,
  subject: ConfirmationSubject,
): SubjectMismatch | null {
  const matched = matchSubject(envelope, subject);
  return typeof matched === "string" ? matched : null;
}

// --- the rendered view ------------------------------------------------------------------------

/**
 * How the page shows a line's value. `unchecked` is text nobody checked, such as an agent's note
 * or a wallet's name; the page sets it apart from everything the signer states.
 */
export const ConfirmationLineKind = z.enum(["text", "amount", "address", "code", "unchecked"]);
export type ConfirmationLineKind = z.infer<typeof ConfirmationLineKind>;

/** Labels are always the signer's own words; only values carry data. */
export const ConfirmationLine = z.strictObject({
  label: z.string(),
  value: z.string(),
  kind: ConfirmationLineKind,
});
export type ConfirmationLine = z.infer<typeof ConfirmationLine>;

/** Shown before the lines. Always listed in this order. */
export const ConfirmationWarning = z.enum([
  "raw_contract_call",
  "unknown_token",
  "unknown_chain",
  "recipient_not_allowlisted",
  "over_remaining_daily_cap",
  "first_policy",
  "possession_unproven",
]);
export type ConfirmationWarning = z.infer<typeof ConfirmationWarning>;

/**
 * Where an approval stands, as the signer sees it.
 * - `open`: it can collect assertions.
 * - `complete`: enough current approvers approved; the control plane can now use it.
 * - `expired`: the envelope's `expiresAt` has passed.
 * - `revoked`: the approval id was revoked; it will never sign or apply.
 * - `used`: the signer already signed or applied it.
 * - `superseded`: the signer would refuse it whatever approvals it gets, because the wallet's
 *   policy changed since it was proposed or it was issued before the signer's restore fence.
 *   It must be proposed again.
 */
export const ConfirmationState = z.enum([
  "open",
  "complete",
  "expired",
  "revoked",
  "used",
  "superseded",
]);
export type ConfirmationState = z.infer<typeof ConfirmationState>;

/**
 * The options the confirmation page passes to `navigator.credentials.get`: which passkeys may
 * answer, and the challenge they sign.
 */
export const PasskeyRequest = z.strictObject({
  rpId: z.string().min(1),
  challenge: Base64Url,
  allowCredentials: z.array(Base64Url).max(256),
  userVerification: z.literal("required"),
  timeoutMs: z.number().int().min(1).max(600_000),
});
export type PasskeyRequest = z.infer<typeof PasskeyRequest>;

/** What the signer returns to the confirmation page for one approval. */
export const ConfirmationView = z
  .strictObject({
    v: z.literal(PROTOCOL_VERSION),
    approvalId: ApprovalId,
    workspaceId: WorkspaceId,
    kind: z.custom<EnvelopeType>((value) => typeof value === "string"),
    state: ConfirmationState,
    expiresAt: EpochSeconds,
    title: z.string(),
    lines: z.array(ConfirmationLine).max(4096),
    warnings: z.array(ConfirmationWarning).max(ConfirmationWarning.options.length),
    approvals: z.strictObject({
      collected: z.number().int().min(0),
      required: z.number().int().min(1),
    }),
    /** For "technical details": the exact data the passkey approves. */
    envelope: Envelope,
    subject: ConfirmationSubject,
    /** Its challenge is the envelope's digest, base64url. */
    webauthn: PasskeyRequest,
    /** Where the page sends the person afterwards: the control plane's page for the request. */
    returnUrl: z.url({ protocol: /^https?$/ }),
  })
  .refine(
    (view) =>
      view.approvalId === view.envelope.approvalId &&
      view.workspaceId === view.envelope.workspaceId &&
      view.kind === view.envelope.type &&
      view.expiresAt === view.envelope.expiresAt &&
      checkSubject(view.envelope, view.subject) === null,
    { path: ["envelope"], message: "the view must describe its own envelope and subject" },
  );
export type ConfirmationView = z.infer<typeof ConfirmationView>;

/** Everything the view is built from. The signer supplies all of it from its own records. */
export type RenderInput = {
  envelope: Envelope;
  /** Must be what the envelope names; see {@link checkSubject}. */
  subject: ConfirmationSubject;
  /** The signer's record of the envelope's wallet, or null for envelopes without one. */
  wallet: { label: string; address: Address } | null;
  chains: readonly ChainLabel[];
  assets: readonly AssetLabel[];
  /** The signer's current policy of the envelope's wallet. */
  currentPolicy: WalletPolicy | null;
  /** What the wallet signed for in the last 24 hours, in the intent's asset on its chain. */
  spent24h: bigint;
  approvals: { collected: number; required: number };
  adminThreshold: number;
  /** For `add-approver`: whether the new person proved they hold the key. */
  possessionProven: boolean;
  /** Addresses of the workspace's treasury wallets other than the envelope's, where a sweep may go. */
  treasuries: readonly Address[];
};

export type RenderedConfirmation = {
  title: string;
  lines: ConfirmationLine[];
  warnings: ConfirmationWarning[];
};

const AGENT_NOTE = "Agent's note, not checked";
const WALLET_NAME = "Wallet name, not checked";
const ADMIN_THRESHOLD = "Approvals needed for workspace changes";

type Output = {
  input: RenderInput;
  lines: ConfirmationLine[];
  warnings: Set<ConfirmationWarning>;
};

/**
 * Build the view a person reads before approving. Pure and deterministic. Every field that
 * changes what the approval authorizes is shown. Throws a `TypeError` only when the subject is
 * not what the envelope names, which the caller has already refused with {@link checkSubject}.
 */
export function renderConfirmation(input: RenderInput): RenderedConfirmation {
  const matched = matchSubject(input.envelope, input.subject);
  if (typeof matched === "string") {
    throw new TypeError(`the subject is not what the envelope names (${matched})`);
  }
  const out: Output = { input, lines: [], warnings: new Set() };
  const title = renderMatched(out, matched);

  const { envelope, approvals } = input;
  push(out, "Workspace", envelope.workspaceId, "code");
  push(out, "Request id", envelope.approvalId, "code");
  push(out, "Valid until", formatUtc(envelope.expiresAt), "text");
  push(out, "Approvals so far", `${approvals.collected} of ${approvals.required}`, "text");

  const warnings = ConfirmationWarning.options.filter((code) => out.warnings.has(code));
  return { title, lines: out.lines, warnings };
}

function renderMatched(out: Output, matched: Matched): string {
  switch (matched.kind) {
    case "approve-intent":
      return renderIntent(out, matched.intent);
    case "set-policy":
      return renderPolicy(out, matched.policy);
    case "sweep-wallet":
      return renderSweep(out, matched.sweep);
    case "envelope-only":
      return renderEnvelopeOnly(out, matched.envelope);
  }
}

function renderIntent(out: Output, intent: Intent): string {
  const title = renderOperation(out, intent);
  const native = unitOf(out, intent.chainId, "native");
  push(out, "Network", chainName(out, intent.chainId), "text");
  push(out, "Network fee ceiling", amountText(native, intent.maxFeeWei), "amount");
  const { asset, amount } = intentSpend(intent);
  limitLines(out, intent.chainId, asset, amount);
  walletLines(out, intent.walletId);
  push(out, "Proposed by agent", intent.agentId, "code");
  if (intent.memo !== "") push(out, AGENT_NOTE, uncheckedText(intent.memo), "unchecked");
  return title;
}

function renderOperation(out: Output, intent: Intent): string {
  const { operation, chainId } = intent;
  switch (operation.type) {
    case "evm.transfer": {
      const amount = amountText(unitOf(out, chainId, "native"), operation.valueWei);
      push(out, "Amount", amount, "amount");
      recipientLines(out, operation.to);
      return `Send ${amount}`;
    }
    case "evm.erc20.transfer": {
      const unit = unitOf(out, chainId, operation.token);
      const amount = amountText(unit, operation.amount);
      push(out, "Amount", amount, "amount");
      tokenLines(out, unit, operation.token);
      recipientLines(out, operation.to);
      return unit.known ? `Send ${amount}` : `Send ${amount} of an unknown token`;
    }
    case "evm.call": {
      out.warnings.add("raw_contract_call");
      addressLines(out, "Contract", operation.to);
      const native = unitOf(out, chainId, "native");
      push(out, "Value sent with the call", amountText(native, operation.valueWei), "amount");
      push(out, "Function selector", operation.data.slice(0, 10), "code");
      push(out, "Calldata", operation.data, "code");
      push(out, "What the call does", "the signer cannot say what this call does", "text");
      return "Call a contract";
    }
  }
}

function recipientLines(out: Output, to: Address): void {
  addressLines(out, "To", to);
  const policy = out.input.currentPolicy;
  if (policy === null) return;
  if (policy.recipients.mode === "any") {
    push(out, "Recipient allowlist", "the wallet's policy allows any recipient", "text");
  } else if (policy.recipients.addresses.includes(to)) {
    push(out, "Recipient allowlist", "on the wallet's allowlist", "text");
  } else {
    push(out, "Recipient allowlist", "not on the wallet's allowlist", "text");
    out.warnings.add("recipient_not_allowlisted");
  }
}

function tokenLines(out: Output, unit: Unit, token: Address): void {
  push(
    out,
    "Token",
    unit.known
      ? `${unit.symbol}, ${unit.decimals} decimals, as named by the operator`
      : "not in the operator's token list: the amount is in base units",
    "text",
  );
  addressLines(out, "Token contract", token);
}

/** The intent's asset against the wallet's caps, from the signer's policy and ledger. */
function limitLines(out: Output, chainId: ChainId, asset: AssetRef, amount: bigint): void {
  const policy = out.input.currentPolicy;
  if (policy === null) {
    push(out, "Wallet policy", "none is set for this wallet", "text");
    return;
  }
  // A contract call that sends no native coin moves nothing the caps measure.
  if (amount === 0n) return;
  const key = assetLimitKey({ chainId, asset });
  const limit = policy.assets.find((candidate) => assetLimitKey(candidate) === key);
  if (limit === undefined) {
    push(out, "Limit for this asset", "none: the wallet's policy does not let it leave", "text");
    return;
  }
  const unit = unitOf(out, chainId, asset);
  const spent = out.input.spent24h;
  push(out, "Limit per transaction", amountText(unit, limit.maxPerTx), "amount");
  push(
    out,
    "Spent in the last 24 hours",
    `${amountText(unit, spent)} of ${amountText(unit, limit.maxPerDay)}`,
    "amount",
  );
  if (spent + amount > BigInt(limit.maxPerDay)) out.warnings.add("over_remaining_daily_cap");
}

function walletLines(out: Output, walletId: string): void {
  push(out, "Wallet", walletId, "code");
  const { wallet } = out.input;
  if (wallet === null) {
    push(out, "Wallet address", "not found at the signer", "text");
    return;
  }
  push(out, "Wallet address", wallet.address, "address");
  push(out, WALLET_NAME, uncheckedText(wallet.label), "unchecked");
}

function renderSweep(out: Output, sweep: Sweep): string {
  const unit = unitOf(out, sweep.chainId, sweep.asset);
  const amount = amountText(unit, sweep.amount);
  push(out, "Amount", amount, "amount");
  if (sweep.asset !== "native") tokenLines(out, unit, sweep.asset);
  addressLines(out, "To", sweep.to);
  const { currentPolicy: policy, wallet } = out.input;
  if (sweep.to === wallet?.address) {
    push(out, "Destination", "the wallet itself", "text");
    out.warnings.add("recipient_not_allowlisted");
  } else if (out.input.treasuries.includes(sweep.to)) {
    push(out, "Destination", "a treasury wallet of this workspace", "text");
  } else if (
    policy?.recipients.mode === "allowlist" &&
    policy.recipients.addresses.includes(sweep.to)
  ) {
    push(out, "Destination", "on the wallet's recipient allowlist", "text");
  } else {
    push(
      out,
      "Destination",
      "neither on the wallet's allowlist nor a treasury wallet of this workspace",
      "text",
    );
    out.warnings.add("recipient_not_allowlisted");
  }
  push(out, "Network", chainName(out, sweep.chainId), "text");
  const native = unitOf(out, sweep.chainId, "native");
  push(out, "Network fee ceiling", amountText(native, sweep.maxFeeWei), "amount");
  push(out, "Wallet limits", "do not apply: a sweep needs the workspace-change approvals", "text");
  walletLines(out, sweep.walletId);
  const moved = unit.known ? amount : `${amount} of an unknown token`;
  return `Move ${moved} out of the wallet`;
}

function renderEnvelopeOnly(out: Output, envelope: EnvelopeOnly): string {
  const threshold = String(out.input.adminThreshold);
  switch (envelope.type) {
    case "add-approver":
      push(out, "Person", envelope.userId, "code");
      push(out, "Passkey credential id", envelope.credentialId, "code");
      push(out, "Key fingerprint", keyFingerprint(envelope.publicKey), "code");
      if (out.input.possessionProven) {
        push(out, "The new person proved they hold this passkey", "yes", "text");
      } else {
        push(out, "The new person proved they hold this passkey", "no", "text");
        out.warnings.add("possession_unproven");
      }
      push(out, ADMIN_THRESHOLD, change(threshold, threshold), "text");
      return "Add an approver";
    case "remove-approver":
      push(out, "Person", envelope.userId, "code");
      push(out, "Passkey credential id", envelope.credentialId, "code");
      push(out, ADMIN_THRESHOLD, change(threshold, threshold), "text");
      return "Remove an approver";
    case "set-admin-threshold":
      push(out, ADMIN_THRESHOLD, change(threshold, String(envelope.adminThreshold)), "text");
      return "Change the approvals needed for workspace changes";
    case "resume-workspace":
      push(out, "Effect", "the workspace's wallets can sign again, within their policies", "text");
      return "Resume the workspace";
  }
}

// --- policies ---------------------------------------------------------------------------------

function renderPolicy(out: Output, next: WalletPolicy): string {
  const current = out.input.currentPolicy;
  if (current === null) out.warnings.add("first_policy");
  walletLines(out, next.walletId);
  policyField(out, "Policy revision", current, next, (policy) => String(policy.revision), "text");

  setLines(out, "Chains", "Chain", current?.chains ?? null, next.chains, (chainId) =>
    chainName(out, chainId),
  );
  setLines(
    out,
    "Agents that may propose",
    "Agent",
    current?.requesters ?? null,
    next.requesters,
    (agentId) => agentId,
  );
  policyLimitLines(out, current, next);
  ruleLines(out, "Recipients", "Recipient", current, next, ({ recipients }) =>
    recipients.mode === "any"
      ? { text: "anyone", members: null }
      : {
          text: `only listed addresses (${recipients.addresses.length})`,
          members: recipients.addresses,
        },
  );
  ruleLines(out, "Contract calls", "Contract", current, next, ({ contractCalls }) =>
    contractCalls.mode === "deny"
      ? { text: "none", members: null }
      : {
          text: `only listed contracts (${contractCalls.targets.length})`,
          members: contractCalls.targets,
        },
  );
  policyField(
    out,
    "Largest network fee per transaction",
    current,
    next,
    (policy) => `${formatUnits(BigInt(policy.fees.maxPerTxWei), 18)} of the native coin`,
    "amount",
  );
  policyField(
    out,
    "Approvals needed per transaction",
    current,
    next,
    (policy) => String(policy.approvals.threshold),
    "text",
  );
  policyField(
    out,
    "Longest an approved transaction stays usable",
    current,
    next,
    (policy) => formatDuration(policy.approvals.ttlSeconds),
    "text",
  );
  return current === null ? "Set a wallet's first policy" : "Change a wallet's policy";
}

/** One field of a policy: its new value, with the current one when there is a current policy. */
function policyField(
  out: Output,
  label: string,
  current: WalletPolicy | null,
  next: WalletPolicy,
  show: (policy: WalletPolicy) => string,
  kind: ConfirmationLineKind,
): void {
  push(out, label, change(current && show(current), show(next)), kind);
}

/** One line per member for a first policy, otherwise one line per added or removed member. */
function setLines<T extends string>(
  out: Output,
  label: string,
  member: string,
  current: readonly T[] | null,
  next: readonly T[],
  show: (value: T) => string,
): void {
  if (current === null) {
    if (next.length === 0) push(out, label, "none", "text");
    for (const value of next) push(out, `${member} allowed`, show(value), "code");
    return;
  }
  const added = next.filter((value) => !current.includes(value));
  const removed = current.filter((value) => !next.includes(value));
  if (added.length === 0 && removed.length === 0) {
    push(out, label, `unchanged (${next.length})`, "text");
    return;
  }
  for (const value of added) push(out, `${member} added`, show(value), "code");
  for (const value of removed) push(out, `${member} removed`, show(value), "code");
}

/** A recipient or contract-call rule: a summary, and its members when it is an allowlist. */
type Rule = { text: string; members: readonly Address[] | null };

function ruleLines(
  out: Output,
  label: string,
  member: string,
  currentPolicy: WalletPolicy | null,
  nextPolicy: WalletPolicy,
  ruleOf: (policy: WalletPolicy) => Rule,
): void {
  const current = currentPolicy && ruleOf(currentPolicy);
  const next = ruleOf(nextPolicy);
  const after = next.members;
  const unchanged =
    current !== null &&
    current.text === next.text &&
    (current.members ?? []).join() === (after ?? []).join();
  let summary = next.text;
  if (current !== null && unchanged) summary = `${next.text} (unchanged)`;
  else if (current !== null && current.text === next.text) summary = `${next.text}, changed below`;
  else if (current !== null) summary = `${current.text} → ${next.text}`;
  push(out, label, summary, "text");
  if (after === null) return;
  const before = current?.members ?? null;
  if (before === null) {
    for (const address of after) push(out, `${member} allowed`, address, "address");
    return;
  }
  for (const address of after.filter((value) => !before.includes(value))) {
    push(out, `${member} added`, address, "address");
  }
  for (const address of before.filter((value) => !after.includes(value))) {
    push(out, `${member} removed`, address, "address");
  }
}

function policyLimitLines(out: Output, current: WalletPolicy | null, next: WalletPolicy): void {
  const before = new Map((current?.assets ?? []).map((limit) => [assetLimitKey(limit), limit]));
  const after = new Map(next.assets.map((limit) => [assetLimitKey(limit), limit]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  let changed = 0;
  for (const key of keys) {
    const was = before.get(key);
    const now = after.get(key);
    const limit = now ?? was;
    if (limit === undefined) continue;
    const unit = unitOf(out, limit.chainId, limit.asset);
    const asset = unit.known
      ? unit.symbol
      : limit.asset === "native"
        ? "the native coin"
        : `token ${limit.asset}`;
    const name = `${asset} on ${chainName(out, limit.chainId)}`;
    if (was === undefined && now !== undefined) {
      changed += 1;
      push(
        out,
        current === null ? "Limit" : "Limit added",
        `${name}: ${amountText(unit, now.maxPerTx)} per transaction, ${amountText(unit, now.maxPerDay)} per 24 hours`,
        "amount",
      );
    } else if (was !== undefined && now === undefined) {
      changed += 1;
      push(out, "Limit removed", `${name}: can no longer leave the wallet`, "text");
    } else if (
      was !== undefined &&
      now !== undefined &&
      (was.maxPerTx !== now.maxPerTx || was.maxPerDay !== now.maxPerDay)
    ) {
      changed += 1;
      const perTx = change(amountText(unit, was.maxPerTx), amountText(unit, now.maxPerTx));
      const perDay = change(amountText(unit, was.maxPerDay), amountText(unit, now.maxPerDay));
      push(
        out,
        "Limit changed",
        `${name}: per transaction ${perTx}; per 24 hours ${perDay}`,
        "amount",
      );
    }
  }
  if (changed > 0) return;
  push(
    out,
    "Limits",
    current === null ? "none: nothing can leave the wallet" : `unchanged (${next.assets.length})`,
    "text",
  );
}

// --- labels and units -------------------------------------------------------------------------

type Unit =
  | { known: true; symbol: string; decimals: number }
  | { known: false; baseUnit: "wei" | "base units" };

/** A label is used only when exactly one entry matches; anything else is shown as unknown. */
function only<T>(labels: readonly T[], matches: (label: T) => boolean): T | undefined {
  const found = labels.filter(matches);
  return found.length === 1 ? found[0] : undefined;
}

function chainLabel(out: Output, chainId: ChainId): ChainLabel | undefined {
  const label = only(out.input.chains, (candidate) => candidate.chainId === chainId);
  if (label === undefined) out.warnings.add("unknown_chain");
  return label;
}

function chainName(out: Output, chainId: ChainId): string {
  const label = chainLabel(out, chainId);
  return label === undefined ? chainId : `${label.name} (${chainId})`;
}

/** Native coins have 18 decimals on every EVM chain this product signs for. */
function unitOf(out: Output, chainId: ChainId, asset: AssetRef): Unit {
  if (asset === "native") {
    const chain = chainLabel(out, chainId);
    return chain === undefined
      ? { known: false, baseUnit: "wei" }
      : { known: true, symbol: chain.nativeSymbol, decimals: 18 };
  }
  const label = only(
    out.input.assets,
    (candidate) => candidate.chainId === chainId && candidate.asset === asset,
  );
  if (label === undefined) {
    out.warnings.add("unknown_token");
    return { known: false, baseUnit: "base units" };
  }
  return { known: true, symbol: label.symbol, decimals: label.decimals };
}

function amountText(unit: Unit, amount: bigint | string): string {
  const value = BigInt(amount);
  return unit.known
    ? `${formatUnits(value, unit.decimals)} ${unit.symbol}`
    : `${groupDigits(value.toString())} ${unit.baseUnit}`;
}

// --- formatting -------------------------------------------------------------------------------

function push(out: Output, label: string, value: string, kind: ConfirmationLineKind): void {
  out.lines.push({ label, value, kind });
}

/** "2 → 3", "2 (unchanged)", or just the new value when there was none. */
function change(current: string | null, next: string): string {
  if (current === null) return next;
  return current === next ? `${next} (unchanged)` : `${current} → ${next}`;
}

/** The address as stored, and again in its EIP-55 form for comparing with a wallet app. */
function addressLines(out: Output, label: string, address: Address): void {
  push(out, label, address, "address");
  push(out, `${label}, checksummed (EIP-55)`, checksumAddress(address), "address");
}

function checksumAddress(address: Address): string {
  const hex = address.slice(2);
  const hash = keccak_256(utf8ToBytes(hex));
  let out = "0x";
  for (let index = 0; index < hex.length; index += 1) {
    const byte = hash[index >> 1] ?? 0;
    const nibble = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    const character = hex.charAt(index);
    out += nibble >= 8 ? character.toUpperCase() : character;
  }
  return out;
}

/** Thousands separated by commas: "1234567" → "1,234,567". */
function groupDigits(digits: string): string {
  let out = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ",";
    out += digits.charAt(index);
  }
  return out;
}

/** Base units to whole units with integer arithmetic only: 15000000000000000n, 18 → "0.015". */
function formatUnits(value: bigint, decimals: number): string {
  const digits = value.toString();
  if (decimals === 0) return groupDigits(digits);
  const padded = digits.padStart(decimals + 1, "0");
  const whole = groupDigits(padded.slice(0, -decimals));
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function formatUtc(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

// Characters that are invisible, reorder text, break lines or have no meaning of their own. In
// text nobody checked they could hide, reorder or fake what the person reads, so each one is
// shown as its code point instead.
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

function uncheckedText(value: string): string {
  return value.replace(HIDDEN_CHARACTER, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
  });
}

// --- new approver keys ------------------------------------------------------------------------

/**
 * What the passkey of a new approver signs to prove, on the confirmation page, that the person
 * being added holds the key an `add-approver` envelope carries: the approval, the key's
 * credential id, and a random nonce the signer issued, which one answer uses up.
 */
export const PossessionChallengeInput = z.strictObject({
  approvalId: ApprovalId,
  credentialId: Base64Url,
  nonce: Nonce,
});
export type PossessionChallengeInput = z.infer<typeof PossessionChallengeInput>;

/**
 * The 32 bytes the new approver's passkey signs in the possession step: the digest of
 * `{ v, approvalId, credentialId, nonce }` under its own tag, so it can never stand in for an
 * envelope's challenge, nor an envelope's for it.
 */
export function possessionChallenge(input: PossessionChallengeInput): Uint8Array {
  return digest(DomainTag.possession, {
    v: PROTOCOL_VERSION,
    ...PossessionChallengeInput.parse(input),
  });
}

// --- key fingerprints -------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A short, readable name for a COSE public key, for two people to compare: the first 80 bits of
 * SHA-256 over the key's bytes in Crockford base32, as `XXXX-XXXX-XXXX-XXXX`.
 */
export function keyFingerprint(publicKey: Base64Url): string {
  const bytes = sha256(new Uint8Array(Buffer.from(publicKey, "base64url"))).subarray(0, 10);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let symbols = "";
  for (let shift = 75n; shift >= 0n; shift -= 5n) {
    symbols += CROCKFORD.charAt(Number((bits >> shift) & 31n));
  }
  return [0, 4, 8, 12].map((start) => symbols.slice(start, start + 4)).join("-");
}
