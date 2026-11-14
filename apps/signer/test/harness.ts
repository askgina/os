import { randomBytes } from "node:crypto";
import {
  type AgentId,
  type ApprovalId,
  type ApproverCredential,
  type Authorization,
  type Envelope,
  type Intent,
  intentHash,
  newId,
  type Operation,
  policyHash,
  type UserId,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import {
  createSignerClient,
  type SignerClient,
  SignerError,
  type TransactionParams,
} from "@askgina/os-protocol/signer";
import {
  approverCredentialOf,
  assertEnvelope,
  SoftAuthenticator,
} from "@askgina/os-protocol/testing";
import { expect } from "vitest";
import { createSigner, createTestVault, type Signer, type Vault } from "../src/index.ts";

export const RP = { id: "localhost", origins: ["http://localhost:5173"] } as const;
export const ORIGIN = RP.origins[0];
export const CHAIN = "eip155:31337" as const;
export const RECIPIENT = "0x00000000000000000000000000000000000000aa" as const;
export const TOKEN = "0x00000000000000000000000000000000000000bb" as const;
export const ETH = 10n ** 18n;

/** A person with a passkey in a software authenticator. */
export interface Person {
  userId: UserId;
  authenticator: SoftAuthenticator;
  credential: ApproverCredential;
}

export function newPerson(): Person {
  const authenticator = new SoftAuthenticator({ incrementCounter: false });
  const { credential } = authenticator.register({ rpId: RP.id, challenge: "registration" });
  const userId = newId("usr");
  return { userId, authenticator, credential: approverCredentialOf(userId, credential) };
}

export const newNonce = () => randomBytes(16).toString("base64url");

export function authorize(envelope: Envelope, people: readonly Person[]): Authorization {
  return {
    envelope,
    assertions: people.map((person) =>
      assertEnvelope(person.authenticator, {
        userId: person.userId,
        credentialId: person.credential.credentialId,
        envelope,
        origin: ORIGIN,
      }),
    ),
  };
}

/** A mutable clock, in seconds, that tests advance explicitly. */
export class Clock {
  value = 1_800_000_000;
  now = () => this.value;
}

export interface TestSigner {
  signer: Signer;
  client: SignerClient;
  clock: Clock;
  secret: Uint8Array;
  vault: Vault;
}

export function startSigner(input: { sqlitePath?: string; vault?: Vault; clock?: Clock } = {}) {
  const clock = input.clock ?? new Clock();
  const secret = new Uint8Array(randomBytes(32));
  const vault = input.vault ?? createTestVault();
  const signer = createSigner({
    sqlitePath: input.sqlitePath ?? ":memory:",
    vault,
    relyingParty: RP,
    requestSecret: secret,
    tokenKey: new Uint8Array(randomBytes(32)),
    maxIntentTtlSeconds: 3600,
    maxAdminTtlSeconds: 86_400,
    now: clock.now,
  });
  const client = createSignerClient({
    baseUrl: "http://signer.test",
    secret,
    now: clock.now,
    fetch: (url, init) => Promise.resolve(signer.app.request(String(url), init)),
  });
  return { signer, client, clock, secret, vault } satisfies TestSigner;
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
    contractCalls: { mode: "allowlist", targets: [TOKEN] },
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
  address: string;
  policy: WalletPolicy;
}

export async function setUpWorld(
  t: Pick<TestSigner, "client" | "clock">,
  options: { people?: number; adminThreshold?: number; policyThreshold?: number } = {},
): Promise<World> {
  const people = Array.from({ length: options.people ?? 1 }, newPerson);
  const workspaceId = newId("ws");
  const walletId = newId("wal");
  const agentId = newId("agt");
  const adminThreshold = options.adminThreshold ?? 1;
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

export function intentFor(world: World, operation?: Operation, memo = "pay the invoice"): Intent {
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

/** Assert that a signer call is refused with exactly this code. */
export async function refused(call: Promise<unknown>, code: string, detail?: string) {
  const error = await call.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error, `expected refusal ${code}`).toBeInstanceOf(SignerError);
  expect((error as SignerError).code).toBe(code);
  if (detail !== undefined) expect((error as SignerError).detail).toBe(detail);
}
