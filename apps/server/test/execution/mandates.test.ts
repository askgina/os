import { randomBytes } from "node:crypto";
import { ApiError, type MandateDraft } from "@askgina/os-api";
import type { ApprovalId, IntentId, MandateId } from "@askgina/os-protocol";
import type { SignResponse, SignUnderMandateRequest } from "@askgina/os-protocol/signer";
import { scanForMarkers } from "@askgina/os-testkit";
import type { Client } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { parseTransaction } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, intents, mandates, transactions } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { TEST_CHAIN_ID, type TestBrowser, type TestPerson } from "../support/context.ts";
import {
  anvil,
  createFixture,
  draftFor,
  type Fixture,
  fund,
  type TestAgent,
  toolJson,
} from "./fixture.ts";

let f: Fixture;

let bob: TestPerson;

let viewer: TestBrowser;

let stranger: TestPerson;

const ETH = 10n ** 18n;

const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;

async function joinAsViewer(name: string): Promise<TestBrowser> {
  const invite = await f.t.owner.browser.api.call("createInvite", {
    params: { workspaceId: f.workspaceId },
    body: { role: "viewer" },
  });

  const token = invite.url.split("/").at(-1) ?? "";
  const browser = f.t.browser();

  const start = await browser.api.call("startInviteRegistration", {
    params: { token },
    body: { displayName: name },
  });

  const passkey = f.t.register(start.options);
  await browser.api.call("finishInviteRegistration", {
    params: { token },
    body: { ceremonyId: start.ceremonyId, response: passkey.response as never },
  });

  return browser;
}

beforeAll(async () => {
  f = await createFixture("exec_mandates");
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
  viewer = await joinAsViewer("Vera Viewer");
  stranger = await f.addApprover(await f.newWorkspace("Elsewhere"), "Sam Stranger");
});

afterAll(async () => {
  await f?.close();
});

/** The code and detail of an API refusal. */
async function refusal(call: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) {
      return error.detail === undefined
        ? { code: error.code }
        : { code: error.code, detail: error.detail };
    }

    throw error;
  }

  throw new Error("the call was not refused");
}

/** An agent with its own funded wallet, the fixture's policy, and an MCP client. */
async function agentWith(name: string): Promise<{ agent: TestAgent; client: Client }> {
  const agent = await f.newAgent(name);
  await f.setPolicy(f.workspaceId, agent.walletId, draftFor(agent.id));
  await fund(agent.address, 50n * ETH);

  return { agent, client: await f.mcp(agent.token) };
}

function draftOf(agent: TestAgent, recipients: `0x${string}`[]): MandateDraft {
  return {
    agentId: agent.id,
    assets: [
      {
        chainId: TEST_CHAIN_ID as MandateDraft["assets"][number]["chainId"],
        asset: "native",
        maxPerAction: (1n * ETH).toString(),
        maxPerWindow: (2n * ETH).toString(),
        maxTotal: (3n * ETH).toString(),
      },
    ],
    windowSeconds: 86_400,
    recipients: [...recipients].sort(),
    maxUses: 5,
    maxFeePerActionWei: "100000000000000000",
    notAfter: f.t.clock.now() + 3 * 86_400,
    purpose: "pay the suppliers this week",
  };
}

/** An owner proposes the mandate, Bob approves it on the confirmation page, and it is granted. */
async function grant(
  agent: TestAgent,
  recipients: `0x${string}`[],
  overrides: Partial<MandateDraft> = {},
): Promise<MandateId> {
  const opened = await f.t.owner.browser.api.call("proposeMandate", {
    params: { workspaceId: f.workspaceId, walletId: agent.walletId },
    body: { ...draftOf(agent, recipients), ...overrides },
  });

  expect(opened).toMatchObject({ kind: "grant-mandate", status: "pending", threshold: 1 });
  const row = await f.t.approve(opened.id as ApprovalId, [bob]);
  expect(row.status).toBe("executed");

  return row.subjectId as MandateId;
}

async function propose(client: Client, args: Record<string, unknown>) {
  const answer = toolJson(await client.callTool({ name: "propose_transfer", arguments: args }));

  if (typeof answer.intentId !== "string") throw new Error(JSON.stringify(answer));

  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, answer.intentId as IntentId));

  if (!row?.approvalId) throw new Error("an intent without its approval or use");

  return { answer, row, approvalId: row.approvalId };
}

