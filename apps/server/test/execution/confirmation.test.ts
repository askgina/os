import { randomBytes } from "node:crypto";
import {
  type ApprovalId,
  type Assertion,
  AssertionResponse,
  type Envelope,
  envelopeChallenge,
  type IntentId,
  keyFingerprint,
} from "@askgina/os-protocol";
import { type SignerClient, SignerError } from "@askgina/os-protocol/signer";
import { b64url } from "@askgina/os-protocol/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { approvalAssertions, approvals, intents, transactions } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import {
  TEST_APPROVAL_ORIGIN,
  TEST_CHAIN_ID,
  TEST_ORIGIN,
  type TestPerson,
} from "../support/context.ts";
import { createFixture, draftFor, type Fixture, fund, toolJson } from "./fixture.ts";

let f: Fixture;
let bob: TestPerson;

beforeAll(async () => {
  f = await createFixture("exec_confirmation");
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
});
afterAll(async () => {
  await f?.close();
});

const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;

/** An agent's payment, waiting for approval. */
async function proposePayment(): Promise<{ intentId: IntentId; approvalId: ApprovalId }> {
  const client = await f.mcp(f.agent.token);
  const proposed = toolJson(
    await client.callTool({
      name: "propose_transfer",
      arguments: { chainId: TEST_CHAIN_ID, to: randomAddress(), amount: "0.01", memo: "rent" },
    }),
  );
  if (typeof proposed.intentId !== "string") throw new Error(JSON.stringify(proposed));
  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, proposed.intentId as IntentId));
  if (!row?.approvalId) throw new Error("intent without approval");
  return { intentId: row.id, approvalId: row.approvalId };
}

/** The link the approval page shows, split the way the confirmation page reads it. */
async function linkOf(approvalId: ApprovalId, person: TestPerson = f.t.owner) {
  const detail = await person.browser.api.call("getApproval", { params: { approvalId } });
  if (detail.confirmUrl === null) throw new Error(`${approvalId} has no confirmation link`);
  const url = new URL(detail.confirmUrl);
  return { url, token: url.hash.slice(1), detail };
}

/** What a browser sends after `person` approved `envelope` with their passkey on a page at `origin`. */
function assertAt(person: TestPerson, envelope: Envelope, origin: string): AssertionResponse {
  return AssertionResponse.parse(
    f.t.authenticator.authenticate({
      credentialId: person.credentialId,
      challenge: b64url(envelopeChallenge(envelope)),
      origin,
    }),
  );
}

/** Swap one method of the control plane's signer client for the length of `run`. */
async function withSigner<M extends keyof SignerClient>(
  method: M,
  replacement: (real: SignerClient[M]) => SignerClient[M],
  run: () => Promise<void>,
): Promise<void> {
  const signer = f.t.ctx.signer;
  const real = signer[method];
  signer[method] = replacement(real.bind(signer) as SignerClient[M]);
  try {
    await run();
  } finally {
    signer[method] = real;
  }
}

async function storedAssertions(approvalId: ApprovalId) {
  return f.t.ctx.db
    .select()
    .from(approvalAssertions)
    .where(eq(approvalAssertions.approvalId, approvalId));
}

describe("the confirmation page's origin", () => {
  it("the server refuses to start with the confirmation page on its own origin", () => {
    const env = {
      PUBLIC_ORIGIN: "http://localhost:8080",
      DATABASE_URL: "postgres://localhost/none",
      KEYRING_FILE: "/nonexistent/keyring.json",
      SIGNER_URL: "http://signer.test",
      SIGNER_HMAC_SECRET_FILE: "/nonexistent/secret",
      CHAINS_FILE: "/nonexistent/chains.json",
    };
    // The same origin however it is written, or a page that is not a web origin at all.
    for (const APPROVE_ORIGIN of [
      "http://localhost:8080",
      "http://localhost:8080/",
      "HTTP://LOCALHOST:8080",
      "javascript:alert(1)",
    ]) {
      expect(() => loadConfig({ ...env, APPROVE_ORIGIN }), APPROVE_ORIGIN).toThrow(
        /APPROVE_ORIGIN/,
      );
    }
    // Another port passes this check; the files it then reads do not exist here.
    expect(() => loadConfig({ ...env, APPROVE_ORIGIN: "http://localhost:8081" })).toThrow(/ENOENT/);
  });
});

