import {
  ApiError,
  ApiErrorBody,
  type MandateDraft,
  routes,
  type WorkspaceTemplate,
} from "@askgina/os-api";
import type { ApprovalId, UserId, WalletId, WorkspaceId } from "@askgina/os-protocol";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  auditEvents,
  intents,
  mandates,
  transactions,
  wallets,
  workspaces,
} from "../../src/db/schema.ts";
import { createFixture, draftFor, type Fixture } from "../execution/fixture.ts";
import { TEST_CHAIN_ID, type TestPerson } from "../support/context.ts";

const ETH = 10n ** 18n;
const VENDOR = "0x00000000000000000000000000000000000000cc";

let f: Fixture;
let bob: TestPerson;
let treasuryId: WalletId;

const api = () => f.t.owner.browser.api;

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

beforeAll(async () => {
  f = await createFixture("lifecycle_clone");
  const ws = f.workspaceId;
  bob = await f.addApprover(ws, "Bob Approver");
  await api().call("setNotificationDetail", {
    params: { workspaceId: ws },
    body: { detail: "summary" },
  });
  // A mandate: authority, which no clone may carry.
  const draft: MandateDraft = {
    agentId: f.agent.id,
    assets: [
      {
        chainId: TEST_CHAIN_ID as MandateDraft["assets"][number]["chainId"],
        asset: "native",
        maxPerAction: ETH.toString(),
        maxPerWindow: (2n * ETH).toString(),
        maxTotal: (3n * ETH).toString(),
      },
    ],
    windowSeconds: 86_400,
    recipients: [VENDOR],
    maxUses: 5,
    maxFeePerActionWei: "100000000000000000",
    notAfter: f.t.clock.now() + 3 * 86_400,
    purpose: "pay the vendor",
  };
  const grant = await api().call("proposeMandate", {
    params: { workspaceId: ws, walletId: f.agent.walletId },
    body: draft,
  });
  expect((await f.t.approve(grant.id as ApprovalId, [f.t.owner])).status).toBe("executed");
  // Two approvers now, and changes need both.
  const raise = await api().call("requestAdminThreshold", {
    params: { workspaceId: ws },
    body: { adminThreshold: 2 },
  });
  expect((await f.t.approve(raise.id as ApprovalId, [f.t.owner])).status).toBe("executed");
  const treasury = await api().call("createTreasury", {
    params: { workspaceId: ws },
    body: { label: "Treasury" },
  });
  treasuryId = treasury.id as WalletId;
  const policy = await api().call("requestPolicy", {
    params: { workspaceId: ws, walletId: treasuryId },
    body: {
      draft: draftFor(f.agent.id, {
        recipients: { mode: "allowlist", addresses: [VENDOR] },
        approvals: { threshold: 2, ttlSeconds: 3_600 },
      }),
    },
  });
  expect((await f.t.approve(policy.id as ApprovalId, [f.t.owner, bob])).status).toBe("executed");
}, 120_000);

afterAll(async () => {
  await f?.close();
});

async function sourceAddresses(): Promise<string[]> {
  const rows = await f.t.ctx.db
    .select({ address: wallets.address })
    .from(wallets)
    .where(eq(wallets.workspaceId, f.workspaceId));
  return rows.map((row) => row.address);
}

describe("origin check", () => {
  // The identity tests leave these to the lifecycle: they are not on that test app.
  const writes = [
    "requestDeleteWorkspace",
    "cancelDeleteWorkspace",
    "cloneWorkspace",
    "importTemplate",
    "requestRetireWallet",
    "cancelRetireWallet",
  ] as const;

  it.each(writes)("%s refuses a write without a same-site Origin", async (name) => {
    const route = routes[name];
    const path = route.path.replace(/:[A-Za-z]+/g, "x");
    const init = {
      method: route.method,
      headers: { "content-type": "application/json" },
      body: "{}",
    };
    const missing = await f.t.owner.browser.fetch(path, { ...init, origin: null });
    const foreign = await f.t.owner.browser.fetch(path, {
      ...init,
      origin: "https://evil.example",
    });
    for (const response of [missing, foreign]) {
      expect(response.status).toBe(403);
      expect(ApiErrorBody.parse(await response.json()).error.code).toBe("forbidden");
    }
  });
});

