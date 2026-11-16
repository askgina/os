import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AddApproverEnvelope,
  type Address,
  type AgentId,
  type ApprovalId,
  type ApproverCredential,
  AssertionResponse,
  type AssetLabel,
  type Authorization,
  type ChainLabel,
  type Envelope,
  type EvmIntent,
  type Intent,
  intentHash,
  type Mandate,
  mandateHash,
  newId,
  type Operation,
  policyHash,
  type UserId,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import {
  type ConfirmClient,
  createConfirmClient,
  createSignerClient,
  type GetPossessionResponse,
  type GrantMandateRequest,
  type MandateState,
  type SignerClient,
  SignerError,
  type SignUnderMandateRequest,
  type TransactionParams,
} from "@askgina/os-protocol/signer";
import {
  approverCredentialOf,
  assertEnvelope,
  SoftAuthenticator,
} from "@askgina/os-protocol/testing";
import { expect } from "vitest";
import {
  createSigner,
  createTestVault,
  type Signer,
  type SignerOptions,
  type Vault,
} from "../src/index.ts";

/** The RP ID passkeys are registered under. */
export const RP_ID = "localhost";

/** The control plane's page: the same RP ID, where people sign in, and never an approval origin. */
export const ORIGIN = "http://localhost:5173";

export const CHAIN = "eip155:31337" as const;

export const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;

export const TOKEN = "0x00000000000000000000000000000000000000bb" as const;

/** A contract-call target. Never a capped token: the policy schema refuses that combination. */
export const ROUTER = "0x00000000000000000000000000000000000000cc" as const;

export const ETH = 10n ** 18n;

/** The confirmation page: another port on the RP ID's host. `ORIGIN` is the control plane's. */
export const APPROVAL_ORIGIN = "http://localhost:8081";

export const CHAINS: ChainLabel[] = [{ chainId: CHAIN, name: "Local chain", nativeSymbol: "ETH" }];

export const ASSETS: AssetLabel[] = [{ chainId: CHAIN, asset: TOKEN, symbol: "TKN", decimals: 6 }];

/** What `createSigner` needs for confirmation pages, with the test origins and labels. */
export const CONFIRMATION_SETTINGS = {
  approvalOrigin: APPROVAL_ORIGIN,
  returnOrigin: ORIGIN,
  chains: CHAINS,
  assets: ASSETS,
};

/**
 * Write a signer process's confirmation files into `dir` and return the environment that names
 * them, with the test origins.
 */
export function confirmationEnvironment(dir: string, confirmSecret: Uint8Array = randomBytes(32)) {
  const files = {
    SIGNER_CONFIRM_SECRET_FILE: join(dir, "confirm-secret"),
    SIGNER_CHAINS_FILE: join(dir, "chains.json"),
    SIGNER_ASSETS_FILE: join(dir, "assets.json"),
  };

  writeFileSync(files.SIGNER_CONFIRM_SECRET_FILE, Buffer.from(confirmSecret).toString("base64"));
  writeFileSync(files.SIGNER_CHAINS_FILE, JSON.stringify(CHAINS));
  writeFileSync(files.SIGNER_ASSETS_FILE, JSON.stringify(ASSETS));

  return { ...files, SIGNER_APPROVAL_ORIGIN: APPROVAL_ORIGIN, SIGNER_RETURN_ORIGIN: ORIGIN };
}

/** A person with a passkey in a software authenticator. */
export interface Person {
  userId: UserId;
  authenticator: SoftAuthenticator;
  credential: ApproverCredential;
}

export function newPerson(): Person {
  const authenticator = new SoftAuthenticator({ incrementCounter: false });
  const { credential } = authenticator.register({ rpId: RP_ID, challenge: "registration" });
  const userId = newId("usr");

  return { userId, authenticator, credential: approverCredentialOf(userId, credential) };
}

export const newNonce = () => randomBytes(16).toString("base64url");

/** Each person's approval of `envelope`, made at `origin`: by default the confirmation page. */
export function authorize(
  envelope: Envelope,
  people: readonly Person[],
  origin: string = APPROVAL_ORIGIN,
): Authorization {
  return {
    envelope,
    assertions: people.map((person) =>
      assertEnvelope(person.authenticator, {
        userId: person.userId,
        credentialId: person.credential.credentialId,
        envelope,
        origin,
      }),
    ),
  };
}

/**
 * What `holder`'s browser sends after their passkey answered a possession step: by default on
 * the confirmation page, top-level. `overrides` change where and how the browser made it.
 */
