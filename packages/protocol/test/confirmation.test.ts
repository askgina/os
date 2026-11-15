import { describe, expect, it } from "vitest";
import {
  type AssetLabel,
  AssetLabels,
  type ChainLabel,
  ChainLabel as ChainLabelSchema,
  ChainLabels,
  type ConfirmationSubject,
  ConfirmationView,
  checkSubject,
  keyFingerprint,
  type RenderedConfirmation,
  type RenderInput,
  renderConfirmation,
  type SignerWalletRecord,
} from "../src/confirmation.ts";
import {
  type Envelope,
  envelopeChallenge,
  type GrantMandateEnvelope,
  type HyperliquidOrderOperation,
  type HyperliquidRules,
  type Intent,
  intentHash,
  type Mandate,
  Memo,
  mandateHash,
  type Operation,
  policyHash,
  type SweepWalletEnvelope,
  type WalletPolicy,
} from "../src/index.ts";
import { type Sweep, sweepHash } from "../src/sweep.ts";
import {
  AGENT,
  ALICE,
  APPROVAL,
  addApprover,
  approveIntent,
  BASE,
  BOB,
  cancelTransaction,
  DESTROY_DELAY,
  DIGEST_A,
  deleteWorkspace,
  grantMandate,
  HL_TESTNET,
  hyperliquidRules,
  intent,
  MAINNET,
  MANDATE,
  mandate,
  mandateAsset,
  NONCE,
  OTHER_AGENT,
  OTHER_WALLET,
  OTHER_WALLET_ADDRESS,
  policy,
  ROUTER,
  removeApprover,
  resumeWorkspace,
  retireWallet,
  setAdminThreshold,
  setPolicy,
  T0,
  TARGET_APPROVAL,
  TOKEN,
  USDC_BASE,
  USER_B,
  venueIntent,
  WALLET,
  WS,
} from "./fixtures.ts";

const WALLET_ADDRESS = "0x5555555555555555555555555555555555555555" as const;
const TREASURY = "0x6666666666666666666666666666666666666666" as const;
const UNLISTED_CHAIN = "eip155:999" as const;
const UINT256_MAX = (1n << 256n) - 1n;

const CHAINS: ChainLabel[] = [
  { chainId: BASE, name: "Base", nativeSymbol: "ETH" },
  { chainId: MAINNET, name: "Ethereum", nativeSymbol: "ETH" },
];
const USDC: AssetLabel = { chainId: BASE, asset: TOKEN, symbol: "USDC", decimals: 6 };

const envelopeOnly: ConfirmationSubject = { kind: "envelope-only" };

function render(
  envelope: Envelope,
  subject: ConfirmationSubject,
  overrides: Partial<RenderInput> = {},
): RenderedConfirmation {
  return renderConfirmation({
    envelope,
    subject,
    wallet: { label: "Operations", address: WALLET_ADDRESS },
    chains: CHAINS,
    assets: [USDC],
    currentPolicy: policy(),
    spent24h: 0n,
    approvals: { collected: 0, required: 1 },
    adminThreshold: 1,
    possessionProven: false,
    treasuries: [],
    cancelTarget: null,
    wallets: [],
    ...overrides,
  });
}

function envelopeFor(subject: Intent): Envelope {
  return approveIntent({
    intentHash: intentHash(subject),
    walletId: subject.walletId,
    agentId: subject.agentId,
    chainId: subject.chainId,
  });
}

function renderIntent(subject: Intent, overrides: Partial<RenderInput> = {}) {
  return render(envelopeFor(subject), { kind: "approve-intent", intent: subject }, overrides);
}

function policyEnvelope(next: WalletPolicy): Envelope {
  return setPolicy({ policyHash: policyHash(next), previousPolicyHash: next.previousHash });
}

function renderPolicy(next: WalletPolicy, current: WalletPolicy | null) {
  return render(
    policyEnvelope(next),
    { kind: "set-policy", policy: next },
    { currentPolicy: current },
  );
}

function sweep(overrides: Partial<Sweep> = {}): Sweep {
  return {
    v: 1,
    workspaceId: WS,
    walletId: WALLET,
    chainId: BASE,
    asset: "native",
    amount: "2000000000000000000",
    to: TREASURY,
    maxFeeWei: "1000000000000000",
    ...overrides,
  };
}

function mandateEnvelope(subject: Mandate): GrantMandateEnvelope {
  return grantMandate({
    workspaceId: subject.workspaceId,
    mandateId: subject.id,
    walletId: subject.walletId,
    agentId: subject.agentId,
    mandateHash: mandateHash(subject),
  });
}

function sweepEnvelope(subject: Sweep): SweepWalletEnvelope {
  return {
    v: 1,
    approvalId: APPROVAL,
    workspaceId: subject.workspaceId,
    nonce: NONCE,
    issuedAt: T0,
    expiresAt: T0 + 600,
    type: "sweep-wallet",
    walletId: subject.walletId,
    chainId: subject.chainId,
    sweepHash: sweepHash(subject),
  };
}

/** The value of the one line with this label; fails when there is none or more than one. */
function value(view: RenderedConfirmation, label: string): string {
  const found = view.lines.filter((line) => line.label === label);
  expect(found, `lines labelled "${label}"`).toHaveLength(1);
  return found[0]?.value ?? "";
}

function values(view: RenderedConfirmation, label: string): string[] {
  return view.lines.filter((line) => line.label === label).map((line) => line.value);
}

/** Read a rendered amount such as "1,234.5 USDC" back into base units. */
function parseAmount(text: string, decimals: number): { amount: bigint; unit: string } {
  const match = /^((?:\d{1,3})(?:,\d{3})*)(?:\.(\d*[1-9]))? (.+)$/.exec(text);
  if (match === null) throw new Error(`not an amount: ${text}`);
  const [, whole = "", fraction = "", unit = ""] = match;
  expect(fraction.length).toBeLessThanOrEqual(decimals);
  const amount =
    BigInt(whole.replaceAll(",", "")) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  return { amount, unit };
}