describe("a workspace template", () => {
  it("carries configuration, the notification content level and no mandate, key, address or token", async () => {
    const template = await api().call("exportTemplate", {
      params: { workspaceId: f.workspaceId },
    });
    expect(template).toMatchObject({
      format: "askgina.os/workspace-template/v1",
      name: "Execution tests",
      adminThreshold: 2,
      notificationDetail: "summary",
      wallets: [
        {
          ref: "w1",
          kind: "agent",
          label: "Trader",
          agent: { name: "Trader" },
          policy: { requesters: ["w1"], recipients: { mode: "any" } },
        },
        {
          ref: "w2",
          kind: "treasury",
          label: "Treasury",
          agent: null,
          policy: {
            requesters: ["w1"],
            recipients: { mode: "allowlist", addresses: [VENDOR] },
            approvals: { threshold: 2 },
          },
        },
      ],
    });
    expect(template.members).toEqual(
      expect.arrayContaining([
        { userId: f.t.owner.userId, role: "owner" },
        { userId: bob.userId, role: "approver" },
      ]),
    );
    const text = JSON.stringify(template);
    for (const address of await sourceAddresses()) expect(text).not.toContain(address);
    expect(text).not.toContain("mnd_");
    expect(text).not.toContain("osa_");
    expect(text).not.toContain(f.agent.id);
    expect(text).not.toContain(f.workspaceId);
  });

  it("is for owners only", async () => {
    expect(
      await refusal(
        bob.browser.api.call("exportTemplate", { params: { workspaceId: f.workspaceId } }),
      ),
    ).toEqual({ code: "forbidden" });
  });
});

