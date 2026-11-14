import { ApiError, type PolicyDraft } from "@askgina/os-api";
import type { ApprovalId, WorkspaceId } from "@askgina/os-protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, approvals } from "../../src/db/schema.ts";
import {
  createTestContext,
  TEST_CHAIN_ID,
  type TestContext,
  type TestPerson,
} from "../support/context.ts";

let t: TestContext;
let workspaceId: WorkspaceId;

beforeAll(async () => {
  t = await createTestContext({ label: "directory" });
  const created = await t.owner.browser.api.call("createWorkspace", { body: { name: "Ops" } });
  workspaceId = created.id;
});
afterAll(async () => {
  await t?.close();
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ApiError)) throw new Error("expected the API to refuse");
  return error.code;
}

/** A new person who joins `workspaceId` through an invite for `role`. */
async function join(role: "owner" | "approver" | "viewer", name: string): Promise<TestPerson> {
  const { url } = await t.owner.browser.api.call("createInvite", {
    params: { workspaceId },
    body: { role },
  });
  const token = url.split("/invite/")[1] ?? "";
  const browser = t.browser();
  const start = await browser.api.call("startInviteRegistration", {
    params: { token },
    body: { displayName: name },
  });
  const passkey = t.register(start.options);
  const session = await browser.api.call("finishInviteRegistration", {
    params: { token },
    body: { ceremonyId: start.ceremonyId, response: passkey.response as never },
  });
  if (!session.user) throw new Error("joining did not sign in");
  return {
    userId: session.user.id,
    displayName: name,
    credentialId: passkey.credentialId,
    browser,
  };
}

async function pendingFor(kind: string, subjectId: string): Promise<ApprovalId> {
  const rows = await t.ctx.db.select().from(approvals).where(eq(approvals.subjectId, subjectId));
  const row = rows.find((r) => r.kind === kind && r.status === "pending");
  if (!row) throw new Error(`no pending ${kind}`);
  return row.id;
}

const draft = (agentId: string): PolicyDraft => ({
  chains: [TEST_CHAIN_ID],
  requesters: [agentId as never],
  assets: [{ chainId: TEST_CHAIN_ID, asset: "native", maxPerTx: "1000", maxPerDay: "5000" }],
  recipients: { mode: "any" },
  contractCalls: { mode: "deny" },
  fees: { maxPerTxWei: "1000000000000000" },
  approvals: { threshold: 1, ttlSeconds: 600 },
});