export function answerPossession(
  holder: Person,
  options: Pick<GetPossessionResponse, "challenge">,
  overrides: Omit<
    Parameters<SoftAuthenticator["authenticate"]>[0],
    "credentialId" | "challenge"
  > = {},
): AssertionResponse {
  return AssertionResponse.parse(
    holder.authenticator.authenticate({
      credentialId: holder.credential.credentialId,
      challenge: options.challenge,
      origin: APPROVAL_ORIGIN,
      ...overrides,
    }),
  );
}

/**
 * As the person being added does on the confirmation page: open the confirmation of an approver
 * change and prove there, with `holder`'s passkey, that the key it carries is theirs. Returns the
 * link's token.
 */
export async function provePossession(
  t: Pick<TestSigner, "client" | "confirm">,
  envelope: AddApproverEnvelope,
  holder: Person,
): Promise<string> {
  const { path } = await t.client.openConfirmation(envelope.approvalId, {
    envelope,
    subject: { kind: "envelope-only" },
  });

  const token = path.slice(path.indexOf("#") + 1);
  const options = await t.confirm.getPossession(envelope.approvalId, token);
  await t.confirm.submitPossession(envelope.approvalId, token, answerPossession(holder, options));

  return token;
}

/** A mutable clock, in seconds, that tests advance explicitly. */
export class Clock {
  value = 1_800_000_000;
  now = () => this.value;
}

export interface TestSigner {
  signer: Signer;
  /** The control plane's client, with `secret`. */
  client: SignerClient;
  /** The `approve` service's client, with `confirmSecret`. */
  confirm: ConfirmClient;
  clock: Clock;
  secret: Uint8Array;
  confirmSecret: Uint8Array;
  vault: Vault;
  tokenKey: Uint8Array;
}

/** Pass `vault` and `tokenKey` from an earlier start to open the same wallets after a restart. */
export function startSigner(
  input: {
    sqlitePath?: string;
    vault?: Vault;
    clock?: Clock;
    tokenKey?: Uint8Array;
    maxLiveMandatesPerWallet?: number;
    maxTxAttempts?: number;
    repriceWindowSeconds?: number;
    minDestroyDelaySeconds?: number;
  } = {},
) {
  const clock = input.clock ?? new Clock();
  const secret = new Uint8Array(randomBytes(32));
  const confirmSecret = new Uint8Array(randomBytes(32));
  const vault = input.vault ?? createTestVault();
  const tokenKey = input.tokenKey ?? new Uint8Array(randomBytes(32));

  const options: SignerOptions = {
    sqlitePath: input.sqlitePath ?? ":memory:",
    vault,
    rpId: RP_ID,
    requestSecret: secret,
    confirmSecret,
    ...CONFIRMATION_SETTINGS,
    tokenKey,
    maxIntentTtlSeconds: 3600,
    maxAdminTtlSeconds: 86_400,
    now: clock.now,
  };

  if (input.maxLiveMandatesPerWallet !== undefined) {
    options.maxLiveMandatesPerWallet = input.maxLiveMandatesPerWallet;
  }

  if (input.maxTxAttempts !== undefined) options.maxTxAttempts = input.maxTxAttempts;

  if (input.repriceWindowSeconds !== undefined) {
    options.repriceWindowSeconds = input.repriceWindowSeconds;
  }

  if (input.minDestroyDelaySeconds !== undefined) {
    options.minDestroyDelaySeconds = input.minDestroyDelaySeconds;
  }

  const signer = createSigner(options);

  const fetch: typeof globalThis.fetch = (url, init) =>
    Promise.resolve(signer.app.request(String(url), init));

  const client = createSignerClient({
    baseUrl: "http://signer.test",
    secret,
    now: clock.now,
    fetch,
  });

  const confirm = createConfirmClient({
    baseUrl: "http://signer.test",
    secret: confirmSecret,
    now: clock.now,
    fetch,
  });

  return {
    signer,
    client,
    confirm,
    clock,
    secret,
    confirmSecret,
    vault,
    tokenKey,
  } satisfies TestSigner;
}

export function header(
  clock: Clock,
  approvalId: ApprovalId,
  workspaceId: WorkspaceId,
  ttlSeconds = 300,
) {
  return {
    v: 1 as const,
    approvalId,
    workspaceId,
    nonce: newNonce(),
    issuedAt: clock.value,
    expiresAt: clock.value + ttlSeconds,
  };
}