/** Do what the workflow does with an approved row: sign, or end it failed; then follow up. */
async function run(approvalId: ApprovalId) {
  const steps = engineOf(f.t.ctx).steps();
  const result = await steps.execute(approvalId);

  if (!result.ok) {
    await steps.fail(approvalId, result.code);

    return result;
  }

  for (let i = 0; i < 20; i += 1) {
    if ((await steps.followUp(approvalId)).done) return result;
  }

  throw new Error("follow-up never finished");
}

const getIntent = (intentId: string) =>
  f.t.owner.browser.api.call("getIntent", { params: { intentId } });

const getMandate = (mandateId: string) =>
  f.t.owner.browser.api.call("getMandate", {
    params: { workspaceId: f.workspaceId, mandateId },
  });

describe("granting a mandate", () => {
  it("is opened by an owner, approved on the confirmation page at the admin threshold, and active at the signer and in the mirror", async () => {
    const { agent } = await agentWith("Grantee");
    const recipient = randomAddress();
    const draft = draftOf(agent, [recipient]);

    // Only owners propose; a viewer neither proposes nor revokes; a non-member sees nothing.
    expect(
      await refusal(
        viewer.api.call("proposeMandate", {
          params: { workspaceId: f.workspaceId, walletId: agent.walletId },
          body: draft,
        }),
      ),
    ).toEqual({ code: "forbidden" });
    expect(
      await refusal(
        bob.browser.api.call("proposeMandate", {
          params: { workspaceId: f.workspaceId, walletId: agent.walletId },
          body: draft,
        }),
      ),
    ).toEqual({ code: "forbidden" });

    const mandateId = await grant(agent, [recipient]);
    const atSigner = await f.t.ctx.signer.getMandate(mandateId);
    expect(atSigner.status).toBe("active");
    expect(atSigner.grantedBy).toEqual([bob.userId]);
    expect(atSigner.mandate).toMatchObject({
      agentId: agent.id,
      walletId: agent.walletId,
      recipients: [recipient],
      notBefore: f.t.clock.now(),
    });
    const [mirror] = await f.t.ctx.db.select().from(mandates).where(eq(mandates.id, mandateId));
    expect(mirror).toMatchObject({
      status: "active",
      endedReason: null,
      agentId: agent.id,
      mandateHash: atSigner.mandateHash,
    });

    const shown = await getMandate(mandateId);
    expect(shown).toMatchObject({
      id: mandateId,
      status: "active",
      endedReason: null,
      agent: { id: agent.id, name: "Grantee" },
      grantedBy: [{ id: bob.userId, displayName: "Bob Approver" }],
      assets: [
        {
          asset: "native",
          symbol: "ETH",
          decimals: 18,
          worstCase: (3n * ETH).toString(),
          policy: { maxPerTx: (5n * ETH).toString(), maxPerDay: (10n * ETH).toString() },
        },
      ],
      usage: { uses: 0, usesLeft: 5 },
      intents: [],
      intentsCursor: null,
    });
    expect(
      (
        await viewer.api.call("listMandates", {
          params: { workspaceId: f.workspaceId },
          query: { agentId: agent.id },
        })
      ).items.map((item) => item.id),
    ).toEqual([mandateId]);
    expect(
      await refusal(
        stranger.browser.api.call("getMandate", {
          params: { workspaceId: f.workspaceId, mandateId },
        }),
      ),
    ).toEqual({ code: "not_found" });
    expect(
      await refusal(
        viewer.api.call("revokeMandate", {
          params: { workspaceId: f.workspaceId, mandateId },
          body: {},
        }),
      ),
    ).toEqual({ code: "forbidden" });
  });

  it("refuses a draft the wallet's policy or the longest life would refuse, with the reason", async () => {
    const { agent } = await agentWith("Overreach");
    const draft = draftOf(agent, [randomAddress()]);

    const call = (body: MandateDraft) =>
      f.t.owner.browser.api.call("proposeMandate", {
        params: { workspaceId: f.workspaceId, walletId: agent.walletId },
        body,
      });

    expect(await refusal(call({ ...draft, notAfter: f.t.clock.now() + 8 * 86_400 }))).toEqual({
      code: "invalid_request",
      detail: "lifetime_too_long",
    });
    expect(
      await refusal(
        call({
          ...draft,
          assets: [
            {
              ...(draft.assets[0] as MandateDraft["assets"][number]),
              maxPerAction: (6n * ETH).toString(),
              maxPerWindow: (6n * ETH).toString(),
              maxTotal: (6n * ETH).toString(),
            },
          ],
        }),
      ),
    ).toEqual({ code: "invalid_request", detail: "over_per_tx_cap" });
    // Another agent's wallet: this agent never proposes from it.
    expect(
      await refusal(
        f.t.owner.browser.api.call("proposeMandate", {
          params: { workspaceId: f.workspaceId, walletId: f.agent.walletId },
          body: draft,
        }),
      ),
    ).toEqual({ code: "invalid_request" });
  });
});