describe("workspaces", () => {
  it("registers the workspace at the signer with the creator's passkey as its approver", async () => {
    const state = await t.ctx.signer.getWorkspace(workspaceId);
    expect(state.adminThreshold).toBe(1);
    expect(state.approvers.map((a) => a.credentialId)).toEqual([t.owner.credentialId]);
    const detail = await t.owner.browser.api.call("getWorkspace", { params: { workspaceId } });
    expect(detail.members).toMatchObject([{ role: "owner", approver: "active" }]);
  });

  it("answers not_found to someone who is not a member", async () => {
    const stranger = await join("viewer", "Stan");
    const other = await t.owner.browser.api.call("createWorkspace", { body: { name: "Private" } });
    expect(
      await refusal(
        stranger.browser.api.call("getWorkspace", { params: { workspaceId: other.id } }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(
        stranger.browser.api.call("listAudit", { params: { workspaceId: other.id }, query: {} }),
      ),
    ).toBe("not_found");
  });

  it("pauses at the signer at once, and resumes only once approved with a passkey", async () => {
    const api = t.owner.browser.api;
    expect((await api.call("pauseWorkspace", { params: { workspaceId }, body: {} })).paused).toBe(
      true,
    );
    expect((await t.ctx.signer.getWorkspace(workspaceId)).paused).toBe(true);
    const request = await api.call("requestResume", { params: { workspaceId }, body: {} });
    expect((await t.ctx.signer.getWorkspace(workspaceId)).paused).toBe(true);
    expect((await t.approve(request.id, [t.owner])).status).toBe("executed");
    expect((await t.ctx.signer.getWorkspace(workspaceId)).paused).toBe(false);
    expect((await api.call("getWorkspace", { params: { workspaceId } })).paused).toBe(false);
  });
});

describe("members", () => {
  let approver: TestPerson;

  it("a person joins by invite and approves only after an existing approver's passkey says so", async () => {
    approver = await join("approver", "Ada");
    const before = await t.owner.browser.api.call("getWorkspace", { params: { workspaceId } });
    expect(before.members.find((m) => m.user.id === approver.userId)?.approver).toBe("pending");
    expect((await t.ctx.signer.getWorkspace(workspaceId)).approvers).toHaveLength(1);

    const approvalId = await pendingFor("add-approver", approver.credentialId);
    // The newcomer's own passkey is not an approver yet, so it cannot let itself in.
    await expect(t.approve(approvalId, [approver])).rejects.toThrow();
    expect((await t.approve(approvalId, [t.owner])).status).toBe("executed");

    const after = await t.owner.browser.api.call("getWorkspace", { params: { workspaceId } });
    expect(after.members.find((m) => m.user.id === approver.userId)?.approver).toBe("active");
    const signerApprovers = (await t.ctx.signer.getWorkspace(workspaceId)).approvers;
    expect(signerApprovers.map((a) => a.credentialId)).toContain(approver.credentialId);
  });

  it("an invite link works once", async () => {
    const { url } = await t.owner.browser.api.call("createInvite", {
      params: { workspaceId },
      body: { role: "viewer" },
    });
    const token = url.split("/invite/")[1] ?? "";
    const someone = await t.signIn(approver.credentialId);
    const first = t.browser();
    const start = await first.api.call("startInviteRegistration", {
      params: { token },
      body: { displayName: "Vic" },
    });
    const passkey = t.register(start.options);
    await first.api.call("finishInviteRegistration", {
      params: { token },
      body: { ceremonyId: start.ceremonyId, response: passkey.response as never },
    });
    expect(await refusal(someone.api.call("acceptInvite", { params: { token }, body: {} }))).toBe(
      "not_found",
    );
    expect(await refusal(t.browser().api.call("getInvite", { params: { token } }))).toBe(
      "not_found",
    );
  });

  it("invites expire after seven days", async () => {
    const { url } = await t.owner.browser.api.call("createInvite", {
      params: { workspaceId },
      body: { role: "viewer" },
    });
    const token = url.split("/invite/")[1] ?? "";
    expect((await t.browser().api.call("getInvite", { params: { token } })).role).toBe("viewer");
    t.clock.advance(7 * 24 * 3600 + 1);
    expect(await refusal(t.browser().api.call("getInvite", { params: { token } }))).toBe(
      "not_found",
    );
    // Sessions live 12 hours by default; sign the owner in again on the new day.
    await t.signIn(t.owner.credentialId, t.owner.browser);
  });

  it("a viewer cannot manage members or open a policy request", async () => {
    const viewer = await join("viewer", "Val");
    const detail = await viewer.browser.api.call("getWorkspace", { params: { workspaceId } });
    const wallet = detail.wallets[0];
    expect(
      await refusal(
        viewer.browser.api.call("createInvite", {
          params: { workspaceId },
          body: { role: "owner" },
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        viewer.browser.api.call("requestPolicy", {
          params: { workspaceId, walletId: wallet?.id ?? "wal_00000000000000000000000000" },
          body: { draft: draft("agt_00000000000000000000000000") },
        }),
      ),
    ).toBe("forbidden");
  });

  it("demoting to viewer takes effect only after the signer removes the passkey", async () => {
    const api = t.owner.browser.api;
    const changed = await api.call("setMemberRole", {
      params: { workspaceId, userId: approver.userId },
      body: { role: "viewer" },
    });
    expect(changed.member.role).toBe("approver");
    expect(changed.approvals).toHaveLength(1);
    const removal = changed.approvals[0]?.id as ApprovalId;
    expect((await t.approve(removal, [t.owner])).status).toBe("executed");
    const after = await api.call("getWorkspace", { params: { workspaceId } });
    expect(after.members.find((m) => m.user.id === approver.userId)).toMatchObject({
      role: "viewer",
      approver: "none",
    });
    const signerApprovers = (await t.ctx.signer.getWorkspace(workspaceId)).approvers;
    expect(signerApprovers.map((a) => a.credentialId)).not.toContain(approver.credentialId);
  });

  it("the last owner can be neither demoted nor removed", async () => {
    const params = { workspaceId, userId: t.owner.userId };
    expect(
      await refusal(
        t.owner.browser.api.call("setMemberRole", { params, body: { role: "viewer" } }),
      ),
    ).toBe("conflict");
    expect(await refusal(t.owner.browser.api.call("removeMember", { params }))).toBe("conflict");
  });

  it("removing a viewer ends the membership at once", async () => {
    const viewer = await join("viewer", "Wes");
    const result = await t.owner.browser.api.call("removeMember", {
      params: { workspaceId, userId: viewer.userId },
    });
    expect(result.approvals).toEqual([]);
    expect(
      await refusal(viewer.browser.api.call("getWorkspace", { params: { workspaceId } })),
    ).toBe("not_found");
  });
});

describe("agents and wallets", () => {
  let agentId: string;
  let walletId: string;
  let token: string;

  it("creates the agent with its own wallet at the signer and a token shown once", async () => {
    const created = await t.owner.browser.api.call("createAgent", {
      params: { workspaceId },
      body: { name: "Payer" },
    });
    agentId = created.agent.id;
    walletId = created.wallet.id;
    token = created.token;
    expect(token).toMatch(new RegExp(`^osa_${agentId.slice(4)}_[A-Za-z0-9_-]{43}$`));
    expect(created.mcpUrl).toBe(`${t.ctx.config.publicOrigin}/mcp`);
    const atSigner = await t.ctx.signer.getWallet(created.wallet.id);
    expect(atSigner.address.toLowerCase()).toBe(created.wallet.address);
    expect(atSigner.policy).toBeNull();
  });

  it("never stores or logs the token in clear", async () => {
    const [row] = await t.ctx.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId as never));
    expect(JSON.stringify(row)).not.toContain(token.slice(31));
    expect(t.log.lines.join("\n")).not.toContain(token.slice(31));
    const secret = token.slice(token.lastIndexOf("_") + 1);
    const dump = await t.ctx.pool.query("SELECT * FROM os.agents");
    expect(JSON.stringify(dump.rows)).not.toContain(secret);
  });

  it("rotating replaces the token", async () => {
    const rotated = await t.owner.browser.api.call("rotateAgentToken", {
      params: { workspaceId, agentId },
      body: {},
    });
    expect(rotated.token).not.toBe(token);
    const [row] = await t.ctx.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId as never));
    expect(row?.tokenPrefix).toBe(rotated.token.slice(0, 35));
  });

  it("a policy takes effect at the signer only after approval, and a newer draft replaces a pending one", async () => {
    const api = t.owner.browser.api;
    const first = await api.call("requestPolicy", {
      params: { workspaceId, walletId },
      body: { draft: draft(agentId) },
    });
    const second = await api.call("requestPolicy", {
      params: { workspaceId, walletId },
      body: { draft: { ...draft(agentId), fees: { maxPerTxWei: "2000" } } },
    });
    const [firstRow] = await t.ctx.db.select().from(approvals).where(eq(approvals.id, first.id));
    expect(firstRow?.status).toBe("cancelled");
    expect((await t.ctx.signer.getWallet(walletId as never)).policy).toBeNull();

    expect((await t.approve(second.id, [t.owner])).status).toBe("executed");
    const atSigner = await t.ctx.signer.getWallet(walletId as never);
    expect(atSigner.policy?.fees.maxPerTxWei).toBe("2000");
    expect(atSigner.policy?.revision).toBe(1);
    const wallet = await api.call("getWallet", { params: { workspaceId, walletId } });
    expect(wallet.policyHash).toBe(atSigner.policyHash);
    expect(wallet.balances).toMatchObject([{ chainId: TEST_CHAIN_ID, asset: "native" }]);
    expect(wallet.pendingPolicyApprovalId).toBeNull();
  });

  it("refuses a draft naming an agent from elsewhere or a chain that is not configured", async () => {
    const api = t.owner.browser.api;
    const params = { workspaceId, walletId };
    expect(
      await refusal(
        api.call("requestPolicy", {
          params,
          body: { draft: draft("agt_01j00000000000000000000000") },
        }),
      ),
    ).toBe("invalid_request");
    expect(
      await refusal(
        api.call("requestPolicy", {
          params,
          body: { draft: { ...draft(agentId), chains: ["eip155:1"] } },
        }),
      ),
    ).toBe("invalid_request");
  });

  it("disabling an agent marks it disabled", async () => {
    const disabled = await t.owner.browser.api.call("disableAgent", {
      params: { workspaceId, agentId },
      body: {},
    });
    expect(disabled.status).toBe("disabled");
  });
});

describe("audit", () => {
  it("lists opened details and verifies the chain", async () => {
    const api = t.owner.browser.api;
    const page = await api.call("listAudit", { params: { workspaceId }, query: {} });
    const created = page.items.find((event) => event.action === "workspace.created");
    expect(created?.detail).toMatchObject({ name: "Ops" });
    expect(created?.actor.name).toBe("Olivia Owner");
    expect(await api.call("verifyAudit", { params: { workspaceId } })).toMatchObject({ ok: true });
    const decisions = await api.call("listSignerDecisions", { params: { workspaceId }, query: {} });
    expect(decisions.items.some((d) => d.outcome === "allowed")).toBe(true);
  });
});