describe("cloning a workspace", () => {
  it("makes new wallets and agents, proposes the policies, and carries nothing of the source's history or authority", async () => {
    const clone = await api().call("cloneWorkspace", {
      params: { workspaceId: f.workspaceId },
      body: { name: "Execution tests, again", includeAgents: true, includeMembers: true },
    });
    const ws = clone.workspace.id as WorkspaceId;
    expect(ws).not.toBe(f.workspaceId);
    expect(clone.workspace).toMatchObject({
      name: "Execution tests, again",
      role: "owner",
      paused: false,
      adminThreshold: 1,
      notificationDetail: "summary",
    });
    expect(clone.templateAdminThreshold).toBe(2);
    // The person cloning is the only member until the invites are used.
    expect(clone.workspace.members.map((member) => member.user.id)).toEqual([f.t.owner.userId]);
    expect(clone.invites).toEqual([
      expect.objectContaining({
        userId: bob.userId,
        displayName: "Bob Approver",
        role: "approver",
      }),
    ]);
    expect(clone.invites[0]?.url).toContain("/join/");

    // New keys: no address of the source, a new agent with its own token.
    expect(clone.workspace.wallets).toHaveLength(2);
    const old = await sourceAddresses();
    for (const wallet of clone.workspace.wallets) {
      expect(old).not.toContain(wallet.address);
      expect(wallet.policy).toBeNull();
    }
    expect(clone.agents).toHaveLength(1);
    const [agent] = clone.agents;
    if (!agent) throw new Error("no agent");
    expect(agent.agentId).not.toBe(f.agent.id);
    expect(agent.token.startsWith("osa_")).toBe(true);
    expect(agent.token).not.toBe(f.agent.token);

    // The signer holds no policy and no mandate for them until people approve.
    for (const wallet of clone.workspace.wallets) {
      const state = await f.t.ctx.signer.getWallet(wallet.id as WalletId);
      expect(state.policy).toBeNull();
      expect((await f.t.ctx.signer.listMandates(wallet.id as WalletId)).mandates).toEqual([]);
    }

    // Nothing of the source's history: only the policy proposals and the clone's own events.
    expect(clone.approvals).toHaveLength(2);
    const requests = await f.t.ctx.db.select().from(approvals).where(eq(approvals.workspaceId, ws));
    expect(requests.map((row) => [row.kind, row.status])).toEqual([
      ["set-policy", "pending"],
      ["set-policy", "pending"],
    ]);
    expect(await f.t.ctx.db.select().from(intents).where(eq(intents.workspaceId, ws))).toEqual([]);
    expect(await f.t.ctx.db.select().from(mandates).where(eq(mandates.workspaceId, ws))).toEqual(
      [],
    );
    const sent = await f.t.ctx.db
      .select({ hash: transactions.hash })
      .from(transactions)
      .innerJoin(wallets, eq(wallets.id, transactions.walletId))
      .where(eq(wallets.workspaceId, ws));
    expect(sent).toEqual([]);
    const events = await f.t.ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, ws))
      .orderBy(asc(auditEvents.seq));
    expect(events.slice(0, 2).map((event) => event.action)).toEqual([
      "workspace.created",
      "workspace.cloned",
    ]);
    expect(new Set(events.map((event) => event.action))).toEqual(
      new Set([
        "workspace.created",
        "workspace.cloned",
        "agent.created",
        "treasury.created",
        "approval.opened",
        "invite.created",
      ]),
    );
    const [cloned] = await api()
      .call("listAudit", { params: { workspaceId: ws } })
      .then((page) => page.items.filter((event) => event.action === "workspace.cloned"));
    expect(cloned?.detail).toMatchObject({ source: { workspaceId: f.workspaceId } });

    // Once people approve, the policies apply as the template had them, pointing at the clone's
    // agent, with the threshold lowered to what one approver can meet.
    for (const approval of clone.approvals) {
      const row = await f.t.approve(approval.id as ApprovalId, [f.t.owner]);
      expect(row.status).toBe("executed");
    }
    const byKind = new Map(clone.workspace.wallets.map((wallet) => [wallet.kind, wallet.id]));
    const treasury = await f.t.ctx.signer.getWallet(byKind.get("treasury") as WalletId);
    expect(treasury.policy).toMatchObject({
      revision: 1,
      previousHash: null,
      workspaceId: ws,
      requesters: [agent.agentId],
      recipients: { mode: "allowlist", addresses: [VENDOR] },
      approvals: { threshold: 1 },
    });
    const agentWallet = await f.t.ctx.signer.getWallet(agent.walletId as WalletId);
    expect(agentWallet.policy).toMatchObject({ requesters: [agent.agentId] });
    expect((await f.t.ctx.signer.listMandates(agent.walletId as WalletId)).mandates).toEqual([]);
  });

  it("from a template file drops people this installation does not know and refuses an unknown chain before creating anything", async () => {
    const template: WorkspaceTemplate = await api().call("exportTemplate", {
      params: { workspaceId: f.workspaceId },
    });
    const stranger = "usr_01jd0000000000000000000042" as UserId;
    const countWorkspaces = async () => (await f.t.ctx.db.select().from(workspaces)).length;

    const before = await countWorkspaces();
    const [first, second] = template.wallets;
    if (!first?.policy || !second) throw new Error("template changed");
    expect(
      await refusal(
        api().call("importTemplate", {
          body: {
            template: {
              ...template,
              wallets: [{ ...first, policy: { ...first.policy, chains: ["eip155:1"] } }, second],
            },
            name: "Elsewhere",
            includeAgents: true,
            includeMembers: false,
          },
        }),
      ),
    ).toEqual({ code: "invalid_request" });
    expect(await countWorkspaces()).toBe(before);

    const imported = await bob.browser.api.call("importTemplate", {
      body: {
        template: {
          ...template,
          members: [...template.members, { userId: stranger, role: "owner" }],
        },
        name: "Imported",
        includeAgents: false,
        includeMembers: true,
      },
    });
    // Bob imported it: he is its owner, and the original owner is invited back; the stranger is not.
    expect(imported.workspace.members.map((member) => member.user.id)).toEqual([bob.userId]);
    expect(imported.invites.map((invite) => [invite.userId, invite.role])).toEqual([
      [f.t.owner.userId, "owner"],
    ]);
    // Without agents only the treasury is made, and its requesters, all agents, are dropped.
    expect(imported.agents).toEqual([]);
    expect(imported.workspace.wallets.map((wallet) => wallet.kind)).toEqual(["treasury"]);
    expect(imported.approvals).toHaveLength(1);
    const [cloned] = await bob.browser.api
      .call("listAudit", { params: { workspaceId: imported.workspace.id } })
      .then((page) => page.items.filter((event) => event.action === "workspace.cloned"));
    expect(cloned?.detail).toMatchObject({ source: { templateDigest: expect.any(String) } });
    const row = await f.t.approve(imported.approvals[0]?.id as ApprovalId, [bob]);
    expect(row.status).toBe("executed");
    const treasury = await f.t.ctx.signer.getWallet(imported.workspace.wallets[0]?.id as WalletId);
    expect(treasury.policy).toMatchObject({
      requesters: [],
      recipients: { mode: "allowlist", addresses: [VENDOR] },
    });
  });
});
