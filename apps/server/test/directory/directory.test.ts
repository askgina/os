import { ApiError, type PolicyDraft } from "@askgina/os-api";
import {
  type AgentId,
  type ApprovalId,
  DomainTag,
  digestHex,
  type WalletId,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit, verifyAudit } from "../../src/audit.ts";
import {
  agents,
  approvals,
  auditEvents,
  credentials,
  memberships,
  wallets,
} from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import {
  createTestContext,
  firstApproval,
  TEST_CHAIN_ID,
  type TestContext,
  type TestPerson,
} from "../support/context.ts";

let t: TestContext;

let workspaceId: WorkspaceId;

beforeAll(async () => {
  // Only mainnet is configured, so a testnet draft names a network this server lacks.
  t = await createTestContext({
    label: "directory",
    config: { venues: [{ network: "hyperliquid:mainnet", apiUrl: "http://127.0.0.1:9" }] },
  });
  const created = await t.owner.browser.api.call("createWorkspace", { body: { name: "Ops" } });
  workspaceId = created.id;
});

afterAll(async () => {
  await t?.close();
});

/** The API's refusal of `promise`; throws when it succeeded or failed some other way. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof ApiError) return caught;
  }

  throw new Error("expected the API to refuse");
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  return (await rejection(promise)).code;
}

/** A new person who joins `workspaceId` through an invite for `role`. */
async function join(role: "owner" | "approver" | "viewer", name: string): Promise<TestPerson> {
  const { url } = await t.owner.browser.api.call("createInvite", {
    params: { workspaceId },
    body: { role },
  });

  const token = url.split("/join/")[1] ?? "";
  const browser = t.browser();

  const start = await browser.api.call("startInviteRegistration", {
    params: { token },
    body: { displayName: name },
  });

  const passkey = t.register(start.options);

  const session = await browser.api.call("finishInviteRegistration", {
    params: { token },
    body: { ceremonyId: start.ceremonyId, response: passkey.response },
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

const draft = (agentId: AgentId): PolicyDraft => ({
  chains: [TEST_CHAIN_ID],
  requesters: [agentId],
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
    expect(detail.venueNetworks).toEqual(["hyperliquid:mainnet"]);
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

    const token = url.split("/join/")[1] ?? "";
    const someone = await t.signIn(approver.credentialId);
    const first = t.browser();

    const start = await first.api.call("startInviteRegistration", {
      params: { token },
      body: { displayName: "Vic" },
    });

    const passkey = t.register(start.options);
    await first.api.call("finishInviteRegistration", {
      params: { token },
      body: { ceremonyId: start.ceremonyId, response: passkey.response },
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

    const token = url.split("/join/")[1] ?? "";
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
    const removal = firstApproval(changed.approvals);
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
  let agentId: AgentId;
  let walletId: WalletId;
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
    const [row] = await t.ctx.db.select().from(agents).where(eq(agents.id, agentId));

    // `osa_<agent ulid>_<secret>`: the secret starts at 31, and may itself contain `_`.
    const secret = token.slice(31);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(t.log.lines.join("\n")).not.toContain(secret);
    const dump = await t.ctx.pool.query("SELECT * FROM os.agents");
    expect(JSON.stringify(dump.rows)).not.toContain(secret);
  });

  it("rotating replaces the token", async () => {
    const rotated = await t.owner.browser.api.call("rotateAgentToken", {
      params: { workspaceId, agentId },
      body: {},
    });

    expect(rotated.token).not.toBe(token);

    const [row] = await t.ctx.db.select().from(agents).where(eq(agents.id, agentId));

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
    expect((await t.ctx.signer.getWallet(walletId)).policy).toBeNull();

    expect((await t.approve(second.id, [t.owner])).status).toBe("executed");
    const atSigner = await t.ctx.signer.getWallet(walletId);
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

  it("takes venue rules for a configured network, mainnet included, and refuses any other", async () => {
    const api = t.owner.browser.api;
    const params = { workspaceId, walletId };

    const withVenue = (network: "hyperliquid:testnet" | "hyperliquid:mainnet"): PolicyDraft => ({
      ...draft(agentId),
      venues: {
        hyperliquid: {
          network,
          markets: [{ asset: 3, coin: "BTC", maxNotionalPerOrderUsd6: "1000000000" }],
          maxNotionalPerDayUsd6: "5000000000",
          timeInForce: ["Gtc", "Ioc"],
          submitWindowSeconds: 60,
          withdrawals: false,
        },
      },
    });

    const refused = await rejection(
      api.call("requestPolicy", { params, body: { draft: withVenue("hyperliquid:testnet") } }),
    );

    expect([refused.code, refused.detail, refused.message]).toEqual([
      "invalid_request",
      "venue_not_configured",
      "draft.venues: this venue network is not configured here",
    ]);

    const opened = await api.call("requestPolicy", {
      params,
      body: { draft: withVenue("hyperliquid:mainnet") },
    });

    const [row] = await t.ctx.db.select().from(approvals).where(eq(approvals.id, opened.id));
    expect(row?.status).toBe("pending");
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

// --- hardening ----------------------------------------------------------------------------------

async function freshWorkspace(name: string): Promise<WorkspaceId> {
  return (await t.owner.browser.api.call("createWorkspace", { body: { name } })).id;
}

async function joinInto(
  target: WorkspaceId,
  role: "owner" | "approver" | "viewer",
  name: string,
  inviter: TestPerson = t.owner,
): Promise<TestPerson> {
  const { url } = await inviter.browser.api.call("createInvite", {
    params: { workspaceId: target },
    body: { role },
  });

  const token = url.split("/join/")[1] ?? "";
  const browser = t.browser();

  const start = await browser.api.call("startInviteRegistration", {
    params: { token },
    body: { displayName: name },
  });

  const passkey = t.register(start.options);

  const session = await browser.api.call("finishInviteRegistration", {
    params: { token },
    body: { ceremonyId: start.ceremonyId, response: passkey.response },
  });

  if (!session.user) throw new Error("joining did not sign in");

  return {
    userId: session.user.id,
    displayName: name,
    credentialId: passkey.credentialId,
    browser,
  };
}

/** Join as an approver or owner and have the owner let the new passkey approve. */
async function joinActive(target: WorkspaceId, role: "owner" | "approver", name: string) {
  const person = await joinInto(target, role, name);
  const approvalId = await pendingFor("add-approver", person.credentialId);
  expect((await t.approve(approvalId, [t.owner])).status).toBe("executed");

  return person;
}

/** Run a directory approval's step again, as a step that runs late does, through its handler. */
async function replay(approvalId: ApprovalId): Promise<void> {
  const engine = engineOf(t.ctx);
  const row = await engine.request(approvalId);
  // The handler `registerDirectory` registered on this context's engine for the row's kind.
  const handler = engine.handler(row.kind);
  // SAFETY: deliberately not a valid Authorization; the signer already applied this approval,
  // so the replayed handler never reads the authorization.
  await handler.execute(t.ctx, row, {} as never, await engine.openDetail(row));
}

describe("invites", () => {
  it("links point at the web app's join page, and owners can list and revoke them", async () => {
    const target = await freshWorkspace("Invites");
    const api = t.owner.browser.api;

    const { url } = await api.call("createInvite", {
      params: { workspaceId: target },
      body: { role: "approver" },
    });

    expect(url.startsWith(`${t.ctx.config.publicOrigin}/join/`)).toBe(true);
    const token = url.split("/join/")[1] ?? "";
    const listed = await api.call("listInvites", { params: { workspaceId: target } });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ role: "approver", createdBy: { id: t.owner.userId } });
    expect(JSON.stringify(listed)).not.toContain(token);

    await api.call("revokeInvite", {
      params: { workspaceId: target, inviteId: listed.items[0]?.id ?? "" },
    });
    expect(await refusal(t.browser().api.call("getInvite", { params: { token } }))).toBe(
      "not_found",
    );
    expect((await api.call("listInvites", { params: { workspaceId: target } })).items).toEqual([]);
  });

  it("an owner who is demoted cannot come back with an invite they made earlier", async () => {
    const target = await freshWorkspace("Rejoin");
    const bob = await joinInto(target, "owner", "Bob");

    const { url } = await bob.browser.api.call("createInvite", {
      params: { workspaceId: target },
      body: { role: "owner" },
    });

    const token = url.split("/join/")[1] ?? "";
    // Bob's passkey still waits to approve, so demoting him takes effect at once.
    await t.owner.browser.api.call("setMemberRole", {
      params: { workspaceId: target, userId: bob.userId },
      body: { role: "viewer" },
    });
    expect(await refusal(t.browser().api.call("getInvite", { params: { token } }))).toBe(
      "not_found",
    );
    await t.owner.browser.api.call("removeMember", {
      params: { workspaceId: target, userId: bob.userId },
    });
    expect(
      await refusal(bob.browser.api.call("acceptInvite", { params: { token }, body: {} })),
    ).toBe("not_found");
  });

  it("an invite stops working when its creator is no longer an owner, however that came about", async () => {
    const target = await freshWorkspace("Authority");
    const carol = await joinInto(target, "owner", "Carol");

    const { url } = await carol.browser.api.call("createInvite", {
      params: { workspaceId: target },
      body: { role: "owner" },
    });

    const token = url.split("/join/")[1] ?? "";
    await t.ctx.db
      .update(memberships)
      .set({ role: "viewer" })
      .where(and(eq(memberships.workspaceId, target), eq(memberships.userId, carol.userId)));
    expect(await refusal(t.browser().api.call("getInvite", { params: { token } }))).toBe(
      "not_found",
    );
    const stranger = await join("viewer", "Sam");
    expect(
      await refusal(stranger.browser.api.call("acceptInvite", { params: { token }, body: {} })),
    ).toBe("not_found");
  });
});

describe("members and approvers", () => {
  it("owners see the public key of a passkey waiting to approve; others do not", async () => {
    const target = await freshWorkspace("Pending");
    const ada = await joinInto(target, "approver", "Ada");

    const asOwner = await t.owner.browser.api.call("getWorkspace", {
      params: { workspaceId: target },
    });

    const [credential] = await t.ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.id, ada.credentialId));

    expect(asOwner.members.find((m) => m.user.id === ada.userId)?.pendingPasskeys).toEqual([
      {
        credentialId: ada.credentialId,
        publicKey: credential?.publicKey.toString("base64url"),
        label: "First passkey",
      },
    ]);
    const asAda = await ada.browser.api.call("getWorkspace", { params: { workspaceId: target } });
    expect(asAda.members.every((m) => m.pendingPasskeys.length === 0)).toBe(true);
  });

  it("notices an approver an operator enrolled at the signer, and cancels the request that waited", async () => {
    const target = await freshWorkspace("Operator");
    const ada = await joinInto(target, "approver", "Ada");
    const waiting = await pendingFor("add-approver", ada.credentialId);

    const [credential] = await t.ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.id, ada.credentialId));

    t.signer.enrollApproverByOperator(target, {
      userId: ada.userId,
      credentialId: ada.credentialId,
      publicKey: credential?.publicKey.toString("base64url") ?? "",
    });

    const detail = await t.owner.browser.api.call("getWorkspace", {
      params: { workspaceId: target },
    });

    expect(detail.members.find((m) => m.user.id === ada.userId)?.approver).toBe("active");
    const [row] = await t.ctx.db.select().from(approvals).where(eq(approvals.id, waiting));
    expect(row?.status).toBe("cancelled");

    const audit = await t.owner.browser.api.call("listAudit", {
      params: { workspaceId: target },
      query: {},
    });

    expect(audit.items.some((e) => e.action === "approver.enrolled_by_operator")).toBe(true);
  });

  it("a removal that waited does not take the workspace's last owner away", async () => {
    const target = await freshWorkspace("Owners");
    const bob = await joinActive(target, "owner", "Bob");
    // The signer never removes its last approver, so a third person approves both removals.
    const ada = await joinActive(target, "approver", "Ada");

    const removeBob = await t.owner.browser.api.call("removeMember", {
      params: { workspaceId: target, userId: bob.userId },
    });

    const removeOlivia = await bob.browser.api.call("setMemberRole", {
      params: { workspaceId: target, userId: t.owner.userId },
      body: { role: "viewer" },
    });

    expect((await t.approve(firstApproval(removeOlivia.approvals), [ada])).status).toBe("executed");
    expect((await t.approve(firstApproval(removeBob.approvals), [ada])).status).toBe("executed");

    const rows = await t.ctx.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, target), eq(memberships.role, "owner")));

    expect(rows.map((r) => r.userId)).toEqual([bob.userId]);
  });

  it("refuses names that could make an approval card read differently", async () => {
    expect(
      await refusal(
        t.owner.browser.api.call("createWorkspace", { body: { name: "Pay\u202eevil" } }),
      ),
    ).toBe("invalid_request");
  });

  it("a workspace has one treasury and a wallet one agent, even past the route checks", async () => {
    const target = await freshWorkspace("Unique");

    const treasury = await t.owner.browser.api.call("createTreasury", {
      params: { workspaceId: target },
      body: { label: "Treasury" },
    });

    await expect(
      t.ctx.db.insert(wallets).values({
        id: "wal_01j0000000000000000000000x",
        workspaceId: target,
        kind: "treasury",
        label: "Second",
        address: "0x0000000000000000000000000000000000000001",
      }),
    ).rejects.toThrow();

    const agent = await t.owner.browser.api.call("createAgent", {
      params: { workspaceId: target },
      body: { name: "Bot" },
    });

    await expect(
      t.ctx.db.insert(agents).values({
        id: "agt_01j0000000000000000000000x",
        workspaceId: target,
        name: "Twin",
        tokenHash: "x".repeat(64),
        tokenPrefix: "osa_twin",
        walletId: agent.wallet.id,
      }),
    ).rejects.toThrow();
    expect(treasury.kind).toBe("treasury");
  });
});