export function basePolicy(input: {
  workspaceId: WorkspaceId;
  walletId: WalletId;
  agentId: AgentId;
  threshold?: number;
}): WalletPolicy {
  return {
    v: 1,
    workspaceId: input.workspaceId,
    walletId: input.walletId,
    revision: 1,
    previousHash: null,
    chains: [CHAIN],
    requesters: [input.agentId],
    // Sorted by `chainId|asset`: hex addresses sort before "native".
    assets: [
      { chainId: CHAIN, asset: TOKEN, maxPerTx: "1000000", maxPerDay: "5000000" },
      {
        chainId: CHAIN,
        asset: "native",
        maxPerTx: String(ETH),
        maxPerDay: String((ETH * 3n) / 2n),
      },
    ],
    recipients: { mode: "any" },
    contractCalls: { mode: "allowlist", targets: [ROUTER] },
    fees: { maxPerTxWei: String(10n ** 16n) },
    approvals: { threshold: input.threshold ?? 1, ttlSeconds: 600 },
  };
}

/** A workspace with one wallet whose first policy is in force. */
export interface World {
  /** Only the client and the clock: worlds also run against a separate process or container. */
  t: Pick<TestSigner, "client" | "clock">;
  workspaceId: WorkspaceId;
  walletId: WalletId;
  agentId: AgentId;
  people: Person[];
  address: Address;
  policy: WalletPolicy;
}

function isEip1559(serialized: string): serialized is `0x02${string}` {
  return serialized.startsWith("0x02");
}

/** A signed transaction the signer serialised, which is EIP-1559 (type 2); throws on any other. */
export function eip1559Serialized(serialized: string): `0x02${string}` {
  if (!isEip1559(serialized)) {
    throw new Error(`not an EIP-1559 transaction: ${serialized.slice(0, 4)}`);
  }

  return serialized;
}

/** The world's person at `index`, of the `people` that `setUpWorld` made. */
export function personAt(world: Pick<World, "people">, index: number): Person {
  const person = world.people[index];

  if (person === undefined) throw new Error(`the world has no person at ${index}`);

  return person;
}

export async function setUpWorld(
  t: Pick<TestSigner, "client" | "clock">,
  options: { people?: number; adminThreshold?: number; policyThreshold?: number } = {},
): Promise<World> {
  const people = Array.from({ length: options.people ?? 1 }, newPerson);
  const workspaceId = newId("ws");
  const walletId = newId("wal");
  const agentId = newId("agt");
  // A wallet threshold may not exceed the admin threshold, so default the one to the other.
  const adminThreshold = options.adminThreshold ?? options.policyThreshold ?? 1;
  await t.client.createWorkspace({
    workspaceId,
    adminThreshold,
    approvers: people.map((person) => person.credential),
  });

  const wallet = await t.client.createWallet({
    workspaceId,
    walletId,
    kind: "agent",
    label: "agent wallet",
  });

  const policy = basePolicy({
    workspaceId,
    walletId,
    agentId,
    threshold: options.policyThreshold ?? 1,
  });

  await t.client.setPolicy(walletId, {
    policy,
    authorization: authorize(
      {
        ...header(t.clock, newId("apr"), workspaceId),
        type: "set-policy",
        walletId,
        policyHash: policyHash(policy),
        previousPolicyHash: null,
      },
      people.slice(0, adminThreshold),
    ),
  });

  return { t, workspaceId, walletId, agentId, people, address: wallet.address, policy };
}

export function intentFor(
  world: World,
  operation?: Operation,
  memo = "pay the invoice",
): EvmIntent {
  return {
    v: 1,
    id: newId("int"),
    workspaceId: world.workspaceId,
    agentId: world.agentId,
    walletId: world.walletId,
    chainId: CHAIN,
    operation: operation ?? { type: "evm.transfer", to: RECIPIENT, valueWei: String(ETH) },
    maxFeeWei: String(10n ** 15n),
    memo,
    createdAt: world.t.clock.value,
  };
}

export function approveIntent(
  world: World,
  intent: Intent,
  options: { people?: Person[]; ttlSeconds?: number; policyHash?: string } = {},
): Authorization {
  const envelope: Envelope = {
    ...header(world.t.clock, newId("apr"), world.workspaceId, options.ttlSeconds),
    type: "approve-intent",
    intentHash: intentHash(intent),
    walletId: intent.walletId,
    agentId: intent.agentId,
    chainId: intent.chainId,
    policyHash: options.policyHash ?? policyHash(world.policy),
  };

  return authorize(envelope, options.people ?? world.people.slice(0, 1));
}