describe("a proposal a mandate covers", () => {
  it("is signed with no person, confirms on chain, reports its mandate, and is in no list of approvals", async () => {
    const { agent, client } = await agentWith("Covered");
    const recipient = randomAddress();
    const mandateId = await grant(agent, [recipient]);

    const pendingBefore = (
      await f.t.owner.browser.api.call("getWorkspace", { params: { workspaceId: f.workspaceId } })
    ).pendingApprovals;

    const { answer, row, approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.5",
      memo: "invoice 17",
    });

    expect(answer).toEqual({
      intentId: row.id,
      status: "approved",
      authorizedBy: "mandate",
      mandateId,
      approvalUrl: null,
      expiresAt: null,
    });
    expect(row).toMatchObject({ status: "approved", mandateId });
    const [use] = await f.t.ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(use).toMatchObject({
      kind: "mandate-use",
      status: "approved",
      envelope: null,
      mandateId,
      threshold: 0,
      subjectId: row.id,
    });

    expect(await run(approvalId)).toEqual({ ok: true });
    expect(await anvil.getBalance({ address: recipient })).toBe(5n * 10n ** 17n);
    const detail = await getIntent(row.id);
    expect(detail).toMatchObject({
      status: "confirmed",
      approvalId: null,
      mandateId,
      transaction: { status: "confirmed" },
    });

    // A use is no approval anyone sees: not listed, not counted, not readable, not decidable.
    const all = await f.t.owner.browser.api.call("listApprovals", {
      params: { workspaceId: f.workspaceId },
      query: { status: "all" },
    });

    expect(all.items.map((item) => item.id)).not.toContain(approvalId);
    expect(all.items.map((item) => item.kind)).not.toContain("mandate-use");
    expect(
      (
        await f.t.owner.browser.api.call("getWorkspace", {
          params: { workspaceId: f.workspaceId },
        })
      ).pendingApprovals,
    ).toBe(pendingBefore);

    // Each call starts only when it is awaited: a refusal nobody is listening to yet is an
    // unhandled rejection.
    for (const call of [
      () => f.t.owner.browser.api.call("getApproval", { params: { approvalId } }),
      () => f.t.owner.browser.api.call("collectApproval", { params: { approvalId }, body: {} }),
      () => f.t.owner.browser.api.call("reject", { params: { approvalId }, body: {} }),
    ]) {
      expect(await refusal(call())).toEqual({ code: "not_found" });
    }

    const shown = await getMandate(mandateId);
    expect(shown.usage).toMatchObject({ uses: 1, usesLeft: 4 });
    expect(shown.usage?.assets[0]).toMatchObject({
      usedTotal: (5n * 10n ** 17n).toString(),
      usedInWindow: (5n * 10n ** 17n).toString(),
    });
    expect(shown.intents.map((intent) => intent.id)).toEqual([row.id]);

    const underIt = await f.t.owner.browser.api.call("listIntents", {
      params: { workspaceId: f.workspaceId },
      query: { mandateId },
    });

    expect(underIt.items.map((intent) => intent.id)).toEqual([row.id]);

    // The agent sees the same over MCP.
    const read = toolJson(
      await client.callTool({ name: "get_intent", arguments: { intentId: row.id } }),
    );

    expect(read).toMatchObject({ status: "confirmed", authorizedBy: "mandate", mandateId });
    const listed = toolJson(await client.callTool({ name: "list_intents", arguments: {} }));
    expect(listed.intents).toEqual([
      expect.objectContaining({ intentId: row.id, authorizedBy: "mandate", mandateId }),
    ]);
    const me = toolJson(await client.callTool({ name: "whoami", arguments: {} }));
    expect(me.mandates).toEqual([
      {
        mandateId,
        walletId: agent.walletId,
        purpose: "pay the suppliers this week",
        recipients: [recipient],
        windowSeconds: 86_400,
        assets: [
          {
            chainId: TEST_CHAIN_ID,
            asset: "native",
            maxPerAction: (1n * ETH).toString(),
            maxPerWindow: (2n * ETH).toString(),
            maxTotal: (3n * ETH).toString(),
            usedInWindow: (5n * 10n ** 17n).toString(),
            usedTotal: (5n * 10n ** 17n).toString(),
          },
        ],
        maxFeePerActionWei: "100000000000000000",
        usesLeft: 4,
        notAfter: f.t.clock.now() + 3 * 86_400,
      },
    ]);
  });

  it("goes to the inbox as before when no mandate covers it", async () => {
    const { agent, client } = await agentWith("Uncovered");
    const listed = randomAddress();
    await grant(agent, [listed]);

    for (const args of [
      { to: randomAddress(), amount: "0.1" },
      { to: listed, amount: "1.5" },
    ]) {
      const { answer, row } = await propose(client, {
        chainId: TEST_CHAIN_ID,
        memo: "not covered",
        ...args,
      });

      expect(answer).toMatchObject({
        status: "pending_approval",
        authorizedBy: "person",
        mandateId: null,
      });
      expect(answer.approvalUrl).toEqual(expect.stringContaining(`/approvals/${row.approvalId}`));
      expect(row.mandateId).toBeNull();

      const [request] = await f.t.ctx.db
        .select({ kind: approvals.kind })
        .from(approvals)
        .where(eq(approvals.id, row.approvalId as ApprovalId));

      expect(request?.kind).toBe("approve-intent");
    }
  });

  it("uses the covering mandate that ends first, then the lowest id", async () => {
    const { agent, client } = await agentWith("Chooser");
    const recipient = randomAddress();
    const now = f.t.clock.now();
    const later = await grant(agent, [recipient], { notAfter: now + 3 * 86_400 });
    const first = await grant(agent, [recipient], { notAfter: now + 2 * 86_400 });
    const tieA = await grant(agent, [recipient], { notAfter: now + 86_400 });
    const tieB = await grant(agent, [recipient], { notAfter: now + 86_400 });
    const [lowest] = [tieA, tieB].sort();

    const pick = async () =>
      (await propose(client, { chainId: TEST_CHAIN_ID, to: recipient, amount: "0.01", memo: "x" }))
        .answer.mandateId;

    expect(await pick()).toBe(lowest);

    // Once both tied mandates are revoked, the one ending next is used, then the last one.
    for (const mandateId of [tieA, tieB]) {
      await f.t.owner.browser.api.call("revokeMandate", {
        params: { workspaceId: f.workspaceId, mandateId },
        body: {},
      });
    }

    expect(await pick()).toBe(first);
    await f.t.owner.browser.api.call("revokeMandate", {
      params: { workspaceId: f.workspaceId, mandateId: first },
      body: {},
    });
    expect(await pick()).toBe(later);
  });

  it("with a named mandate that does not cover it, is refused with the reason and records nothing", async () => {
    const { agent, client } = await agentWith("Pinned");
    const recipient = randomAddress();
    const mandateId = await grant(agent, [recipient]);
    const before = await f.t.ctx.db.select().from(intents).where(eq(intents.agentId, agent.id));

    const refused = toolJson(
      await client.callTool({
        name: "propose_transfer",
        arguments: {
          chainId: TEST_CHAIN_ID,
          to: randomAddress(),
          amount: "0.1",
          memo: "pinned elsewhere",
          mandateId,
        },
      }),
    );

    expect(refused).toMatchObject({
      error: "policy_denied",
      detail: "mandate_recipient_not_allowed",
    });

    const over = toolJson(
      await client.callTool({
        name: "propose_transfer",
        arguments: {
          chainId: TEST_CHAIN_ID,
          to: recipient,
          amount: "1.5",
          memo: "too much",
          mandateId,
        },
      }),
    );

    expect(over).toMatchObject({ error: "policy_denied", detail: "mandate_over_per_action_cap" });
    // Another agent's mandate is not this agent's to name.
    const { agent: other } = await agentWith("Pinned elsewhere");
    const theirs = await grant(other, [recipient]);

    const foreign = toolJson(
      await client.callTool({
        name: "propose_transfer",
        arguments: {
          chainId: TEST_CHAIN_ID,
          to: recipient,
          amount: "0.1",
          memo: "x",
          mandateId: theirs,
        },
      }),
    );

    expect(foreign).toMatchObject({ error: "not_found" });
    expect(
      await f.t.ctx.db.select().from(intents).where(eq(intents.agentId, agent.id)),
    ).toHaveLength(before.length);

    const pinned = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.1",
      memo: "pinned here",
      mandateId,
    });

    expect(pinned.answer).toMatchObject({ authorizedBy: "mandate", mandateId });
  });

  it("racing for the last of a window: the signer signs one, the other ends denied with its counter code, and the next waits for a person", async () => {
    const { agent, client } = await agentWith("Racer");
    const recipient = randomAddress();

    const mandateId = await grant(agent, [recipient], {
      assets: [
        {
          chainId: TEST_CHAIN_ID as MandateDraft["assets"][number]["chainId"],
          asset: "native",
          maxPerAction: (1n * ETH).toString(),
          maxPerWindow: (1n * ETH).toString(),
          maxTotal: (2n * ETH).toString(),
        },
      ],
    });

    // Both pass the early check: nothing is used yet.
    const one = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.6",
      memo: "a",
    });

    const two = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.6",
      memo: "b",
    });

    expect([one.answer.mandateId, two.answer.mandateId]).toEqual([mandateId, mandateId]);

    const results = await Promise.all([run(one.approvalId), run(two.approvalId)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "mandate_over_window_cap" },
    ]);
    const statuses = await Promise.all([getIntent(one.row.id), getIntent(two.row.id)]);
    expect(statuses.map((intent) => intent.status).sort()).toEqual(["confirmed", "denied"]);
    expect(statuses.find((intent) => intent.status === "denied")?.failureCode).toBe(
      "mandate_over_window_cap",
    );
    expect(
      await f.t.ctx.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.walletId, agent.walletId))),
    ).toHaveLength(1);

    const next = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.6",
      memo: "c",
    });

    expect(next.answer).toMatchObject({ authorizedBy: "person", status: "pending_approval" });
  });

  it("proposals sent at the same moment are all answered", async () => {
    const { agent, client } = await agentWith("Twins");
    const recipient = randomAddress();
    const mandateId = await grant(agent, [recipient]);
    // Each records an approval, an intent and audit entries in one transaction; transactions of
    // one workspace that wait on each other's row locks must queue, not deadlock.
    const memos = ["a", "b", "c", "d", "e", "f", "g", "h"];

    const all = await Promise.all(
      memos.map((memo) =>
        propose(client, { chainId: TEST_CHAIN_ID, to: recipient, amount: "0.01", memo }),
      ),
    );

    expect(all.map((one) => one.answer.mandateId)).toEqual(memos.map(() => mandateId));
  });

  it("signs once when the process dies between the signature and our row", async () => {
    const { agent, client } = await agentWith("Crash");
    const recipient = randomAddress();
    await grant(agent, [recipient]);
    const nonceBefore = await anvil.getTransactionCount({ address: agent.address });

    const { row, approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.25",
      memo: "crash",
    });

    const steps = engineOf(f.t.ctx).steps();
    const signer = f.t.ctx.signer;
    const realSign = signer.signUnderMandate.bind(signer);
    let signedFirst: SignResponse | undefined;
    Object.defineProperty(signer, "signUnderMandate", {
      configurable: true,
      writable: true,
      value: async (mandateId: MandateId, input: SignUnderMandateRequest) => {
        signedFirst = await realSign(mandateId, input);
        throw new Error("process died");
      },
    });

    try {
      await expect(steps.execute(approvalId)).rejects.toThrow("process died");
    } finally {
      Object.defineProperty(signer, "signUnderMandate", {
        configurable: true,
        writable: true,
        value: realSign,
      });
    }

    if (!signedFirst) throw new Error("the signer was never reached");
    expect(
      await f.t.ctx.db.select().from(transactions).where(eq(transactions.intentId, row.id)),
    ).toHaveLength(0);
    // The retried step gets the signer's replay of the first signature, counted once.
    expect(await run(approvalId)).toEqual({ ok: true });

    const stored = await f.t.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.intentId, row.id));

    expect(stored).toHaveLength(1);
    expect(stored[0]?.hash).toBe(signedFirst.transactionHash);
    expect(stored[0]?.nonce).toBe(
      parseTransaction(signedFirst.signedTransaction as `0x${string}`).nonce,
    );
    expect(await anvil.getTransactionCount({ address: agent.address })).toBe(nonceBefore + 1);
    expect((await getIntent(row.id)).status).toBe("confirmed");
    expect((await f.t.ctx.signer.getMandate(row.mandateId as MandateId)).usage.uses).toBe(1);
  });
});