describe("thresholds", () => {
  it("a policy may not need more approvals than the admin threshold, and the admin threshold may not drop below a policy", async () => {
    const target = await freshWorkspace("Thresholds");
    const ada = await joinActive(target, "approver", "Ada");

    const agent = await t.owner.browser.api.call("createAgent", {
      params: { workspaceId: target },
      body: { name: "Bot" },
    });

    const params = { workspaceId: target, walletId: agent.wallet.id };
    const two = { ...draft(agent.agent.id), approvals: { threshold: 2, ttlSeconds: 600 } };
    expect(
      await refusal(t.owner.browser.api.call("requestPolicy", { params, body: { draft: two } })),
    ).toBe("invalid_request");

    const raise = await t.owner.browser.api.call("requestAdminThreshold", {
      params: { workspaceId: target },
      body: { adminThreshold: 2 },
    });

    expect((await t.approve(raise.id, [t.owner])).status).toBe("executed");

    const policy = await t.owner.browser.api.call("requestPolicy", {
      params,
      body: { draft: two },
    });

    expect((await t.approve(policy.id, [t.owner, ada])).status).toBe("executed");
    expect(
      await refusal(
        t.owner.browser.api.call("requestAdminThreshold", {
          params: { workspaceId: target },
          body: { adminThreshold: 1 },
        }),
      ),
    ).toBe("invalid_request");
  });
});