/** Approve and apply the next revision of the wallet's policy with every person's passkey. */
export async function replacePolicy(
  world: World,
  changes: Partial<WalletPolicy>,
): Promise<WalletPolicy> {
  const policy: WalletPolicy = {
    ...world.policy,
    ...changes,
    revision: world.policy.revision + 1,
    previousHash: policyHash(world.policy),
  };

  await world.t.client.setPolicy(world.walletId, {
    policy,
    authorization: authorize(
      {
        ...header(world.t.clock, newId("apr"), world.workspaceId),
        type: "set-policy",
        walletId: world.walletId,
        policyHash: policyHash(policy),
        previousPolicyHash: policyHash(world.policy),
      },
      world.people,
    ),
  });

  return policy;
}

/**
 * A mandate for the world's agent and wallet: token transfers to `RECIPIENT`, 0.5 TKN a payment,
 * 1 TKN an hour, 1.5 TKN in total, for a day from now. Every cap is inside the base policy.
 */
export function mandateFor(world: World, changes: Partial<Mandate> = {}): Mandate {
  return {
    v: 1,
    id: newId("mnd"),
    workspaceId: world.workspaceId,
    walletId: world.walletId,
    agentId: world.agentId,
    assets: [
      {
        chainId: CHAIN,
        asset: TOKEN,
        maxPerAction: "500000",
        maxPerWindow: "1000000",
        maxTotal: "1500000",
      },
    ],
    windowSeconds: 3600,
    recipients: [RECIPIENT],
    maxUses: 10,
    maxFeePerActionWei: String(10n ** 15n),
    notBefore: world.t.clock.value,
    notAfter: world.t.clock.value + 86_400,
    purpose: "pay the supplier",
    ...changes,
  };
}

/** The `grant-mandate` request for `mandate`, approved by `people` (by default the first one). */
export function grantRequest(
  world: World,
  mandate: Mandate,
  people: readonly Person[] = world.people.slice(0, 1),
): GrantMandateRequest {
  return {
    mandate,
    authorization: authorize(
      {
        ...header(world.t.clock, newId("apr"), world.workspaceId),
        type: "grant-mandate",
        mandateId: mandate.id,
        walletId: mandate.walletId,
        agentId: mandate.agentId,
        mandateHash: mandateHash(mandate),
      },
      people,
    ),
  };
}

/** Grant a mandate for the world's agent, approved by `people` (by default the first one). */
export async function grantMandate(
  world: World,
  changes: Partial<Mandate> = {},
  people?: readonly Person[],
): Promise<{ mandate: Mandate; state: MandateState }> {
  const mandate = mandateFor(world, changes);
  const state = await world.t.client.grantMandate(mandate.id, grantRequest(world, mandate, people));

  return { mandate, state };
}

/** A token transfer of `amount` base units to `to` by the world's agent. */
export function tokenIntent(world: World, amount: bigint, to: Address = RECIPIENT): EvmIntent {
  return intentFor(world, { type: "evm.erc20.transfer", token: TOKEN, to, amount: String(amount) });
}

/** One use of a mandate: a new use id for `intent`, at the next account nonce. */
export function useRequest(intent: EvmIntent): SignUnderMandateRequest {
  return { approvalId: newId("apr"), intent, transaction: txParams() };
}

let txNonce = 0;

export function txParams(overrides: Partial<TransactionParams> = {}): TransactionParams {
  txNonce += 1;

  return {
    nonce: txNonce,
    gas: "21000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000000",
    ...overrides,
  };
}

/**
 * Undo schema version 7 in a closed database file, to make it look as an older signer left it.
 * Version 7 adds columns, which cannot be added twice, so a test that winds a file back to an
 * earlier version removes them too.
 */
export const DROP_VERSION_7 = `
ALTER TABLE wallets DROP COLUMN state_before_delete;
ALTER TABLE wallets DROP COLUMN destroyed_at;
ALTER TABLE wallets DROP COLUMN destroy_after;
ALTER TABLE wallets DROP COLUMN state;
ALTER TABLE workspaces DROP COLUMN destroy_after;
ALTER TABLE workspaces DROP COLUMN state;
`;

/** Assert that a signer call is refused with exactly this code. */
export async function refused(call: Promise<unknown>, code: string, detail?: string) {
  const error = await call.then(
    () => null,
    (cause: unknown) => cause,
  );

  expect(error, `expected refusal ${code}`).toBeInstanceOf(SignerError);

  if (!(error instanceof SignerError)) throw new Error("not a SignerError");

  expect(error.code).toBe(code);

  if (detail !== undefined) expect(error.detail).toBe(detail);
}