describe("ending a mandate", () => {
  it("a person revokes it with no passkey, and the next proposal waits for a person", async () => {
    const { agent, client } = await agentWith("Revoked");
    const recipient = randomAddress();
    const mandateId = await grant(agent, [recipient]);

    const revoked = await bob.browser.api.call("revokeMandate", {
      params: { workspaceId: f.workspaceId, mandateId },
      body: {},
    });

    expect(revoked).toMatchObject({ status: "revoked", endedReason: "revoked" });
    expect(revoked.revokedAt).toBe(f.t.clock.now());
    expect(await f.t.ctx.signer.getMandate(mandateId)).toMatchObject({
      status: "revoked",
      revokedReason: "requested",
    });
    // Twice changes nothing.
    expect(
      await f.t.owner.browser.api.call("revokeMandate", {
        params: { workspaceId: f.workspaceId, mandateId },
        body: {},
      }),
    ).toMatchObject({ status: "revoked", endedReason: "revoked" });

    const { answer } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.1",
      memo: "after revocation",
    });

    expect(answer).toMatchObject({ authorizedBy: "person", status: "pending_approval" });

    const ended = await f.t.owner.browser.api.call("listMandates", {
      params: { workspaceId: f.workspaceId },
      query: { agentId: agent.id, status: "ended" },
    });

    expect(ended.items.map((item) => item.id)).toEqual([mandateId]);
  });

  it("disabling the agent revokes its mandates at the signer and cancels its waiting grants", async () => {
    const { agent } = await agentWith("Disabled");
    const mandateId = await grant(agent, [randomAddress()]);

    const waiting = await f.t.owner.browser.api.call("proposeMandate", {
      params: { workspaceId: f.workspaceId, walletId: agent.walletId },
      body: draftOf(agent, [randomAddress()]),
    });

    await f.t.owner.browser.api.call("disableAgent", {
      params: { workspaceId: f.workspaceId, agentId: agent.id },
      body: {},
    });
    expect(await f.t.ctx.signer.getMandate(mandateId)).toMatchObject({
      status: "revoked",
      revokedReason: "requested",
    });
    expect(await getMandate(mandateId)).toMatchObject({
      status: "revoked",
      endedReason: "agent_disabled",
    });

    const [grantRequest] = await f.t.ctx.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, waiting.id as ApprovalId));

    expect(grantRequest?.status).toBe("cancelled");
  });

  it("follows the signer when it ended the mandate itself", async () => {
    const { agent, client } = await agentWith("Operator");
    const recipient = randomAddress();
    const mandateId = await grant(agent, [recipient]);
    // The operator revokes it on the signer host; the control plane is not told.
    expect(f.t.signer.revokeMandateByOperator(mandateId)).toEqual([mandateId]);
    const [stale] = await f.t.ctx.db.select().from(mandates).where(eq(mandates.id, mandateId));
    expect(stale?.status).toBe("active");

    const me = toolJson(await client.callTool({ name: "whoami", arguments: {} }));
    expect(me.mandates).toEqual([]);
    const [mirror] = await f.t.ctx.db.select().from(mandates).where(eq(mandates.id, mandateId));
    expect(mirror).toMatchObject({ status: "ended", endedReason: "operator" });
    expect(await getMandate(mandateId)).toMatchObject({
      status: "revoked",
      endedReason: "operator",
    });

    const { answer } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.1",
      memo: "after the operator",
    });

    expect(answer).toMatchObject({ authorizedBy: "person" });
  });

  it("ends in the mirror once it expires", async () => {
    const { agent } = await agentWith("Expiring");

    const mandateId = await grant(agent, [randomAddress()], {
      notAfter: f.t.clock.now() + 3_600,
    });

    f.t.clock.advance(3_600);

    const live = await f.t.owner.browser.api.call("listMandates", {
      params: { workspaceId: f.workspaceId },
      query: { agentId: agent.id, status: "active" },
    });

    expect(live.items).toEqual([]);
    expect(await getMandate(mandateId)).toMatchObject({
      status: "expired",
      endedReason: "expired",
    });
  });
});

it("keeps a mandate's purpose out of every column and every log line", async () => {
  const { agent } = await agentWith("Sealed");
  const marker = `OSMANDATE${randomBytes(6).toString("hex")}`;
  const mandateId = await grant(agent, [randomAddress()], { purpose: `pay ${marker}` });
  expect((await getMandate(mandateId)).mandate.purpose).toBe(`pay ${marker}`);
  const scan = await scanForMarkers(f.t.ctx.config.databaseUrl, [marker]);
  expect(scan.hits).toEqual([]);
  expect(f.t.log.lines.join("\n")).not.toContain(marker);
});