describe("mirrors", () => {
  it("a policy step that runs again late does not put an older policy back", async () => {
    const target = await freshWorkspace("Mirror");

    const agent = await t.owner.browser.api.call("createAgent", {
      params: { workspaceId: target },
      body: { name: "Bot" },
    });

    const params = { workspaceId: target, walletId: agent.wallet.id };

    const first = await t.owner.browser.api.call("requestPolicy", {
      params,
      body: { draft: draft(agent.agent.id) },
    });

    expect((await t.approve(first.id, [t.owner])).status).toBe("executed");

    const second = await t.owner.browser.api.call("requestPolicy", {
      params,
      body: { draft: { ...draft(agent.agent.id), fees: { maxPerTxWei: "7" } } },
    });

    expect((await t.approve(second.id, [t.owner])).status).toBe("executed");
    await replay(first.id);
    const [row] = await t.ctx.db.select().from(wallets).where(eq(wallets.id, agent.wallet.id));
    expect(row?.policy?.revision).toBe(2);
    expect(row?.policyHash).toBe((await t.ctx.signer.getWallet(agent.wallet.id)).policyHash);
  });

  it("a resume step that runs again after a new pause leaves the workspace shown paused", async () => {
    const target = await freshWorkspace("Brake");
    const api = t.owner.browser.api;
    await api.call("pauseWorkspace", { params: { workspaceId: target }, body: {} });
    const resume = await api.call("requestResume", { params: { workspaceId: target }, body: {} });
    expect((await t.approve(resume.id, [t.owner])).status).toBe("executed");
    await api.call("pauseWorkspace", { params: { workspaceId: target }, body: {} });
    await replay(resume.id);
    expect((await api.call("getWorkspace", { params: { workspaceId: target } })).paused).toBe(true);
  });
});