describe("the confirmation page's link", () => {
  it("opening an approval opens a confirmation at the signer", async () => {
    const { approvalId } = await proposePayment();
    // Opened with the request, before anyone looked at it.
    const [row] = await f.t.ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.confirmation).not.toBeNull();

    const { url, token, detail } = await linkOf(approvalId);
    expect(url.origin).toBe(TEST_APPROVAL_ORIGIN);
    expect(url.pathname).toBe(`/a/${approvalId}`);
    const view = await f.t.confirm.getConfirmation(approvalId, token);
    expect(view).toMatchObject({ approvalId, kind: "approve-intent", state: "open" });
    expect(view.title).toBe("Send 0.01 ETH");
    expect(view.envelope).toEqual(detail.envelope);
    // The token is kept sealed and never logged: whoever reads the table or the log cannot
    // open the page.
    expect(Buffer.from(row?.confirmation ?? new Uint8Array()).toString("latin1")).not.toContain(
      token,
    );
    expect(f.t.log.lines.join("\n")).not.toContain(token);

    // Every later view hands out the same link: one a person already opened keeps working.
    for (const person of [f.t.owner, bob, f.t.owner]) {
      expect((await linkOf(approvalId, person)).detail.confirmUrl).toBe(detail.confirmUrl);
    }
    expect((await f.t.confirm.getConfirmation(approvalId, token)).state).toBe("open");

    // A request that no longer waits has no link.
    const rejected = await f.t.owner.browser.api.call("reject", {
      params: { approvalId },
      body: {},
    });
    expect(rejected.confirmUrl).toBeNull();
    expect(
      (await f.t.owner.browser.api.call("getApproval", { params: { approvalId } })).confirmUrl,
    ).toBeNull();
  });

  it("every kind of request gets a confirmation the signer accepts as what its envelope names", async () => {
    const api = f.t.owner.browser.api;
    const agent = await f.newAgent("Kinds");
    const policy = await api.call("requestPolicy", {
      params: { workspaceId: f.workspaceId, walletId: agent.walletId },
      body: { draft: draftFor(agent.id) },
    });
    const treasury = await api.call("createTreasury", {
      params: { workspaceId: f.workspaceId },
      body: { label: "Reserve" },
    });
    await fund(agent.address, 10n ** 18n);
    const sweep = await api.call("requestSweep", {
      params: { workspaceId: f.workspaceId, walletId: agent.walletId },
      body: { chainId: TEST_CHAIN_ID, asset: "native", to: treasury.address },
    });
    const paused = await f.newWorkspace("Paused");
    await api.call("pauseWorkspace", { params: { workspaceId: paused }, body: {} });
    const resume = await api.call("requestResume", { params: { workspaceId: paused }, body: {} });
    const payment = await proposePayment();

    for (const [approvalId, kind] of [
      [payment.approvalId, "approve-intent"],
      [policy.id, "set-policy"],
      [sweep.id, "sweep-wallet"],
      [resume.id, "resume-workspace"],
    ] as const) {
      const { token } = await linkOf(approvalId);
      const view = await f.t.confirm.getConfirmation(approvalId, token);
      expect(view.kind, kind).toBe(kind);
      expect(view.state, kind).toBe("open");
    }
  });

  it("an approver change and an admin threshold change get a confirmation the signer accepts", async () => {
    const api = f.t.owner.browser.api;
    const team = await f.newWorkspace("Directory kinds");
    // Someone to remove: added through an invite and approved by the owner.
    const leaving = await f.addApprover(team, "Leaving Approver");
    const removal = await api.call("removeMember", {
      params: { workspaceId: team, userId: leaving.userId },
    });
    // Someone who joins: their approver request waits.
    const invite = await api.call("createInvite", {
      params: { workspaceId: team },
      body: { role: "approver" },
    });
    const token = invite.url.split("/").at(-1) ?? "";
    const joining = f.t.browser();
    const start = await joining.api.call("startInviteRegistration", {
      params: { token },
      body: { displayName: "Joining Approver" },
    });
    await joining.api.call("finishInviteRegistration", {
      params: { token },
      body: {
        ceremonyId: start.ceremonyId,
        response: f.t.register(start.options).response as never,
      },
    });
    const threshold = await api.call("requestAdminThreshold", {
      params: { workspaceId: team },
      body: { adminThreshold: 2 },
    });
    const pending = await api.call("listApprovals", {
      params: { workspaceId: team },
      query: { status: "pending" },
    });
    const addition = pending.items.find((item) => item.kind === "add-approver");
    const removed = removal.approvals.find((item) => item.kind === "remove-approver");
    if (!addition || !removed) throw new Error("the directory requests were not opened");

    for (const [approvalId, kind] of [
      [addition.id, "add-approver"],
      [removed.id, "remove-approver"],
      [threshold.id, "set-admin-threshold"],
    ] as const) {
      const { token: confirmToken, detail } = await linkOf(approvalId);
      const view = await f.t.confirm.getConfirmation(approvalId, confirmToken);
      expect(view.kind, kind).toBe(kind);
      expect(view.state, kind).toBe("open");
      expect(view.envelope, kind).toEqual(detail.envelope);
    }
  });

  it("a confirmation the signer could not open with the request is opened when first viewed, once", async () => {
    let opened = 0;
    let request: { approvalId: ApprovalId } | undefined;
    await withSigner(
      "openConfirmation",
      () => async () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        request = await proposePayment();
      },
    );
    if (!request) throw new Error("no request");
    const { approvalId } = request;
    const [row] = await f.t.ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row?.confirmation).toBeNull();
    expect(f.t.log.lines.some((line) => line.includes('"code":"unreachable"'))).toBe(true);

    // Views that arrive together open it once, so no view ends another's link.
    let links: (string | null)[] = [];
    await withSigner(
      "openConfirmation",
      (real) => async (id, body) => {
        opened += 1;
        return real(id, body);
      },
      async () => {
        links = await Promise.all(
          [f.t.owner, bob, f.t.owner, bob, f.t.owner].map(
            async (person) =>
              (await person.browser.api.call("getApproval", { params: { approvalId } })).confirmUrl,
          ),
        );
      },
    );
    expect(opened).toBe(1);
    expect(new Set(links).size).toBe(1);
    const token = new URL(links[0] ?? "").hash.slice(1);
    expect((await f.t.confirm.getConfirmation(approvalId, token)).state).toBe("open");
  });

  it("a request the signer refuses to open shows no link, and the control plane takes no approval for it", async () => {
    let request: { approvalId: ApprovalId; intentId: IntentId } | undefined;
    await withSigner(
      "openConfirmation",
      () => async () => {
        throw new SignerError("envelope_fenced", "issued before the restore fence", 403);
      },
      async () => {
        request = await proposePayment();
        const detail = await f.t.owner.browser.api.call("getApproval", {
          params: { approvalId: request.approvalId },
        });
        expect(detail.status).toBe("pending");
        expect(detail.confirmUrl).toBeNull();
        expect(detail.canDecide).toBe(true);
        // The routes that once took a passkey approval on the control plane's own page are gone.
        const { envelope } = detail;
        for (const path of ["options", "approve"]) {
          const response = await f.t.owner.browser.fetch(
            `/api/v1/approvals/${request.approvalId}/${path}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ response: assertAt(f.t.owner, envelope, TEST_ORIGIN) }),
            },
          );
          expect([path, response.status]).toEqual([path, 404]);
        }
        expect(await storedAssertions(request.approvalId)).toHaveLength(0);
      },
    );
    if (!request) throw new Error("no request");
    // Once the signer opens it, a later view shows the link, and the page approves it.
    const row = await f.t.approve(request.approvalId, [f.t.owner]);
    expect(row.status).toBe("executed");
  });
});

describe("an approver change", () => {
  it("takes no approval until the person being added proved on the page that the passkey is theirs", async () => {
    const api = f.t.owner.browser.api;
    const invite = await api.call("createInvite", {
      params: { workspaceId: f.workspaceId },
      body: { role: "approver" },
    });
    const token = invite.url.split("/").at(-1) ?? "";
    const dana = f.t.browser();
    const start = await dana.api.call("startInviteRegistration", {
      params: { token },
      body: { displayName: "Dana Joining" },
    });
    const passkey = f.t.register(start.options);
    await dana.api.call("finishInviteRegistration", {
      params: { token },
      body: { ceremonyId: start.ceremonyId, response: passkey.response as never },
    });
    const pending = await api.call("listApprovals", {
      params: { workspaceId: f.workspaceId },
      query: { status: "pending" },
    });
    const change = pending.items.find((item) => item.kind === "add-approver");
    if (!change) throw new Error("joining as an approver opened no approver change");

    // The owner's approval on the confirmation page is refused, and nothing is counted.
    const { token: confirmToken, detail } = await linkOf(change.id);
    if (detail.envelope.type !== "add-approver" || detail.confirmUrl === null) {
      throw new Error("not an approver change with a link");
    }
    expect(detail.envelope.credentialId).toBe(passkey.credentialId);
    await expect(
      f.t.approveAt(detail.confirmUrl, f.t.owner, detail.envelope),
    ).rejects.toMatchObject({ code: "possession_unproven" });
    expect(await storedAssertions(change.id)).toHaveLength(0);

    // Dana, a member who cannot decide, sees the same link and proves there that the passkey
    // is hers. The page shows her the fingerprint the owner's page shows.
    const asDana = await dana.api.call("getApproval", { params: { approvalId: change.id } });
    expect(asDana).toMatchObject({ canDecide: false, confirmUrl: detail.confirmUrl });
    expect(await f.t.provePossession(detail.confirmUrl, detail.envelope)).toEqual({
      fingerprint: keyFingerprint(detail.envelope.publicKey),
    });
    const view = await f.t.confirm.getConfirmation(change.id, confirmToken);
    expect(view.warnings).toEqual([]);
    expect(view.lines).toContainEqual({
      label: "Key fingerprint",
      value: keyFingerprint(detail.envelope.publicKey),
      kind: "code",
    });

    // Now the owner's approval counts, and the signer adds the passkey.
    expect((await f.t.approveOnPage(f.t.owner, change.id)).status).toBe("approved");
    expect((await f.t.approve(change.id, [])).status).toBe("executed");
    const atSigner = await f.t.ctx.signer.getWorkspace(f.workspaceId);
    expect(atSigner.approvers.map((approver) => approver.credentialId)).toContain(
      passkey.credentialId,
    );
  });
});

describe("an approval made on the control plane's page", () => {
  it("is refused by the confirmation page, and by the signer when the control plane sends it anyway", async () => {
    const { approvalId, intentId } = await proposePayment();
    const { token, detail } = await linkOf(approvalId);
    const onControlPlane = assertAt(f.t.owner, detail.envelope, TEST_ORIGIN);
    await expect(
      f.t.confirm.submitConfirmation(approvalId, token, onControlPlane),
    ).rejects.toMatchObject({ code: "assertion_invalid" });

    // A control plane that stores such an approval itself (one compromised, or one approved on
    // its own page before the upgrade) gets nothing signed: the request ends failed.
    await f.t.ctx.db.insert(approvalAssertions).values({
      approvalId,
      userId: f.t.owner.userId,
      credentialId: f.t.owner.credentialId,
      response: onControlPlane,
      createdAt: new Date(f.t.clock.now() * 1000),
    });
    await f.t.ctx.db
      .update(approvals)
      .set({ status: "approved", decidedAt: new Date(f.t.clock.now() * 1000) })
      .where(eq(approvals.id, approvalId));
    const steps = engineOf(f.t.ctx).steps();
    const result = await steps.execute(approvalId);
    expect(result).toEqual({ ok: false, code: "assertion_invalid" });
    if (!result.ok) await steps.fail(approvalId, result.code);
    expect(await engineOf(f.t.ctx).row(approvalId)).toMatchObject({
      status: "failed",
      failureCode: "assertion_invalid",
    });
    expect(
      await f.t.ctx.db.select().from(transactions).where(eq(transactions.intentId, intentId)),
    ).toHaveLength(0);
    expect((await f.t.ctx.signer.getApproval(approvalId)).state).toBe("revoked");
  });
});

describe("collecting approvals made on the confirmation page", () => {
  it("collect counts an assertion made at the approval origin and approves", async () => {
    const { approvalId, intentId } = await proposePayment();
    const { token, detail } = await linkOf(approvalId);
    const submitted = await f.t.confirm.submitConfirmation(
      approvalId,
      token,
      assertAt(f.t.owner, detail.envelope, TEST_APPROVAL_ORIGIN),
    );
    expect(submitted).toMatchObject({ collected: 1, required: 1 });
    expect(await storedAssertions(approvalId)).toHaveLength(0);

    const collected = await f.t.owner.browser.api.call("collectApproval", {
      params: { approvalId },
      body: {},
    });
    expect(collected).toMatchObject({ status: "approved", approvals: 1, confirmUrl: null });
    expect(collected.approvedBy.map((user) => user.id)).toEqual([f.t.owner.userId]);
    // Collecting again changes nothing.
    await f.t.owner.browser.api.call("collectApproval", { params: { approvalId }, body: {} });
    expect(await storedAssertions(approvalId)).toHaveLength(1);

    // The signer signs with the assertion made on its confirmation page: one transaction.
    const steps = engineOf(f.t.ctx).steps();
    expect(await steps.execute(approvalId)).toEqual({ ok: true });
    expect(
      await f.t.ctx.db.select().from(transactions).where(eq(transactions.intentId, intentId)),
    ).toHaveLength(1);
  });

  it("reading the request or the inbox collects too", async () => {
    const byDetail = await proposePayment();
    const byInbox = await proposePayment();
    for (const { approvalId } of [byDetail, byInbox]) {
      const { token, detail } = await linkOf(approvalId, bob);
      await f.t.confirm.submitConfirmation(
        approvalId,
        token,
        assertAt(bob, detail.envelope, TEST_APPROVAL_ORIGIN),
      );
    }
    const read = await f.t.owner.browser.api.call("getApproval", {
      params: { approvalId: byDetail.approvalId },
    });
    expect(read.status).toBe("approved");
    expect(read.approvedBy.map((user) => user.id)).toEqual([bob.userId]);

    const inbox = await f.t.owner.browser.api.call("listApprovals", {
      params: { workspaceId: f.workspaceId },
      query: { status: "all" },
    });
    expect(inbox.items.find((item) => item.id === byInbox.approvalId)).toMatchObject({
      status: "approved",
      approvals: 1,
    });
  });

  it("collect ignores an assertion the signer would refuse", async () => {
    const { approvalId } = await proposePayment();
    const other = await proposePayment();
    const { token, detail } = await linkOf(approvalId);
    const otherEnvelope = (await linkOf(other.approvalId)).detail.envelope;
    const forged: Assertion[] = [
      // Made on the control plane's own page: the origin the confirmation page exists to replace.
      {
        userId: f.t.owner.userId,
        credentialId: f.t.owner.credentialId,
        response: assertAt(f.t.owner, detail.envelope, TEST_ORIGIN),
      },
      // Over another request's envelope.
      {
        userId: f.t.owner.userId,
        credentialId: f.t.owner.credentialId,
        response: assertAt(f.t.owner, otherEnvelope, TEST_APPROVAL_ORIGIN),
      },
      // Claimed for Bob, made with the owner's passkey.
      {
        userId: bob.userId,
        credentialId: f.t.owner.credentialId,
        response: assertAt(f.t.owner, detail.envelope, TEST_APPROVAL_ORIGIN),
      },
    ];
    const logged = f.t.log.lines.length;
    await withSigner(
      "listConfirmationAssertions",
      () => async () => ({ assertions: forged }),
      async () => {
        const collected = await f.t.owner.browser.api.call("collectApproval", {
          params: { approvalId },
          body: {},
        });
        expect(collected).toMatchObject({ status: "pending", approvals: 0, approvedBy: [] });
      },
    );
    expect(await storedAssertions(approvalId)).toHaveLength(0);
    const ignored = f.t.log.lines
      .slice(logged)
      .filter((line) => line.includes("a collected approval was not counted"));
    expect(ignored.map((line) => JSON.parse(line).code)).toEqual([
      "assertion_invalid",
      "assertion_invalid",
      "approver_unknown",
    ]);

    // The real one, made on the confirmation page, still counts.
    await f.t.confirm.submitConfirmation(
      approvalId,
      token,
      assertAt(f.t.owner, detail.envelope, TEST_APPROVAL_ORIGIN),
    );
    const collected = await f.t.owner.browser.api.call("collectApproval", {
      params: { approvalId },
      body: {},
    });
    expect(collected.status).toBe("approved");
  });
});