// EIP-55's own test vectors: all caps, all lowercase, and mixed case.
const EIP55 = [
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26",
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("checkSubject", () => {
  it("accepts exactly the subject each envelope names", () => {
    const subject = intent();
    expect(checkSubject(envelopeFor(subject), { kind: "approve-intent", intent: subject })).toBe(
      null,
    );
    const next = policy();
    expect(checkSubject(policyEnvelope(next), { kind: "set-policy", policy: next })).toBe(null);
    expect(checkSubject(sweepEnvelope(sweep()), { kind: "sweep-wallet", sweep: sweep() })).toBe(
      null,
    );
    expect(
      checkSubject(mandateEnvelope(mandate()), { kind: "grant-mandate", mandate: mandate() }),
    ).toBe(null);
    for (const envelope of [
      addApprover(),
      removeApprover(),
      setAdminThreshold(),
      resumeWorkspace(),
      cancelTransaction(),
      retireWallet(),
      deleteWorkspace(),
    ]) {
      expect(checkSubject(envelope, envelopeOnly)).toBe(null);
    }
  });

  it("checkSubject refuses an intent whose hash is not the envelope's", () => {
    const approved = intent();
    const envelope = envelopeFor(approved);
    // Same workspace, wallet, agent and chain: only the hash can tell these apart.
    const swaps: Intent[] = [
      intent({ operation: { type: "evm.transfer", to: BOB, valueWei: "250000000000000000" } }),
      intent({ operation: { type: "evm.transfer", to: ALICE, valueWei: "250000000000000001" } }),
      intent({ maxFeeWei: "1000000000000001" }),
      intent({ memo: "pay invoice 43" }),
      intent({ createdAt: T0 + 1 }),
    ];
    for (const swapped of swaps) {
      expect(checkSubject(envelope, { kind: "approve-intent", intent: swapped })).toBe(
        "intent_mismatch",
      );
    }
  });

  it("refuses an intent for another workspace, wallet, agent or chain even when its hash is named", () => {
    const cases: Intent[] = [
      intent({ workspaceId: `ws_${"0".repeat(25)}9` }),
      intent({ walletId: `wal_${"0".repeat(25)}9` }),
      intent({ agentId: OTHER_AGENT }),
      intent({ chainId: MAINNET }),
    ];
    for (const other of cases) {
      // The envelope names the other intent's hash but this envelope's own fields.
      const envelope = approveIntent({ intentHash: intentHash(other) });
      expect(checkSubject(envelope, { kind: "approve-intent", intent: other })).toBe(
        "envelope_mismatch",
      );
    }
  });

  it("refuses an intent that fails its schema without throwing", () => {
    const zeroRecipient = intent({
      operation: {
        type: "evm.transfer",
        to: "0x0000000000000000000000000000000000000000",
        valueWei: "1",
      },
    });
    expect(checkSubject(approveIntent(), { kind: "approve-intent", intent: zeroRecipient })).toBe(
      "intent_mismatch",
    );
  });

  it("refuses a policy that is not the envelope's", () => {
    const next = policy();
    const envelope = policyEnvelope(next);
    const other = policy({ fees: { maxPerTxWei: "20000000000000000" } });
    expect(checkSubject(envelope, { kind: "set-policy", policy: other })).toBe("envelope_mismatch");
    // Hash matches, but the policy belongs to another wallet or workspace than the envelope.
    for (const foreign of [
      policy({ walletId: `wal_${"0".repeat(25)}9` }),
      policy({ workspaceId: `ws_${"0".repeat(25)}9` }),
    ]) {
      const named = setPolicy({ policyHash: policyHash(foreign) });
      expect(checkSubject(named, { kind: "set-policy", policy: foreign })).toBe(
        "envelope_mismatch",
      );
    }
    // Hash matches, but the policy replaces another revision than the envelope says.
    const second = policy({ revision: 2, previousHash: DIGEST_A });
    const wrongPrevious = setPolicy({ policyHash: policyHash(second), previousPolicyHash: null });
    expect(checkSubject(wrongPrevious, { kind: "set-policy", policy: second })).toBe(
      "envelope_mismatch",
    );
  });

  it("refuses a sweep that is not the envelope's", () => {
    const approved = sweep();
    const envelope = sweepEnvelope(approved);
    for (const other of [
      sweep({ to: ALICE }),
      sweep({ amount: "2000000000000000001" }),
      sweep({ asset: TOKEN }),
      sweep({ maxFeeWei: "1000000000000001" }),
    ]) {
      expect(checkSubject(envelope, { kind: "sweep-wallet", sweep: other })).toBe(
        "envelope_mismatch",
      );
    }
    const otherChain = sweep({ chainId: MAINNET });
    const fieldsDiffer = { ...envelope, sweepHash: sweepHash(otherChain) };
    expect(checkSubject(fieldsDiffer, { kind: "sweep-wallet", sweep: otherChain })).toBe(
      "envelope_mismatch",
    );
  });

  it("refuses a mandate that is not the envelope's", () => {
    const envelope = mandateEnvelope(mandate());
    for (const other of [
      mandate({ assets: [mandateAsset({ maxTotal: "1000000001" })] }),
      mandate({ recipients: [ALICE, BOB] }),
      mandate({ maxUses: 21 }),
      mandate({ notAfter: T0 + 604_001 }),
      mandate({ purpose: "something else" }),
    ]) {
      expect(checkSubject(envelope, { kind: "grant-mandate", mandate: other })).toBe(
        "envelope_mismatch",
      );
    }
    // The envelope names the other mandate's hash, but its own id, wallet, agent and workspace.
    for (const other of [
      mandate({ id: `mnd_${"0".repeat(25)}9` }),
      mandate({ walletId: `wal_${"0".repeat(25)}9` }),
      mandate({ agentId: OTHER_AGENT }),
      mandate({ workspaceId: `ws_${"0".repeat(25)}9` }),
    ]) {
      const named = grantMandate({ mandateHash: mandateHash(other) });
      expect(checkSubject(named, { kind: "grant-mandate", mandate: other })).toBe(
        "envelope_mismatch",
      );
    }
    // A mandate that fails its schema is refused, not thrown on.
    const empty = { ...mandate(), recipients: [] };
    expect(checkSubject(envelope, { kind: "grant-mandate", mandate: empty })).toBe(
      "envelope_mismatch",
    );
  });

  it("refuses a subject of the wrong kind for every envelope", () => {
    const subjects: ConfirmationSubject[] = [
      { kind: "approve-intent", intent: intent() },
      { kind: "set-policy", policy: policy() },
      { kind: "sweep-wallet", sweep: sweep() },
      { kind: "grant-mandate", mandate: mandate() },
      envelopeOnly,
    ];
    const envelopes: Envelope[] = [
      envelopeFor(intent()),
      policyEnvelope(policy()),
      sweepEnvelope(sweep()),
      mandateEnvelope(mandate()),
      addApprover(),
      removeApprover(),
      setAdminThreshold(),
      resumeWorkspace(),
      cancelTransaction(),
      retireWallet(),
      deleteWorkspace(),
    ];
    for (const envelope of envelopes) {
      const accepted = subjects.filter((subject) => checkSubject(envelope, subject) === null);
      expect(accepted, envelope.type).toHaveLength(1);
      for (const subject of subjects) {
        if (accepted.includes(subject)) continue;
        expect(checkSubject(envelope, subject)).toBe("envelope_mismatch");
      }
    }
  });

  it("renderConfirmation refuses a subject the envelope does not name", () => {
    expect(() =>
      render(envelopeFor(intent()), {
        kind: "approve-intent",
        intent: intent({ memo: "something else" }),
      }),
    ).toThrow(TypeError);
    expect(() => render(addApprover(), { kind: "set-policy", policy: policy() })).toThrow(
      TypeError,
    );
  });
});

describe("payments", () => {
  it("a transfer's lines show exactly the intent's recipient, amount and chain", () => {
    const recipients = [ALICE, BOB, ...EIP55.map((address) => address.toLowerCase())] as const;
    const amounts = [
      1n,
      999n,
      1000n,
      250_000_000_000_000_000n,
      10n ** 18n,
      1_234_567_890_123_456_789_012_345n,
      UINT256_MAX,
    ];
    const tokens: { label: AssetLabel; token: `0x${string}` }[] = [
      { label: USDC, token: TOKEN },
      {
        label: { chainId: BASE, asset: ROUTER, symbol: "WHOLE", decimals: 0 },
        token: ROUTER,
      },
      {
        label: {
          chainId: BASE,
          asset: "0x7777777777777777777777777777777777777777",
          symbol: "TINY",
          decimals: 36,
        },
        token: "0x7777777777777777777777777777777777777777",
      },
    ];
    const assets = tokens.map((entry) => entry.label);
    const unknownToken = "0x8888888888888888888888888888888888888888" as const;
    let checked = 0;
    for (const [index, to] of recipients.entries()) {
      for (const amount of amounts) {
        const cases: { subject: Intent; decimals: number; unit: string; chain: string }[] = [
          {
            subject: intent({
              operation: { type: "evm.transfer", to: to as `0x${string}`, valueWei: `${amount}` },
            }),
            decimals: 18,
            unit: "ETH",
            chain: "Base (eip155:8453)",
          },
          {
            subject: intent({
              chainId: UNLISTED_CHAIN,
              operation: { type: "evm.transfer", to: to as `0x${string}`, valueWei: `${amount}` },
            }),
            decimals: 0,
            unit: "wei",
            chain: UNLISTED_CHAIN,
          },
          ...tokens.map(({ label, token }) => ({
            subject: intent({
              operation: {
                type: "evm.erc20.transfer" as const,
                token,
                to: to as `0x${string}`,
                amount: `${amount}`,
              },
            }),
            decimals: label.decimals,
            unit: label.symbol,
            chain: "Base (eip155:8453)",
          })),
          {
            subject: intent({
              operation: {
                type: "evm.erc20.transfer",
                token: unknownToken,
                to: to as `0x${string}`,
                amount: `${amount}`,
              },
            }),
            decimals: 0,
            unit: "base units",
            chain: "Base (eip155:8453)",
          },
        ];
        for (const { subject, decimals, unit, chain } of cases) {
          const view = renderIntent(subject, { assets, currentPolicy: null });
          const shown = parseAmount(value(view, "Amount"), decimals);
          expect(shown).toEqual({ amount, unit });
          expect(value(view, "To")).toBe(to);
          const checksummed = value(view, "To, checksummed (EIP-55)");
          expect(checksummed.toLowerCase()).toBe(to);
          if (index >= 2) expect(checksummed).toBe(EIP55[index - 2]);
          expect(value(view, "Network")).toBe(chain);
          expect(
            value(view, "Network").endsWith(subject.chainId) ||
              value(view, "Network").endsWith(`(${subject.chainId})`),
          ).toBe(true);
          const amountLine = value(view, "Amount");
          expect(view.title).toBe(
            unit === "base units" ? `Send ${amountLine} of an unknown token` : `Send ${amountLine}`,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBe(recipients.length * amounts.length * 6);
  });

  it("a native transfer shows every field that changes what is approved", () => {
    const view = renderIntent(intent(), {
      spent24h: 1_500_000_000_000_000_000n,
      approvals: { collected: 1, required: 2 },
    });
    expect(view.title).toBe("Send 0.25 ETH");
    expect(view.lines).toEqual([
      { label: "Amount", value: "0.25 ETH", kind: "amount" },
      { label: "To", value: ALICE, kind: "address" },
      { label: "To, checksummed (EIP-55)", value: ALICE, kind: "address" },
      {
        label: "Recipient allowlist",
        value: "the wallet's policy allows any recipient",
        kind: "text",
      },
      { label: "Network", value: "Base (eip155:8453)", kind: "text" },
      { label: "Network fee ceiling", value: "0.001 ETH", kind: "amount" },
      { label: "Limit per transaction", value: "1 ETH", kind: "amount" },
      { label: "Spent in the last 24 hours", value: "1.5 ETH of 5 ETH", kind: "amount" },
      { label: "Wallet", value: WALLET, kind: "code" },
      { label: "Wallet address", value: WALLET_ADDRESS, kind: "address" },
      { label: "Wallet name, not checked", value: "Operations", kind: "unchecked" },
      { label: "Proposed by agent", value: AGENT, kind: "code" },
      { label: "Agent's note, not checked", value: "pay invoice 42", kind: "unchecked" },
      { label: "Workspace", value: WS, kind: "code" },
      { label: "Request id", value: APPROVAL, kind: "code" },
      { label: "Valid until", value: "2023-11-14 22:23:20 UTC", kind: "text" },
      { label: "Approvals so far", value: "1 of 2", kind: "text" },
    ]);
    expect(view.warnings).toEqual([]);
  });

  it("a token transfer shows the token's contract, symbol and decimals", () => {
    const subject = intent({
      operation: { type: "evm.erc20.transfer", token: TOKEN, to: BOB, amount: "1500000" },
    });
    const view = renderIntent(subject, { currentPolicy: null });
    expect(view.title).toBe("Send 1.5 USDC");
    expect(value(view, "Amount")).toBe("1.5 USDC");
    expect(value(view, "Token")).toBe("USDC, 6 decimals, as named by the operator");
    expect(value(view, "Token contract")).toBe(TOKEN);
    expect(value(view, "To")).toBe(BOB);
    expect(value(view, "Network fee ceiling")).toBe("0.001 ETH");
    expect(value(view, "Wallet policy")).toBe("none is set for this wallet");
    expect(view.warnings).toEqual([]);
  });

  it("an unknown token is shown in base units with unknown_token", () => {
    const unlisted = "0x9999999999999999999999999999999999999999" as const;
    const lookalike = `0x333333333333333333333333333333333333333${"4"}` as const;
    const cases: { token: `0x${string}`; assets: AssetLabel[] }[] = [
      { token: unlisted, assets: [USDC] },
      // Named for another chain only.
      { token: TOKEN, assets: [{ ...USDC, chainId: MAINNET }] },
      // Named only for an address one digit away.
      { token: lookalike, assets: [USDC] },
      // Named twice: the signer cannot know which name is right.
      { token: TOKEN, assets: [USDC, { ...USDC, symbol: "USDT" }] },
    ];
    for (const { token, assets } of cases) {
      const subject = intent({
        operation: { type: "evm.erc20.transfer", token, to: BOB, amount: "1234567" },
      });
      const policyWithToken = policy({
        assets: [
          ...policy().assets,
          { chainId: BASE, asset: token, maxPerTx: "5000000", maxPerDay: "9000000" },
        ].sort((a, b) => (`${a.chainId}|${a.asset}` < `${b.chainId}|${b.asset}` ? -1 : 1)),
      });
      const view = renderIntent(subject, { assets, currentPolicy: policyWithToken });
      expect(view.warnings).toContain("unknown_token");
      expect(view.title).toBe("Send 1,234,567 base units of an unknown token");
      expect(value(view, "Amount")).toBe("1,234,567 base units");
      expect(value(view, "Token")).toBe(
        "not in the operator's token list: the amount is in base units",
      );
      expect(value(view, "Token contract")).toBe(token);
      expect(value(view, "Limit per transaction")).toBe("5,000,000 base units");
      expect(value(view, "Spent in the last 24 hours")).toBe(
        "0 base units of 9,000,000 base units",
      );
      const shown = [view.title, ...view.lines.map((line) => line.value)].join("\n");
      expect(shown).not.toMatch(/USDC|USDT/);
    }
  });

  it("formats huge, zero and unusual amounts exactly", () => {
    const tokenAt = (decimals: number, amount: bigint) =>
      value(
        renderIntent(
          intent({
            operation: { type: "evm.erc20.transfer", token: TOKEN, to: BOB, amount: `${amount}` },
          }),
          { assets: [{ ...USDC, symbol: "TKN", decimals }], currentPolicy: null },
        ),
        "Amount",
      );
    expect(tokenAt(18, UINT256_MAX)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584007913129639935 TKN",
    );
    expect(tokenAt(36, UINT256_MAX)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269.984665640564039457584007913129639935 TKN",
    );
    expect(tokenAt(0, UINT256_MAX)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457,584,007,913,129,639,935 TKN",
    );
    expect(tokenAt(36, 1n)).toBe(`0.${"0".repeat(35)}1 TKN`);
    expect(tokenAt(36, 10n ** 36n)).toBe("1 TKN");
    expect(tokenAt(1, 15n)).toBe("1.5 TKN");
    expect(tokenAt(1, 10n)).toBe("1 TKN");
    expect(tokenAt(6, 1_000_000_000n)).toBe("1,000 TKN");
    expect(tokenAt(6, 100_000n)).toBe("0.1 TKN");
    expect(tokenAt(0, 1000n)).toBe("1,000 TKN");
    expect(tokenAt(0, 100n)).toBe("100 TKN");
    expect(tokenAt(18, 1n)).toBe("0.000000000000000001 TKN");

    // Zero: a contract call that sends no coin, and an empty 24-hour ledger.
    const call = intent({
      operation: { type: "evm.call", to: ROUTER, valueWei: "0", data: "0xa9059cbb" },
    });
    const view = renderIntent(call);
    expect(value(view, "Value sent with the call")).toBe("0 ETH");
    expect(values(view, "Spent in the last 24 hours")).toEqual([]);
    expect(value(renderIntent(intent()), "Spent in the last 24 hours")).toBe("0 ETH of 5 ETH");
  });

  it("a contract call shows the target, value, selector and full calldata, and warns", () => {
    const data = `0xa9059cbb${"00".repeat(12)}${BOB.slice(2)}${"0".repeat(63)}1` as const;
    const subject = intent({
      operation: { type: "evm.call", to: ROUTER, valueWei: "10000000000000000", data },
    });
    const view = renderIntent(subject);
    expect(view.title).toBe("Call a contract");
    expect(view.warnings).toEqual(["raw_contract_call"]);
    expect(value(view, "Contract")).toBe(ROUTER);
    expect(value(view, "Contract, checksummed (EIP-55)").toLowerCase()).toBe(ROUTER);
    expect(value(view, "Value sent with the call")).toBe("0.01 ETH");
    expect(value(view, "Function selector")).toBe("0xa9059cbb");
    expect(value(view, "Calldata")).toBe(data);
    expect(value(view, "What the call does")).toBe("the signer cannot say what this call does");
    expect(value(view, "Limit per transaction")).toBe("1 ETH");
    expect(values(view, "To")).toEqual([]);
  });

  it("warns when the recipient is not on the wallet's allowlist", () => {
    const allowlisted = policy({ recipients: { mode: "allowlist", addresses: [BOB] } });
    const outside = renderIntent(intent(), { currentPolicy: allowlisted });
    expect(value(outside, "Recipient allowlist")).toBe("not on the wallet's allowlist");
    expect(outside.warnings).toEqual(["recipient_not_allowlisted"]);

    const inside = renderIntent(
      intent({ operation: { type: "evm.transfer", to: BOB, valueWei: "1" } }),
      { currentPolicy: allowlisted },
    );
    expect(value(inside, "Recipient allowlist")).toBe("on the wallet's allowlist");
    expect(inside.warnings).toEqual([]);
  });

  it("warns when the payment would pass the 24-hour cap", () => {
    // 0.25 ETH on top of 4.75 ETH is exactly the 5 ETH cap; one more wei is over.
    const atCap = renderIntent(intent(), { spent24h: 4_750_000_000_000_000_000n });
    expect(atCap.warnings).toEqual([]);
    const over = renderIntent(intent(), { spent24h: 4_750_000_000_000_000_001n });
    expect(over.warnings).toEqual(["over_remaining_daily_cap"]);
    expect(value(over, "Spent in the last 24 hours")).toBe("4.750000000000000001 ETH of 5 ETH");
  });

  it("a chain without an operator name is shown by its id, in wei, with unknown_chain", () => {
    const view = renderIntent(intent({ chainId: UNLISTED_CHAIN }), { currentPolicy: null });
    expect(view.title).toBe("Send 250,000,000,000,000,000 wei");
    expect(value(view, "Network")).toBe(UNLISTED_CHAIN);
    expect(value(view, "Network fee ceiling")).toBe("1,000,000,000,000,000 wei");
    expect(view.warnings).toEqual(["unknown_chain"]);
  });

  it("says the wallet is unknown rather than showing another address", () => {
    const view = renderIntent(intent(), { wallet: null });
    expect(value(view, "Wallet")).toBe(WALLET);
    expect(value(view, "Wallet address")).toBe("not found at the signer");
    expect(values(view, "Wallet name, not checked")).toEqual([]);
  });

  it("is deterministic and reads no clock", () => {
    const first = renderIntent(intent());
    const second = renderIntent(intent());
    expect(second).toEqual(first);
    expect(value(first, "Valid until")).toBe("2023-11-14 22:23:20 UTC");
  });
});

describe("venue orders and withdrawals", () => {
  const venuePolicy = (rules: Partial<HyperliquidRules> = {}) =>
    policy({ venues: { hyperliquid: hyperliquidRules(rules) } });
  const order = (changes: Partial<HyperliquidOrderOperation> = {}) =>
    venueIntent({
      operation: {
        type: "hyperliquid.order",
        asset: 3,
        isBuy: true,
        size: "0.01",
        limitPx: "65000",
        tif: "Ioc",
        reduceOnly: false,
        ...changes,
      },
    });
  const renderOrder = (subject: Intent = order(), overrides: Partial<RenderInput> = {}) =>
    renderIntent(subject, { currentPolicy: venuePolicy(), ...overrides });

  it("an order shows every field that changes what is signed, from the intent and the policy", () => {
    const view = renderOrder(order(), {
      spent24h: 100_000_000n,
      approvals: { collected: 1, required: 2 },
    });
    expect(view.title).toBe("Buy 0.01 BTC perpetual");
    expect(view.lines).toEqual([
      { label: "Market", value: "BTC perpetual, as named in the wallet's policy", kind: "text" },
      { label: "Market index", value: "3", kind: "code" },
      { label: "Side", value: "buy", kind: "text" },
      { label: "Size", value: "0.01 BTC", kind: "amount" },
      { label: "Limit price", value: "65,000 USD", kind: "amount" },
      { label: "Notional at the limit price", value: "650 USD", kind: "amount" },
      {
        label: "Time in force",
        value: "immediate or cancel: whatever does not fill at once is cancelled",
        kind: "text",
      },
      { label: "Reduce-only", value: "no", kind: "text" },
      {
        label: "Cancelling",
        value: "the agent may cancel this order without asking again",
        kind: "text",
      },
      {
        label: "Submit window",
        value: "must reach the venue within 1 minute of signing",
        kind: "text",
      },
      {
        label: "Funds at the venue",
        value: "held by Hyperliquid; these caps limit new orders, not losses",
        kind: "text",
      },
      { label: "Network", value: "Hyperliquid testnet (hyperliquid:testnet)", kind: "text" },
      { label: "Limit per order", value: "1,000 USD", kind: "amount" },
      { label: "Spent in the last 24 hours", value: "100 USD of 2,000 USD", kind: "amount" },
      { label: "Wallet", value: WALLET, kind: "code" },
      { label: "Wallet address", value: WALLET_ADDRESS, kind: "address" },
      { label: "Wallet name, not checked", value: "Operations", kind: "unchecked" },
      { label: "Proposed by agent", value: AGENT, kind: "code" },
      { label: "Agent's note, not checked", value: "the funding rate turned", kind: "unchecked" },
      { label: "Workspace", value: WS, kind: "code" },
      { label: "Request id", value: APPROVAL, kind: "code" },
      { label: "Valid until", value: "2023-11-14 22:23:20 UTC", kind: "text" },
      { label: "Approvals so far", value: "1 of 2", kind: "text" },
    ]);
    expect(view.warnings).toEqual([]);
    expect(view.lines.some((line) => line.label === "Network fee ceiling")).toBe(false);
  });

  it("changing any field of the order changes a line", () => {
    const base = JSON.stringify(renderOrder().lines);
    const changes: [string, Partial<HyperliquidOrderOperation>][] = [
      ["asset", { asset: 4, size: "0.001" }],
      ["isBuy", { isBuy: false }],
      ["size", { size: "0.011" }],
      ["limitPx", { limitPx: "65000.5" }],
      ["tif", { tif: "Gtc" }],
      ["reduceOnly", { reduceOnly: true }],
    ];
    for (const [field, change] of changes) {
      expect(JSON.stringify(renderOrder(order(change)).lines), field).not.toBe(base);
    }
    expect(renderOrder(order({ isBuy: false })).title).toBe("Sell 0.01 BTC perpetual");
    expect(value(renderOrder(order({ asset: 4, size: "0.001" })), "Size")).toBe("0.001 ETH");
    expect(value(renderOrder(order({ tif: "Gtc" })), "Time in force")).toBe(
      "good till cancelled: rests on the book until filled or cancelled",
    );
    expect(value(renderOrder(order({ tif: "Alo" })), "Time in force")).toBe(
      "add liquidity only: cancelled if it would fill at once",
    );
    expect(
      value(
        renderOrder(order({ limitPx: "1670.1", size: "0.0147" })),
        "Notional at the limit price",
      ),
    ).toBe("24.55047 USD");
    expect(
      value(
        renderOrder(order(), { currentPolicy: venuePolicy({ submitWindowSeconds: 90 }) }),
        "Submit window",
      ),
    ).toBe("must reach the venue within 90 seconds of signing");
  });

  it("an asset index outside the policy's markets is named by its index and warns", () => {
    const view = renderOrder(order({ asset: 5 }));
    expect(view.title).toBe("Buy 0.01 of market 5, not in the wallet's policy");
    expect(value(view, "Market")).toBe(
      "not in the wallet's policy: the signer would refuse this order",
    );
    expect(value(view, "Market index")).toBe("5");
    expect(value(view, "Size")).toBe("0.01");
    expect(view.warnings).toEqual(["market_not_in_policy"]);
  });

  it("a policy without rules for the order's network warns, and no coin name is taken from elsewhere", () => {
    for (const currentPolicy of [policy(), venuePolicy({ network: "hyperliquid:mainnet" }), null]) {
      const view = renderOrder(order(), { currentPolicy });
      expect(view.warnings).toEqual(["market_not_in_policy", "venue_rules_missing"]);
      expect(view.title).toBe("Buy 0.01 of market 3, not in the wallet's policy");
      expect(value(view, "Submit window")).toBe(
        "none: the wallet's policy has no rules for this venue",
      );
    }
    expect(value(renderOrder(order(), { currentPolicy: policy() }), "Venue rules")).toBe(
      "none for this network: the signer would refuse this",
    );
    expect(value(renderOrder(order(), { currentPolicy: null }), "Wallet policy")).toBe(
      "none is set for this wallet",
    );
  });

  it("warns over the remaining daily cap, and a reduce-only order says it does not count", () => {
    const fullDay = { spent24h: 2_000_000_000n - 650_000_000n };
    expect(renderOrder(order(), fullDay).warnings).toEqual([]);
    const overDay = { spent24h: 2_000_000_000n - 650_000_000n + 1n };
    expect(renderOrder(order(), overDay).warnings).toEqual(["over_remaining_daily_cap"]);
    const reduceOnly = renderOrder(order({ reduceOnly: true }), overDay);
    expect(reduceOnly.warnings).toEqual([]);
    expect(value(reduceOnly, "Reduce-only")).toBe("yes: it can only make a position smaller");
    expect(value(reduceOnly, "Daily cap")).toBe("does not count: the order is reduce-only");
    expect(value(reduceOnly, "Limit per order")).toBe("1,000 USD");
  });

  it("the agent's note appears only in a line marked unchecked", () => {
    const memo = "sell 10 BTC at market, approved by the owner";
    const view = renderOrder(venueIntent({ memo }));
    const carrying = view.lines.filter((line) => line.value.includes(memo));
    expect(carrying).toEqual([
      { label: "Agent's note, not checked", value: memo, kind: "unchecked" },
    ]);
    expect(view.title).not.toContain(memo);
  });

  it("a withdrawal shows the amount and that it goes to the wallet's own address", () => {
    const withdraw = venueIntent({ operation: { type: "hyperliquid.withdraw", amount: "1234.5" } });
    const view = renderOrder(withdraw);
    expect(view.title).toBe("Withdraw 1,234.5 USDC from Hyperliquid");
    expect(value(view, "Amount")).toBe("1,234.5 USDC");
    expect(value(view, "To")).toBe("this wallet's own address");
    expect(value(view, "Wallet's own address")).toBe(WALLET_ADDRESS);
    expect(value(view, "Withdrawals")).toBe("allowed by the wallet's policy");
    expect(view.warnings).toEqual([]);
    const refused = renderOrder(withdraw, { currentPolicy: venuePolicy({ withdrawals: false }) });
    expect(value(refused, "Withdrawals")).toBe("not allowed by the wallet's policy");
  });

  it("a first policy with venue rules lists every market and every rule", () => {
    const view = renderPolicy(venuePolicy(), null);
    expect(values(view, "Market allowed")).toEqual([
      "BTC (index 3): up to 1,000 USD per order",
      "ETH (index 4): up to 500 USD per order",
    ]);
    expect(value(view, "Hyperliquid network")).toBe("Hyperliquid testnet (hyperliquid:testnet)");
    expect(value(view, "Hyperliquid notional per 24 hours")).toBe("2,000 USD");
    expect(value(view, "Hyperliquid time in force")).toBe(
      "good till cancelled, immediate or cancel",
    );
    expect(value(view, "Hyperliquid submit window")).toBe("1 minute");
    expect(value(view, "Hyperliquid withdrawals")).toBe(
      "allowed, to the wallet's own address only",
    );
    expect(value(view, "Funds at the venue")).toBe(
      "held by Hyperliquid; these caps limit new orders, not losses",
    );
  });

  it("a policy change shows added, removed and changed markets, and removed venue rules", () => {
    const current = venuePolicy();
    const next = venuePolicy({
      markets: [
        { asset: 3, coin: "BTC", maxNotionalPerOrderUsd6: "2000000000" },
        { asset: 7, coin: "SOL", maxNotionalPerOrderUsd6: "100000000" },
      ],
      timeInForce: ["Ioc"],
    });
    const view = renderPolicy({ ...next, revision: 2, previousHash: DIGEST_A }, current);
    expect(values(view, "Market added")).toEqual(["SOL (index 7): up to 100 USD per order"]);
    expect(values(view, "Market removed")).toEqual(["ETH (index 4): up to 500 USD per order"]);
    expect(values(view, "Market changed")).toEqual([
      "BTC (index 3): up to 1,000 USD per order → BTC (index 3): up to 2,000 USD per order",
    ]);
    expect(value(view, "Hyperliquid time in force")).toBe(
      "good till cancelled, immediate or cancel → immediate or cancel",
    );
    const same = renderPolicy({ ...current, revision: 2, previousHash: DIGEST_A }, current);
    expect(value(same, "Hyperliquid markets")).toBe("unchanged (2)");
    const removed = renderPolicy(policy({ revision: 2, previousHash: DIGEST_A }), current);
    expect(value(removed, "Hyperliquid")).toBe(
      "removed: no order or withdrawal can be signed there",
    );
    expect(
      renderPolicy(policy(), null).lines.some((line) => line.label.includes("Hyperliquid")),
    ).toBe(false);
  });

  it("an order's view is a valid view of its envelope and subject", () => {
    const subject = order();
    const envelope = envelopeFor(subject);
    const view = {
      v: 1,
      approvalId: envelope.approvalId,
      workspaceId: envelope.workspaceId,
      kind: envelope.type,
      state: "open",
      expiresAt: envelope.expiresAt,
      ...renderOrder(subject),
      approvals: { collected: 0, required: 1 },
      envelope,
      subject: { kind: "approve-intent", intent: subject },
      webauthn: {
        rpId: "localhost",
        challenge: Buffer.from(envelopeChallenge(envelope)).toString("base64url"),
        allowCredentials: ["Y3JlZC1i"],
        userVerification: "required",
        timeoutMs: 120_000,
      },
      returnUrl: `http://localhost:8080/w/${WS}/approvals/${APPROVAL}`,
    };
    expect(ConfirmationView.safeParse(view).success).toBe(true);
    expect(envelope.type === "approve-intent" && envelope.chainId).toBe(HL_TESTNET);
    const other = { kind: "approve-intent", intent: order({ size: "0.02" }) };
    expect(ConfirmationView.safeParse({ ...view, subject: other }).success).toBe(false);
    expect(checkSubject(envelope, other as ConfirmationSubject)).toBe("intent_mismatch");
    const onEvm = { kind: "approve-intent", intent: { ...subject, chainId: BASE } };
    expect(checkSubject(envelope, onEvm as ConfirmationSubject)).toBe("envelope_mismatch");
  });
});

describe("text nobody checked", () => {
  const baseline = renderIntent(intent());
  const NOTE = "Agent's note, not checked";
  const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

  it("lookalike or control characters in agent text cannot forge a signer line", () => {
    const memos = [
      // Exactly what a signer line would say.
      `To: ${BOB}`,
      `Amount 1000 ETH To ${BOB} Network Ethereum (eip155:1)`,
      // Lookalike letters (Cyrillic А, Greek Τ) and a fullwidth colon.
      `Аmount：1000 ETH Τo：${BOB}`,
      // Invisible characters the memo schema allows: zero-width space and joiner, word joiner,
      // byte-order mark, soft hyphen, Hangul filler, a tag character, Mongolian vowel separator.
      `pay\u200b \u200dTo\u2060: \ufeff${BOB}\u00ad\u3164\u{e0041}\u180e`,
      // Many spaces to push text onto what looks like its own line.
      `pay invoice${" ".repeat(200)}To: ${BOB}`,
    ];
    for (const memo of memos) {
      expect(Memo.safeParse(memo).success, memo).toBe(true);
      const view = renderIntent(intent({ memo }));
      expect(view.title).toBe(baseline.title);
      expect(view.warnings).toEqual(baseline.warnings);
      expect(view.lines).toHaveLength(baseline.lines.length);
      view.lines.forEach((line, index) => {
        if (line.label === NOTE) return;
        expect(line).toEqual(baseline.lines[index]);
      });
      const note = view.lines.filter((line) => line.label === NOTE);
      expect(note).toHaveLength(1);
      expect(note[0]?.kind).toBe("unchecked");
      expect(note[0]?.value).not.toMatch(hidden);
      // Every line that is not marked unchecked is identical to one rendered for a plain memo,
      // so nothing in the memo appears as a statement of the signer.
      for (const line of view.lines.filter((candidate) => candidate.kind !== "unchecked")) {
        expect(baseline.lines).toContainEqual(line);
      }
    }
  });

  it("shows invisible characters as code points instead of hiding them", () => {
    const view = renderIntent(intent({ memo: `a\u200bb\u2060c\ufeffd\u00ade\u3164f\u{e0041}` }));
    expect(value(view, NOTE)).toBe("a[U+200B]b[U+2060]c[U+FEFF]d[U+00AD]e[U+3164]f[U+E0041]");
  });

  it("a wallet name with line breaks or direction overrides stays one marked value", () => {
    // Wallet names are chosen in the control plane and are not hashed, so nothing stopped
    // these characters before the signer stored them.
    const label = `Ops\nTo: ${BOB}\u2028Amount: 0 ETH\u202e\t\u0085\u0000\u2066x\u2069`;
    const view = renderIntent(intent(), { wallet: { label, address: WALLET_ADDRESS } });
    expect(view.lines).toHaveLength(baseline.lines.length);
    const shown = value(view, "Wallet name, not checked");
    expect(shown).toBe(
      `Ops[U+000A]To: ${BOB}[U+2028]Amount: 0 ETH[U+202E][U+0009][U+0085][U+0000][U+2066]x[U+2069]`,
    );
    expect(shown).not.toMatch(hidden);
    expect(view.lines.find((line) => line.value === shown)?.kind).toBe("unchecked");
    expect(view.title).toBe(baseline.title);
  });

  it("an empty note adds no line", () => {
    const view = renderIntent(intent({ memo: "" }));
    expect(values(view, NOTE)).toEqual([]);
  });
});

describe("policies", () => {
  const current = policy();
  const currentHash = policyHash(current);

  it("a policy change lists every changed field against the current policy", () => {
    const next = policy({
      revision: 2,
      previousHash: currentHash,
      chains: [MAINNET, BASE],
      requesters: [OTHER_AGENT],
      assets: [
        {
          chainId: MAINNET,
          asset: "native",
          maxPerTx: "100000000000000000",
          maxPerDay: "300000000000000000",
        },
        { chainId: BASE, asset: TOKEN, maxPerTx: "5000000", maxPerDay: "20000000" },
        {
          chainId: BASE,
          asset: "native",
          maxPerTx: "2000000000000000000",
          maxPerDay: "5000000000000000000",
        },
      ],
      recipients: { mode: "allowlist", addresses: [ALICE] },
      contractCalls: { mode: "allowlist", targets: [ROUTER] },
      fees: { maxPerTxWei: "20000000000000000" },
      approvals: { threshold: 2, ttlSeconds: 7200 },
    });
    const view = renderPolicy(next, current);
    expect(view.title).toBe("Change a wallet's policy");
    expect(view.warnings).toEqual([]);
    expect(view.lines.slice(0, 20)).toEqual([
      { label: "Wallet", value: WALLET, kind: "code" },
      { label: "Wallet address", value: WALLET_ADDRESS, kind: "address" },
      { label: "Wallet name, not checked", value: "Operations", kind: "unchecked" },
      { label: "Policy revision", value: "1 → 2", kind: "text" },
      { label: "Chain added", value: "Ethereum (eip155:1)", kind: "code" },
      { label: "Agent added", value: OTHER_AGENT, kind: "code" },
      { label: "Agent removed", value: AGENT, kind: "code" },
      {
        label: "Limit added",
        value: "ETH on Ethereum (eip155:1): 0.1 ETH per transaction, 0.3 ETH per 24 hours",
        kind: "amount",
      },
      {
        label: "Limit added",
        value: "USDC on Base (eip155:8453): 5 USDC per transaction, 20 USDC per 24 hours",
        kind: "amount",
      },
      {
        label: "Limit changed",
        value:
          "ETH on Base (eip155:8453): per transaction 1 ETH → 2 ETH; per 24 hours 5 ETH (unchanged)",
        kind: "amount",
      },
      { label: "Recipients", value: "anyone → only listed addresses (1)", kind: "text" },
      { label: "Recipient allowed", value: ALICE, kind: "address" },
      { label: "Contract calls", value: "none → only listed contracts (1)", kind: "text" },
      { label: "Contract allowed", value: ROUTER, kind: "address" },
      {
        label: "Largest network fee per transaction",
        value: "0.01 of the native coin → 0.02 of the native coin",
        kind: "amount",
      },
      { label: "Approvals needed per transaction", value: "1 → 2", kind: "text" },
      {
        label: "Longest an approved transaction stays usable",
        value: "1 hour → 2 hours",
        kind: "text",
      },
      { label: "Workspace", value: WS, kind: "code" },
      { label: "Request id", value: APPROVAL, kind: "code" },
      { label: "Valid until", value: "2023-11-14 22:23:20 UTC", kind: "text" },
    ]);
  });

  it("lists what a policy removes", () => {
    const wide = policy({
      chains: [MAINNET, BASE],
      assets: [
        {
          chainId: MAINNET,
          asset: "native",
          maxPerTx: "100000000000000000",
          maxPerDay: "300000000000000000",
        },
        ...policy().assets,
      ],
      recipients: { mode: "allowlist", addresses: [ALICE, BOB] },
      contractCalls: { mode: "allowlist", targets: [ROUTER] },
    });
    const narrow = policy({
      revision: 2,
      previousHash: policyHash(wide),
      recipients: { mode: "allowlist", addresses: [BOB, TREASURY] },
      contractCalls: { mode: "deny" },
    });
    const view = renderPolicy(narrow, wide);
    expect(values(view, "Chain removed")).toEqual(["Ethereum (eip155:1)"]);
    expect(values(view, "Limit removed")).toEqual([
      "ETH on Ethereum (eip155:1): can no longer leave the wallet",
    ]);
    // Same count before and after: the summary must not read as unchanged.
    expect(value(view, "Recipients")).toBe("only listed addresses (2), changed below");
    expect(values(view, "Recipient added")).toEqual([TREASURY]);
    expect(values(view, "Recipient removed")).toEqual([ALICE]);
    expect(value(view, "Contract calls")).toBe("only listed contracts (1) → none");
    expect(values(view, "Contract removed")).toEqual([]);
  });

  it("says unchanged for every field a new revision keeps", () => {
    const same = policy({ revision: 2, previousHash: currentHash });
    const view = renderPolicy(same, current);
    expect(value(view, "Policy revision")).toBe("1 → 2");
    expect(value(view, "Chains")).toBe("unchanged (1)");
    expect(value(view, "Agents that may propose")).toBe("unchanged (1)");
    expect(value(view, "Limits")).toBe("unchanged (1)");
    expect(value(view, "Recipients")).toBe("anyone (unchanged)");
    expect(value(view, "Contract calls")).toBe("none (unchanged)");
    expect(value(view, "Largest network fee per transaction")).toBe(
      "0.01 of the native coin (unchanged)",
    );
    expect(value(view, "Approvals needed per transaction")).toBe("1 (unchanged)");
    expect(value(view, "Longest an approved transaction stays usable")).toBe("1 hour (unchanged)");
  });

  it("a first policy lists every field and warns first_policy", () => {
    const first = policy({
      chains: [BASE, UNLISTED_CHAIN],
      requesters: [AGENT, OTHER_AGENT],
      assets: [
        { chainId: BASE, asset: TOKEN, maxPerTx: "5000000", maxPerDay: "20000000" },
        ...policy().assets,
        {
          chainId: UNLISTED_CHAIN,
          asset: "0x9999999999999999999999999999999999999999",
          maxPerTx: "7",
          maxPerDay: "70000",
        },
      ],
      recipients: { mode: "allowlist", addresses: [ALICE, BOB] },
      approvals: { threshold: 1, ttlSeconds: 90 },
    });
    const view = renderPolicy(first, null);
    expect(view.title).toBe("Set a wallet's first policy");
    expect(view.warnings).toEqual(["unknown_token", "unknown_chain", "first_policy"]);
    expect(value(view, "Policy revision")).toBe("1");
    expect(values(view, "Chain allowed")).toEqual(["Base (eip155:8453)", UNLISTED_CHAIN]);
    expect(values(view, "Agent allowed")).toEqual([AGENT, OTHER_AGENT]);
    expect(values(view, "Limit")).toEqual([
      "USDC on Base (eip155:8453): 5 USDC per transaction, 20 USDC per 24 hours",
      "ETH on Base (eip155:8453): 1 ETH per transaction, 5 ETH per 24 hours",
      "token 0x9999999999999999999999999999999999999999 on eip155:999: 7 base units per transaction, 70,000 base units per 24 hours",
    ]);
    expect(value(view, "Recipients")).toBe("only listed addresses (2)");
    expect(values(view, "Recipient allowed")).toEqual([ALICE, BOB]);
    expect(value(view, "Contract calls")).toBe("none");
    expect(value(view, "Largest network fee per transaction")).toBe("0.01 of the native coin");
    expect(value(view, "Approvals needed per transaction")).toBe("1");
    expect(value(view, "Longest an approved transaction stays usable")).toBe("90 seconds");
  });

  it("a first policy with nothing allowed says so", () => {
    const empty = policy({ chains: [], requesters: [], assets: [] });
    const view = renderPolicy(empty, null);
    expect(value(view, "Chains")).toBe("none");
    expect(value(view, "Agents that may propose")).toBe("none");
    expect(value(view, "Limits")).toBe("none: nothing can leave the wallet");
  });
});

describe("approvers and the workspace", () => {
  // A COSE EC2 P-256 key with x = 01..20 and y = 21..40. The fingerprint was computed outside
  // this code: SHA-256 of these bytes, first 10 bytes, Crockford base32.
  const COSE_KEY =
    "pQECAyYgASFYIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gIlggISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A";
  const COSE_KEY_LAST_BIT_FLIPPED =
    "pQECAyYgASFYIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gIlggISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0E";

  it("keyFingerprint is stable against a pinned vector and differs for a different key", () => {
    expect(keyFingerprint(COSE_KEY)).toBe("HJXJ-SC60-JX3T-5YS9");
    expect(keyFingerprint(COSE_KEY_LAST_BIT_FLIPPED)).toBe("CGAR-APPR-R5CM-Q1BH");
    expect(keyFingerprint("cHVibGljLWtleQ")).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
  });

  it("keyFingerprint decodes base64url with '-' and '_' and without padding", () => {
    // The bytes fb ff bf fe 01; the expected value was computed outside this code.
    expect(keyFingerprint("-_-__gE")).toBe("EP59-P7JR-J6CS-HH38");
  });

  it("adding an approver shows the person, credential, key fingerprint and threshold", () => {
    const envelope = addApprover({ publicKey: COSE_KEY });
    const unproven = render(envelope, envelopeOnly, { adminThreshold: 2, wallet: null });
    expect(unproven.title).toBe("Add an approver");
    expect(value(unproven, "Person")).toBe(USER_B);
    expect(value(unproven, "Passkey credential id")).toBe("Y3JlZC1i");
    expect(value(unproven, "Key fingerprint")).toBe("HJXJ-SC60-JX3T-5YS9");
    expect(value(unproven, "The new person proved they hold this passkey")).toBe("no");
    expect(value(unproven, "Approvals needed for workspace changes")).toBe("2 (unchanged)");
    expect(unproven.warnings).toEqual(["possession_unproven"]);

    const proven = render(envelope, envelopeOnly, { possessionProven: true, wallet: null });
    expect(value(proven, "The new person proved they hold this passkey")).toBe("yes");
    expect(proven.warnings).toEqual([]);

    // A swapped key shows a different fingerprint.
    const swapped = render(addApprover({ publicKey: COSE_KEY_LAST_BIT_FLIPPED }), envelopeOnly);
    expect(value(swapped, "Key fingerprint")).not.toBe(value(proven, "Key fingerprint"));
  });

  it("removing an approver names the person and credential", () => {
    const view = render(removeApprover(), envelopeOnly, { wallet: null });
    expect(view.title).toBe("Remove an approver");
    expect(value(view, "Person")).toBe(USER_B);
    expect(value(view, "Passkey credential id")).toBe("Y3JlZC1i");
    expect(value(view, "Approvals needed for workspace changes")).toBe("1 (unchanged)");
  });

  it("changing the admin threshold shows the current and new value", () => {
    const view = render(setAdminThreshold({ adminThreshold: 3 }), envelopeOnly, {
      adminThreshold: 1,
    });
    expect(view.title).toBe("Change the approvals needed for workspace changes");
    expect(value(view, "Approvals needed for workspace changes")).toBe("1 → 3");
  });

  it("resuming a workspace says what it re-enables", () => {
    const view = render(resumeWorkspace(), envelopeOnly);
    expect(view.title).toBe("Resume the workspace");
    expect(value(view, "Effect")).toBe(
      "the workspace's wallets can sign again, within their policies",
    );
    expect(value(view, "Workspace")).toBe(WS);
    expect(value(view, "Valid until")).toBe("2023-11-14 22:23:20 UTC");
  });
});

describe("sweeps", () => {
  const renderSweep = (subject: Sweep, overrides: Partial<RenderInput> = {}) =>
    render(sweepEnvelope(subject), { kind: "sweep-wallet", sweep: subject }, overrides);

  it("a sweep to a treasury shows the amount, destination, chain and fee ceiling", () => {
    const view = renderSweep(sweep(), { treasuries: [TREASURY] });
    expect(view.title).toBe("Move 2 ETH out of the wallet");
    expect(value(view, "Amount")).toBe("2 ETH");
    expect(value(view, "To")).toBe(TREASURY);
    expect(value(view, "Destination")).toBe("a treasury wallet of this workspace");
    expect(value(view, "Network")).toBe("Base (eip155:8453)");
    expect(value(view, "Network fee ceiling")).toBe("0.001 ETH");
    expect(value(view, "Wallet limits")).toBe(
      "do not apply: a sweep needs the workspace-change approvals",
    );
    expect(value(view, "Wallet")).toBe(WALLET);
    expect(view.warnings).toEqual([]);
  });

  it("a token sweep shows the token, and an unlisted destination warns", () => {
    const subject = sweep({ asset: TOKEN, amount: "1000000", to: ALICE });
    const allowlisted = renderSweep(subject, {
      currentPolicy: policy({ recipients: { mode: "allowlist", addresses: [ALICE] } }),
    });
    expect(allowlisted.title).toBe("Move 1 USDC out of the wallet");
    expect(value(allowlisted, "Token contract")).toBe(TOKEN);
    expect(value(allowlisted, "Destination")).toBe("on the wallet's recipient allowlist");
    expect(allowlisted.warnings).toEqual([]);

    const anywhere = renderSweep(subject, { assets: [] });
    expect(anywhere.title).toBe("Move 1,000,000 base units of an unknown token out of the wallet");
    expect(value(anywhere, "Destination")).toBe(
      "neither on the wallet's allowlist nor a treasury wallet of this workspace",
    );
    expect(anywhere.warnings).toEqual(["unknown_token", "recipient_not_allowlisted"]);
  });

  it("a sweep back to the wallet itself is not shown as an allowed destination", () => {
    const view = renderSweep(sweep({ to: WALLET_ADDRESS }), {
      treasuries: [WALLET_ADDRESS],
      currentPolicy: policy({ recipients: { mode: "allowlist", addresses: [WALLET_ADDRESS] } }),
    });
    expect(value(view, "Destination")).toBe("the wallet itself");
    expect(view.warnings).toEqual(["recipient_not_allowlisted"]);
  });
});

describe("cancels", () => {
  const target = (operation: Operation, attempts = 1, cancelling = false) => ({
    cancelTarget: { operation, attempts, cancelling },
  });
  const transfer: Operation = { type: "evm.transfer", to: ALICE, valueWei: "250000000000000000" };

  it("names what it would stop from the signer's record, its nonce and its own fee ceiling, and says it is an attempt", () => {
    const view = render(cancelTransaction(), envelopeOnly, target(transfer));
    expect(view.title).toBe("Try to cancel sending 0.25 ETH");
    expect(value(view, "Amount it would send")).toBe("0.25 ETH");
    expect(value(view, "To")).toBe(ALICE);
    expect(value(view, "Request it was approved under")).toBe(TARGET_APPROVAL);
    expect(value(view, "Network")).toBe("Base (eip155:8453)");
    expect(value(view, "Transaction number (nonce)")).toBe("7");
    expect(value(view, "Network fee ceiling for the cancel")).toBe("0.002 ETH");
    expect(value(view, "Cancelling is an attempt")).toBe(
      "if the network includes the payment first, the payment happens and the cancel does nothing",
    );
    expect(value(view, "Wallet limits")).toMatch(/still counts/);
    expect(value(view, "Attempts signed so far")).toBe("1");
    expect(value(view, "Wallet address")).toBe(WALLET_ADDRESS);
    expect(view.lines.some((line) => line.label === "Cancelled before")).toBe(false);
    expect(view.warnings).toEqual([]);
  });

  it("every field of the envelope changes what is shown", () => {
    const base = render(cancelTransaction(), envelopeOnly, target(transfer)).lines;
    for (const change of [
      { targetApprovalId: `apr_01jd000000000000000000000f` as const },
      { chainId: MAINNET },
      { txNonce: 8 },
      { maxFeeWei: "2000000000000001" },
      { walletId: `wal_01jd000000000000000000000c` as const },
    ]) {
      expect(render(cancelTransaction(change), envelopeOnly, target(transfer)).lines).not.toEqual(
        base,
      );
    }
  });

  it("a token transfer, a contract call, a second cancel and a missing target are each shown as such", () => {
    const token = render(
      cancelTransaction(),
      envelopeOnly,
      target({ type: "evm.erc20.transfer", token: TOKEN, to: BOB, amount: "1500000" }, 3, true),
    );
    expect(token.title).toBe("Try to cancel sending 1.5 USDC");
    expect(value(token, "To")).toBe(BOB);
    expect(value(token, "Token contract")).toBe(TOKEN);
    expect(value(token, "Attempts signed so far")).toBe("3");
    expect(value(token, "Cancelled before")).toMatch(/^yes/);

    const call = render(
      cancelTransaction(),
      envelopeOnly,
      target({ type: "evm.call", to: ROUTER, valueWei: "0", data: "0xa9059cbb0000" }),
    );
    expect(call.title).toBe("Try to cancel a contract call");
    expect(value(call, "Contract it would call")).toBe(ROUTER);
    expect(value(call, "Function selector")).toBe("0xa9059cbb");
    expect(call.warnings).toEqual([]);

    const missing = render(cancelTransaction(), envelopeOnly);
    expect(missing.title).toBe("Try to cancel a transaction that was not mined");
    expect(value(missing, "Transaction to cancel")).toBe("not found at the signer");
  });
});

describe("retiring and deleting", () => {
  const operations: SignerWalletRecord = {
    walletId: WALLET,
    label: "Operations",
    address: WALLET_ADDRESS,
  };
  const treasury: SignerWalletRecord = {
    walletId: OTHER_WALLET,
    label: "Treasury",
    address: OTHER_WALLET_ADDRESS,
  };
  const records = [operations, treasury];
  const lifecycle = (envelope: Envelope, overrides: Partial<RenderInput> = {}) =>
    render(envelope, envelopeOnly, { wallet: null, wallets: records, ...overrides });

  it("a retirement names the wallet, its address and name, and the destroy time, and warns", () => {
    const view = lifecycle(retireWallet());
    expect(view.title).toBe("Retire a wallet");
    expect(view.warnings).toEqual(["keys_destroyed", "balances_unchecked"]);
    expect(value(view, "Wallet")).toBe(WALLET);
    expect(value(view, "Wallet address")).toBe(WALLET_ADDRESS);
    expect(value(view, "Wallet address, checksummed (EIP-55)")).toBe(
      "0x5555555555555555555555555555555555555555",
    );
    const name = view.lines.find((line) => line.label === "Wallet name, not checked");
    expect(name).toEqual({
      label: "Wallet name, not checked",
      value: "Operations",
      kind: "unchecked",
    });
    expect(value(view, "Key destroyed after")).toBe("2023-11-21 22:13:20 UTC");
    expect(value(view, "Time to cancel")).toBe("7 days from the request");
    expect(value(view, "Effect")).toMatch(/signs nothing and its mandates end/);
    expect(value(view, "If cancelled")).toMatch(/until a new policy is approved/);
    expect(value(view, "Workspace")).toBe(WS);
    expect(view.lines.some((line) => line.label === "At the signer")).toBe(false);
  });

  it("a deletion lists every wallet with its address and the signer's name for it, and warns", () => {
    const view = lifecycle(deleteWorkspace());
    expect(view.title).toBe("Delete this workspace");
    expect(view.warnings).toEqual(["keys_destroyed", "balances_unchecked"]);
    expect(value(view, "Wallets")).toBe("2 wallets");
    expect(values(view, "Wallet")).toEqual([WALLET, OTHER_WALLET]);
    expect(values(view, "Wallet address")).toEqual([WALLET_ADDRESS, OTHER_WALLET_ADDRESS]);
    expect(values(view, "Wallet name, not checked")).toEqual(["Operations", "Treasury"]);
    expect(value(view, "Keys destroyed after")).toBe("2023-11-21 22:13:20 UTC");
    expect(value(view, "Time to cancel")).toBe("7 days from the request");
    expect(value(view, "If cancelled")).toMatch(/stays paused until resuming it is approved/);
  });

  it("a deletion of a workspace without wallets says so and warns of nothing", () => {
    const view = lifecycle(deleteWorkspace({ wallets: [] }));
    expect(value(view, "Wallets")).toBe("none");
    expect(values(view, "Wallet")).toEqual([]);
    expect(view.warnings).toEqual([]);
  });

  it("a wallet the signer does not hold, or holds at another address, is shown as refused", () => {
    const missing = lifecycle(retireWallet(), { wallets: [] });
    expect(value(missing, "At the signer")).toBe(
      "not found in this workspace: the signer will refuse this",
    );
    expect(values(missing, "Wallet name, not checked")).toEqual([]);

    const moved = lifecycle(deleteWorkspace(), {
      wallets: [operations, { ...treasury, address: ALICE }],
    });
    expect(value(moved, "Address at the signer")).toBe(ALICE);
    expect(value(moved, "At the signer")).toBe("another address: the signer will refuse this");
    expect(values(moved, "Wallet address")).toEqual([WALLET_ADDRESS, OTHER_WALLET_ADDRESS]);
  });

  it("every field of either envelope changes what is shown", () => {
    const retired = lifecycle(retireWallet()).lines;
    for (const change of [
      { wallet: { walletId: OTHER_WALLET, address: OTHER_WALLET_ADDRESS } },
      { wallet: { walletId: WALLET, address: OTHER_WALLET_ADDRESS } },
      { destroyAfter: T0 + DESTROY_DELAY + 3600 },
    ]) {
      expect(lifecycle(retireWallet(change)).lines).not.toEqual(retired);
    }
    const deleted = lifecycle(deleteWorkspace()).lines;
    for (const change of [
      { wallets: [{ walletId: WALLET, address: WALLET_ADDRESS }] },
      { destroyAfter: T0 + 86_400 },
    ]) {
      expect(lifecycle(deleteWorkspace(change)).lines).not.toEqual(deleted);
    }
  });

  it("a wallet name nobody checked cannot forge a signer line", () => {
    const view = lifecycle(retireWallet(), {
      wallets: [{ ...operations, label: "Ops\nKey destroyed after: never\u202e" }],
    });
    expect(values(view, "Key destroyed after")).toEqual(["2023-11-21 22:13:20 UTC"]);
    expect(value(view, "Wallet name, not checked")).toBe(
      "Ops[U+000A]Key destroyed after: never[U+202E]",
    );
  });

  it("their views are valid views of their envelopes", () => {
    for (const envelope of [retireWallet(), deleteWorkspace()]) {
      const view = {
        v: 1,
        approvalId: envelope.approvalId,
        workspaceId: envelope.workspaceId,
        kind: envelope.type,
        state: "open",
        expiresAt: envelope.expiresAt,
        ...lifecycle(envelope),
        approvals: { collected: 0, required: 1 },
        envelope,
        subject: envelopeOnly,
        webauthn: {
          rpId: "localhost",
          challenge: Buffer.from(envelopeChallenge(envelope)).toString("base64url"),
          allowCredentials: ["Y3JlZC1i"],
          userVerification: "required",
          timeoutMs: 120_000,
        },
        returnUrl: `http://localhost:8080/w/${WS}/approvals/${APPROVAL}`,
      };
      expect(ConfirmationView.safeParse(view).success, envelope.type).toBe(true);
    }
  });
});

describe("mandates", () => {
  const USDC_ON_BASE: AssetLabel = { chainId: BASE, asset: USDC_BASE, symbol: "USDC", decimals: 6 };
  const usdcPolicy = policy({
    assets: [
      { chainId: BASE, asset: USDC_BASE, maxPerTx: "100000000", maxPerDay: "500000000" },
      ...policy().assets,
    ],
  });
  const ETH_LIMIT = mandateAsset({
    asset: "native",
    maxPerAction: "100000000000000000",
    maxPerWindow: "500000000000000000",
    maxTotal: "1000000000000000000",
  });
  const renderMandate = (subject: Mandate, overrides: Partial<RenderInput> = {}) =>
    render(
      mandateEnvelope(subject),
      { kind: "grant-mandate", mandate: subject },
      { assets: [USDC, USDC_ON_BASE], currentPolicy: usdcPolicy, ...overrides },
    );
  const PURPOSE = "Purpose, not checked";

  it("shows the wallet, the agent, every cap, every recipient, the end time and the worst case", () => {
    const view = renderMandate(mandate());
    expect(view.title).toBe("Let an agent pay up to 1,000 USDC without asking");
    expect(view.lines).toEqual([
      { label: "Agent that may pay", value: AGENT, kind: "code" },
      { label: "Wallet", value: WALLET, kind: "code" },
      { label: "Wallet address", value: WALLET_ADDRESS, kind: "address" },
      { label: "Wallet name, not checked", value: "Operations", kind: "unchecked" },
      {
        label: "Wallet policy",
        value: "still applies: each payment must also fit it",
        kind: "text",
      },
      { label: "Asset", value: "USDC on Base (eip155:8453)", kind: "text" },
      { label: "Token contract", value: USDC_BASE, kind: "address" },
      {
        label: "Token contract, checksummed (EIP-55)",
        value: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        kind: "address",
      },
      { label: "Most per payment", value: "100 USDC", kind: "amount" },
      { label: "Most in any 24 hours", value: "500 USDC", kind: "amount" },
      { label: "Most in total", value: "1,000 USDC", kind: "amount" },
      { label: "Most that can leave the wallet", value: "1,000 USDC", kind: "amount" },
      {
        label: "Wallet's limits",
        value: "100 USDC per transaction, 500 USDC per 24 hours",
        kind: "amount",
      },
      { label: "Recipients", value: "only these 3 addresses", kind: "text" },
      ...[ALICE, BOB, TOKEN].flatMap((address) => [
        { label: "May pay", value: address, kind: "address" },
        { label: "May pay, checksummed (EIP-55)", value: address, kind: "address" },
        {
          label: "Recipient allowlist",
          value: "the wallet's policy allows any recipient",
          kind: "text",
        },
      ]),
      { label: "Payments at most", value: "20 payments", kind: "text" },
      {
        label: "Network fee ceiling per payment",
        value: "0.002 of the native coin",
        kind: "amount",
      },
      { label: "Network fees at most, in total", value: "0.04 of the native coin", kind: "amount" },
      { label: "Starts", value: "2023-11-14 22:13:20 UTC", kind: "text" },
      { label: "Ends", value: "2023-11-21 22:00:00 UTC", kind: "text" },
      {
        label: "What counts",
        value: "every payment the signer signs, also one the network never includes",
        kind: "text",
      },
      { label: "Mandate id", value: MANDATE, kind: "code" },
      { label: PURPOSE, value: "pay supplier invoices this week", kind: "unchecked" },
      { label: "Workspace", value: WS, kind: "code" },
      { label: "Request id", value: APPROVAL, kind: "code" },
      { label: "Valid until", value: "2023-11-14 22:23:20 UTC", kind: "text" },
      { label: "Approvals so far", value: "0 of 1", kind: "text" },
    ]);
    expect(view.warnings).toEqual([]);
  });

  it("every field that changes what is approved changes what is shown", () => {
    const baseline = renderMandate(mandate());
    const changes: Partial<Mandate>[] = [
      { id: `mnd_${"0".repeat(25)}9` },
      { workspaceId: `ws_${"0".repeat(25)}9` },
      { walletId: `wal_${"0".repeat(25)}9` },
      { agentId: OTHER_AGENT },
      { assets: [mandateAsset({ chainId: MAINNET })] },
      { assets: [mandateAsset({ asset: TOKEN })] },
      { assets: [mandateAsset({ maxPerAction: "100000001" })] },
      { assets: [mandateAsset({ maxPerWindow: "500000001" })] },
      { assets: [mandateAsset({ maxTotal: "1000000001" })] },
      { windowSeconds: 86_401 },
      { recipients: [ALICE, BOB] },
      { maxUses: 21 },
      { maxFeePerActionWei: "2000000000000001" },
      { notBefore: T0 + 1 },
      { notAfter: T0 + 604_001 },
      { purpose: "pay supplier invoices next week" },
    ];
    expect(new Set(changes.flatMap((change) => Object.keys(change)))).toEqual(
      new Set(Object.keys(mandate()).filter((key) => key !== "v")),
    );
    for (const change of changes) {
      const view = renderMandate(mandate(change));
      expect(view.lines, JSON.stringify(change)).not.toEqual(baseline.lines);
    }
  });

  it("names the worst case by the uses when they bound it, and counts payments in words", () => {
    const usesBound = renderMandate(mandate({ maxUses: 5 }));
    expect(usesBound.title).toBe("Let an agent pay up to 500 USDC without asking");
    expect(value(usesBound, "Most that can leave the wallet")).toBe("500 USDC");
    expect(value(usesBound, "Payments at most")).toBe("5 payments");
    expect(value(usesBound, "Network fees at most, in total")).toBe("0.01 of the native coin");
    expect(value(renderMandate(mandate({ maxUses: 1 })), "Payments at most")).toBe("1 payment");
    const one = renderMandate(mandate({ recipients: [BOB] }));
    expect(value(one, "Recipients")).toBe("only this address");
    expect(values(one, "May pay")).toEqual([BOB]);
  });

  it("names the window in the signer's words", () => {
    const label = (windowSeconds: number) =>
      renderMandate(mandate({ windowSeconds })).lines.find((line) =>
        line.label.startsWith("Most in any "),
      )?.label;
    expect(label(3600)).toBe("Most in any 1 hour");
    expect(label(86_400)).toBe("Most in any 24 hours");
    expect(label(172_800)).toBe("Most in any 2 days");
    expect(label(604_800)).toBe("Most in any 7 days");
  });

  it("a native coin needs no token lines, and several assets each get their caps", () => {
    const native = renderMandate(mandate({ assets: [ETH_LIMIT] }));
    expect(native.title).toBe("Let an agent pay up to 1 ETH without asking");
    expect(value(native, "Asset")).toBe("ETH on Base (eip155:8453)");
    expect(values(native, "Token contract")).toEqual([]);
    expect(value(native, "Wallet's limits")).toBe("1 ETH per transaction, 5 ETH per 24 hours");

    const both = renderMandate(mandate({ assets: [mandateAsset(), ETH_LIMIT] }));
    expect(both.title).toBe("Let an agent pay without asking, up to the amounts below");
    expect(values(both, "Asset")).toEqual([
      "USDC on Base (eip155:8453)",
      "ETH on Base (eip155:8453)",
    ]);
    expect(values(both, "Most that can leave the wallet")).toEqual(["1,000 USDC", "1 ETH"]);
    expect(values(both, "Most per payment")).toEqual(["100 USDC", "0.1 ETH"]);
  });

  it("an unknown token or chain is shown in base units with its warning", () => {
    const token = renderMandate(mandate(), { assets: [] });
    expect(token.title).toBe(
      "Let an agent pay up to 1,000,000,000 base units of an unknown token without asking",
    );
    expect(value(token, "Asset")).toBe(`token ${USDC_BASE} on Base (eip155:8453)`);
    expect(token.warnings).toEqual(["unknown_token"]);

    const chain = renderMandate(mandate({ assets: [ETH_LIMIT] }), { chains: [] });
    expect(chain.title).toBe("Let an agent pay up to 1,000,000,000,000,000,000 wei without asking");
    expect(value(chain, "Asset")).toBe("the native coin on eip155:8453");
    expect(chain.warnings).toEqual(["unknown_chain"]);
  });

  it("shows the wallet's policy as the outer limit, and warns for recipients it does not allow", () => {
    const allowlisted = renderMandate(mandate(), {
      currentPolicy: { ...usdcPolicy, recipients: { mode: "allowlist", addresses: [ALICE] } },
    });
    expect(values(allowlisted, "Recipient allowlist")).toEqual([
      "on the wallet's allowlist",
      "not on the wallet's allowlist",
      "not on the wallet's allowlist",
    ]);
    expect(allowlisted.warnings).toEqual(["recipient_not_allowlisted"]);

    const uncapped = renderMandate(mandate(), { currentPolicy: policy() });
    expect(value(uncapped, "Wallet's limits")).toBe(
      "none: the wallet's policy does not let it leave",
    );

    const none = renderMandate(mandate(), { currentPolicy: null });
    expect(value(none, "Wallet policy")).toBe("none is set for this wallet");
    expect(values(none, "Wallet's limits")).toEqual([]);
    expect(values(none, "Recipient allowlist")).toEqual([]);
  });

  it("a purpose nobody checked cannot forge a signer line", () => {
    const baseline = renderMandate(mandate());
    const purpose = `pay\u200b \u200dTo\u2060: \ufeff${BOB}`;
    expect(Memo.safeParse(purpose).success).toBe(true);
    const view = renderMandate(mandate({ purpose }));
    expect(value(view, PURPOSE)).toBe(`pay[U+200B] [U+200D]To[U+2060]: [U+FEFF]${BOB}`);
    const differing = view.lines.filter(
      (line, index) => line.value !== baseline.lines[index]?.value,
    );
    expect(differing.map((line) => line.label)).toEqual([PURPOSE]);
    expect(values(renderMandate(mandate({ purpose: "" })), PURPOSE)).toEqual([]);
  });

  it("a grant's view is a valid view of its envelope and subject", () => {
    const subject = mandate();
    const envelope = mandateEnvelope(subject);
    const view = {
      v: 1,
      approvalId: envelope.approvalId,
      workspaceId: envelope.workspaceId,
      kind: envelope.type,
      state: "open",
      expiresAt: envelope.expiresAt,
      ...renderMandate(subject),
      approvals: { collected: 0, required: 1 },
      envelope,
      subject: { kind: "grant-mandate", mandate: subject },
      webauthn: {
        rpId: "localhost",
        challenge: Buffer.from(envelopeChallenge(envelope)).toString("base64url"),
        allowCredentials: ["Y3JlZC1i"],
        userVerification: "required",
        timeoutMs: 120_000,
      },
      returnUrl: `http://localhost:8080/w/${WS}/approvals/${APPROVAL}`,
    };
    expect(ConfirmationView.safeParse(view).success).toBe(true);
    const other = { kind: "grant-mandate", mandate: mandate({ maxUses: 21 }) };
    expect(ConfirmationView.safeParse({ ...view, subject: other }).success).toBe(false);
  });
});

describe("schemas", () => {
  it("operator labels refuse names and symbols that could pass for something else", () => {
    const chain = { chainId: BASE, name: "Base", nativeSymbol: "ETH" };
    expect(ChainLabelSchema.safeParse(chain).success).toBe(true);
    for (const bad of [
      { ...chain, nativeSymbol: "E\u200bTH" },
      { ...chain, nativeSymbol: "ETH " },
      { ...chain, nativeSymbol: "ЕТН" },
      { ...chain, nativeSymbol: "ABCDEFGHIJKL" },
      { ...chain, name: "Base\nEthereum" },
      { ...chain, name: " Base" },
      { ...chain, name: "Bаse" },
      { ...chain, name: "x".repeat(41) },
    ]) {
      expect(ChainLabelSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ChainLabels.safeParse([chain, chain]).success).toBe(false);
    expect(AssetLabels.safeParse([USDC]).success).toBe(true);
    expect(AssetLabels.safeParse([USDC, { ...USDC, symbol: "USDT" }]).success).toBe(false);
    expect(AssetLabels.safeParse([{ ...USDC, decimals: 37 }]).success).toBe(false);
    expect(AssetLabels.safeParse([{ ...USDC, decimals: 1.5 }]).success).toBe(false);
  });

  it("a view must describe its own envelope and subject", () => {
    const subject = intent();
    const envelope = envelopeFor(subject);
    const rendered = renderIntent(subject);
    const view = {
      v: 1,
      approvalId: envelope.approvalId,
      workspaceId: envelope.workspaceId,
      kind: envelope.type,
      state: "open",
      expiresAt: envelope.expiresAt,
      ...rendered,
      approvals: { collected: 0, required: 1 },
      envelope,
      subject: { kind: "approve-intent", intent: subject },
      webauthn: {
        rpId: "localhost",
        challenge: Buffer.from(envelopeChallenge(envelope)).toString("base64url"),
        allowCredentials: ["Y3JlZC1i"],
        userVerification: "required",
        timeoutMs: 120_000,
      },
      returnUrl: `http://localhost:8080/w/${WS}/approvals/${APPROVAL}`,
    };
    expect(ConfirmationView.safeParse(view).success).toBe(true);
    for (const bad of [
      { ...view, kind: "add-approver" },
      { ...view, expiresAt: envelope.expiresAt + 1 },
      { ...view, subject: { kind: "approve-intent", intent: intent({ memo: "other" }) } },
      { ...view, returnUrl: "javascript:alert(1)" },
      { ...view, extra: true },
      { ...view, envelope: undefined },
    ]) {
      expect(ConfirmationView.safeParse(bad).success).toBe(false);
    }
  });
});