describe("audit chain", () => {
  it("salts the digest of the sealed detail, so equal details do not look equal", async () => {
    const target = await freshWorkspace("Salt");
    const detail = { memo: "rent for March" };
    await appendAudit(t.ctx, {
      workspaceId: target,
      actor: { type: "system", id: null },
      action: "test.a",
      detail,
    });
    await appendAudit(t.ctx, {
      workspaceId: target,
      actor: { type: "system", id: null },
      action: "test.b",
      detail,
    });

    const rows = await t.ctx.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, target));

    const tested = rows.filter((r) => r.action.startsWith("test."));
    expect(tested[0]?.detailDigest).not.toBe(tested[1]?.detailDigest);
    const guess = digestHex(DomainTag.audit, { detail });
    expect(rows.map((r) => r.detailDigest)).not.toContain(guess);

    const page = await t.owner.browser.api.call("listAudit", {
      params: { workspaceId: target },
      query: {},
    });

    expect(page.items.find((e) => e.action === "test.a")?.detail).toEqual(detail);
    expect(await verifyAudit(t.ctx, target)).toMatchObject({ ok: true });
  });

  async function chainOf(name: string, extra: number): Promise<WorkspaceId> {
    const target = await freshWorkspace(name);

    for (let i = 0; i < extra; i += 1) {
      await appendAudit(t.ctx, {
        workspaceId: target,
        actor: { type: "system", id: null },
        action: "test.event",
        detail: { i },
      });
    }

    return target;
  }

  it("notices an edited entry", async () => {
    const target = await chainOf("Edited", 3);
    await t.ctx.db
      .update(auditEvents)
      .set({ action: "test.forged" })
      .where(and(eq(auditEvents.workspaceId, target), eq(auditEvents.seq, 2)));
    expect(await verifyAudit(t.ctx, target)).toEqual({ ok: false, checked: 1, brokenAt: 2 });
  });

  it("notices a deleted entry in the middle", async () => {
    const target = await chainOf("Middle", 3);
    await t.ctx.db
      .delete(auditEvents)
      .where(and(eq(auditEvents.workspaceId, target), eq(auditEvents.seq, 2)));
    expect(await verifyAudit(t.ctx, target)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it("notices deleted newest entries and a deleted chain", async () => {
    const tail = await chainOf("Tail", 3);
    await t.ctx.db
      .delete(auditEvents)
      .where(and(eq(auditEvents.workspaceId, tail), eq(auditEvents.seq, 4)));
    expect(await verifyAudit(t.ctx, tail)).toEqual({ ok: false, checked: 3, brokenAt: 4 });

    const whole = await chainOf("Whole", 1);
    await t.ctx.db.delete(auditEvents).where(eq(auditEvents.workspaceId, whole));
    expect(await verifyAudit(t.ctx, whole)).toEqual({ ok: false, checked: 0, brokenAt: 1 });
  });
});
