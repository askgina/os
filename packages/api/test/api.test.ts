import type { JsonValue } from "@askgina/os-protocol";
import { describe, expect, it } from "vitest";
import {
  type ApiClientOptions,
  ApiError,
  ApprovalDetail,
  ApprovalSubject,
  ApprovalSummary,
  apiErrorStatus,
  createApiClient,
  DeletionPreflight,
  DisplayName,
  type RouteName,
  routes,
  WalletSummary,
  WorkspaceSummary,
  WorkspaceTemplate,
} from "../src/index.ts";
import * as f from "./fixtures.ts";

const approvalsList = { approvals: [f.approvalSummary] };

/** One example request and response for a route, each checked against the route's schemas. */
type RouteExample = { body?: unknown; query?: unknown; response: unknown };

/**
 * One realistic request body and response per route. A route missing here fails the coverage
 * test below, so a new endpoint cannot ship without its shapes being exercised once.
 */
const examples: Record<RouteName, RouteExample> = {
  getSession: { response: f.session },
  startSetup: {
    body: { setupToken: "setup-0123456789abcdef", displayName: "Ada" },
    response: f.ceremony,
  },
  finishSetup: {
    body: { ceremonyId: f.ceremony.ceremonyId, response: f.registrationResponse },
    response: f.session,
  },
  startLogin: { body: {}, response: f.ceremony },
  finishLogin: {
    body: { ceremonyId: f.ceremony.ceremonyId, response: f.assertionResponse },
    response: f.session,
  },
  logout: { body: {}, response: {} },
  listPasskeys: { response: { items: [f.passkey] } },
  startAddPasskey: { body: {}, response: f.ceremony },
  finishAddPasskey: {
    body: { ceremonyId: f.ceremony.ceremonyId, response: f.registrationResponse, label: "Phone" },
    response: { passkey: f.passkey, approvals: [f.approvalSummary] },
  },
  removePasskey: { response: approvalsList },
  eraseMe: {
    body: {},
    response: {
      status: "waiting",
      approvals: [{ ...f.approvalSummary, kind: "remove-approver" }],
    },
  },
  listWorkspaces: { response: { items: [f.workspaceSummary] } },
  createWorkspace: { body: { name: "Acme" }, response: f.workspace },
  getWorkspace: { response: f.workspace },
  pauseWorkspace: { body: {}, response: { ...f.workspace, paused: true } },
  requestResume: { body: {}, response: f.approvalSummary },
  requestAdminThreshold: { body: { adminThreshold: 2 }, response: f.approvalSummary },
  getDeletionPreflight: { response: f.deletionPreflight },
  requestDeleteWorkspace: {
    body: { destroyAfter: 1_700_604_800 },
    response: { ...f.approvalSummary, kind: "delete-workspace" },
  },
  cancelDeleteWorkspace: { body: {}, response: { ...f.workspace, paused: true } },
  exportTemplate: { response: f.workspaceTemplate },
  exportRecord: { response: { record: '{"format":"askgina.os/workspace-record/v1"}\n' } },
  cloneWorkspace: {
    body: { name: "Acme copy", includeAgents: true, includeMembers: true },
    response: f.cloneResult,
  },
  importTemplate: {
    body: {
      template: f.workspaceTemplate,
      name: "Acme copy",
      includeAgents: false,
      includeMembers: false,
    },
    response: f.cloneResult,
  },
  createInvite: {
    body: { role: "approver" },
    response: { id: "inv_1", url: "https://os.example.com/join/tok", expiresAt: 1_700_000_600 },
  },
  listInvites: {
    response: {
      items: [
        {
          id: "inv_0123456789abcdef",
          role: "owner",
          createdBy: f.member.user,
          createdAt: 1_700_000_000,
          expiresAt: 1_700_604_800,
        },
      ],
    },
  },
  revokeInvite: { response: {} },
  getInvite: { response: { workspaceName: "Acme", role: "approver", invitedBy: "Ada" } },
  startInviteRegistration: { body: { displayName: "Grace" }, response: f.ceremony },
  finishInviteRegistration: {
    body: { ceremonyId: f.ceremony.ceremonyId, response: f.registrationResponse },
    response: f.session,
  },
  acceptInvite: { body: {}, response: { workspaceId: f.WS } },
  setMemberRole: { body: { role: "viewer" }, response: { member: f.member, approvals: [] } },
  removeMember: { response: approvalsList },
  createAgent: {
    body: { name: "billing bot" },
    response: {
      agent: f.agent,
      wallet: f.wallet,
      token: "osa_secret",
      mcpUrl: "https://os.example.com/mcp",
    },
  },
  rotateAgentToken: { body: {}, response: { token: "osa_new" } },
  disableAgent: { body: {}, response: { ...f.agent, status: "disabled" } },
  createTreasury: {
    body: { label: "Treasury" },
    response: { ...f.wallet, kind: "treasury", agentId: null },
  },
  getWallet: { response: f.walletDetail },
  requestPolicy: { body: { draft: f.policyDraft }, response: f.approvalSummary },
  requestSweep: {
    body: { chainId: "eip155:8453", asset: "native", to: f.sweep.to },
    response: { ...f.approvalSummary, kind: "sweep-wallet" },
  },
  requestRetireWallet: {
    body: { destroyAfter: 1_700_604_800 },
    response: { ...f.approvalSummary, kind: "retire-wallet" },
  },
  cancelRetireWallet: {
    body: {},
    response: { ...f.wallet, lifecycle: { state: "held", destroyAfter: null } },
  },
  proposeMandate: {
    body: f.mandateDraft,
    response: { ...f.approvalSummary, kind: "grant-mandate" },
  },
  listMandates: {
    query: { walletId: f.WALLET, agentId: f.AGENT, status: "active", cursor: "c1" },
    response: { items: [f.mandateSummary], nextCursor: null },
  },
  getMandate: { response: f.mandateDetail },
  revokeMandate: {
    body: {},
    response: {
      ...f.mandateSummary,
      status: "revoked",
      endedReason: "revoked",
      revokedAt: 1_700_000_100,
    },
  },
  listApprovals: {
    query: { status: "pending" },
    response: { items: [f.approvalSummary], nextCursor: "c1" },
  },
  getApproval: { response: f.approvalDetail },
  collectApproval: { body: {}, response: f.approvalDetail },
  reject: {
    body: {},
    response: { ...f.approvalDetail, status: "rejected", rejectedBy: f.user, confirmUrl: null },
  },
  requestSweepCancel: {
    body: {},
    response: { ...f.approvalSummary, id: f.CANCEL_APPROVAL, kind: "cancel-transaction" },
  },
  listIntents: {
    query: { cursor: "c1", mandateId: f.MANDATE },
    response: { items: [f.intentSummary], nextCursor: null, unreadable: 0 },
  },
  getIntent: { response: f.intentDetail },
  speedUp: { body: {}, response: f.intentDetail },
  cancelOrder: { body: {}, response: f.orderDetail },
  requestCancel: {
    body: {},
    response: { ...f.approvalSummary, id: f.CANCEL_APPROVAL, kind: "cancel-transaction" },
  },
  listAudit: { query: {}, response: { items: [f.auditEvent], nextCursor: null } },
  verifyAudit: { response: { ok: true, checked: 1, brokenAt: null } },
  listSignerDecisions: { query: { after: "3" }, response: { items: [f.signerDecision] } },
  getPushConfig: {
    response: { enabled: true, applicationServerKey: f.pushSubscriptionInput.keys.p256dh.slice(1) },
  },
  listPushSubscriptions: { response: { items: [f.pushSubscription] } },
  addPushSubscription: { body: f.pushSubscriptionInput, response: f.pushSubscription },
  removePushSubscription: { response: {} },
  getNotificationPreferences: { response: f.notificationPreferences },
  setNotificationPreferences: {
    body: { ...f.notificationPreferences, quietHours: null },
    response: { ...f.notificationPreferences, quietHours: null },
  },
  setNotificationDetail: {
    body: { detail: "summary" },
    response: { ...f.workspace, notificationDetail: "summary" },
  },
};

function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? "");
}

describe("route contract", () => {
  it("every route has an example", () => {
    expect(Object.keys(examples).sort()).toEqual(Object.keys(routes).sort());
  });

  // SAFETY: `routes` is a `const` object literal, so its own keys are exactly `RouteName`.
  it.each(Object.keys(routes) as RouteName[])(
    "%s: body, query and response match their schemas",
    (name) => {
      const route = routes[name];
      const example = examples[name];

      if (route.body === null) expect(example.body).toBeUndefined();
      else expect(route.body.parse(example.body)).toEqual(example.body);

      if (route.query === null) expect(example.query).toBeUndefined();
      else expect(route.query.parse(example.query)).toEqual(example.query);
      expect(route.response.parse(example.response)).toEqual(example.response);
    },
  );

  it("no route has two parameters with the same name, and GET/DELETE carry no body", () => {
    for (const route of Object.values(routes)) {
      const names = paramNames(route.path);
      expect(new Set(names).size).toBe(names.length);

      if (route.method !== "POST") expect(route.body).toBeNull();
    }
  });

  it("every error code has an HTTP status in the error range", () => {
    for (const status of Object.values(apiErrorStatus)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it("names shown next to approval cards refuse control and bidirectional characters", () => {
    const names = [
      routes.createWorkspace.body,
      routes.createAgent.body,
      routes.createTreasury.body,
    ] as const;

    for (const hostile of ["Pay\u202eevil", "line\nbreak", "tab\there", "mark\u200f", "\u2066x"]) {
      expect(names[0].safeParse({ name: hostile }).success).toBe(false);
      expect(names[1].safeParse({ name: hostile }).success).toBe(false);
      expect(names[2].safeParse({ label: hostile }).success).toBe(false);
      expect(DisplayName.safeParse(hostile).success).toBe(false);
      expect(
        routes.finishAddPasskey.body.safeParse({
          ceremonyId: f.ceremony.ceremonyId,
          response: f.registrationResponse,
          label: hostile,
        }).success,
      ).toBe(false);
      expect(
        routes.addPushSubscription.body.safeParse({ ...f.pushSubscriptionInput, label: hostile })
          .success,
      ).toBe(false);
    }

    expect(names[0].safeParse({ name: "Ops — café 東京" }).success).toBe(true);
  });

  it("approval subjects refuse fields of another kind", () => {
    expect(ApprovalSubject.safeParse({ kind: "resume-workspace", proposed: 2 }).success).toBe(
      false,
    );
    expect(ApprovalDetail.safeParse({ ...f.approvalDetail, extra: 1 }).success).toBe(false);
  });

  it("a grant's subject carries the exact mandate, and a draft the protocol refuses does not parse", () => {
    expect(ApprovalDetail.parse(f.grantApprovalDetail)).toEqual(f.grantApprovalDetail);
    const zero = "0x0000000000000000000000000000000000000000";
    const subject = f.grantApprovalDetail.subject;
    expect(
      ApprovalSubject.safeParse({ ...subject, mandate: { ...f.mandate, recipients: [zero] } })
        .success,
    ).toBe(false);
    const draft = routes.proposeMandate.body;
    expect(draft.safeParse({ ...f.mandateDraft, recipients: [] }).success).toBe(false);
    expect(draft.safeParse({ ...f.mandateDraft, purpose: "pay\u202eevil" }).success).toBe(false);
    expect(draft.safeParse({ ...f.mandateDraft, windowSeconds: 60 }).success).toBe(false);
    expect(draft.safeParse({ ...f.mandateDraft, workspaceId: f.WS, notBefore: 0 }).success).toBe(
      false,
    );
  });

  it("one use of a mandate is never an approval people see", () => {
    expect(
      ApprovalSummary.safeParse({ ...f.approvalSummary, kind: "mandate-use", threshold: 0 })
        .success,
    ).toBe(false);
  });

  it("the confirmation link the UI turns into a link is only ever an http or https address", () => {
    for (const hostile of ["javascript:alert(1)", "data:text/html,<b>x</b>", "/a/relative"]) {
      expect(ApprovalDetail.safeParse({ ...f.approvalDetail, confirmUrl: hostile }).success).toBe(
        false,
      );
    }
  });

  it("a push subscription is an https endpoint of at most 2048 characters with well-formed keys", () => {
    const body = routes.addPushSubscription.body;
    const input = f.pushSubscriptionInput;

    const refused = [
      { ...input, endpoint: "http://fcm.googleapis.com/fcm/send/x" },
      { ...input, endpoint: "javascript:alert(1)" },
      { ...input, endpoint: `https://fcm.googleapis.com/${"a".repeat(2048)}` },
      { ...input, keys: { ...input.keys, p256dh: input.keys.p256dh.slice(0, -1) } },
      { ...input, keys: { ...input.keys, p256dh: `A${input.keys.p256dh.slice(1)}` } },
      { ...input, keys: { ...input.keys, auth: "AAAA" } },
      { ...input, label: "x".repeat(41) },
      { ...input, label: "Phone\u202e" },
      { ...input, expirationTime: null },
    ];

    for (const value of refused) expect(body.safeParse(value).success).toBe(false);
    // Some browsers pad their keys.
    const padded = { p256dh: `${input.keys.p256dh}=`, auth: `${input.keys.auth}==` };
    expect(body.safeParse({ ...input, keys: padded }).success).toBe(true);
    expect(body.safeParse({ endpoint: input.endpoint, keys: input.keys }).success).toBe(true);
  });

  it("quiet hours are two different HH:MM times in a known time zone; each workspace is set once", () => {
    const body = routes.setNotificationPreferences.body;
    const prefs = f.notificationPreferences;
    const quiet = (quietHours: JsonValue) => body.safeParse({ ...prefs, quietHours }).success;
    expect(quiet({ start: "23:30", end: "06:15", timeZone: "America/New_York" })).toBe(true);
    expect(quiet({ start: "00:00", end: "23:59", timeZone: "UTC" })).toBe(true);
    expect(quiet({ start: "24:00", end: "07:00", timeZone: "UTC" })).toBe(false);
    expect(quiet({ start: "7:00", end: "08:00", timeZone: "UTC" })).toBe(false);
    expect(quiet({ start: "22:00", end: "22:00", timeZone: "UTC" })).toBe(false);
    expect(quiet({ start: "22:00", end: "07:00", timeZone: "Mars/Olympus_Mons" })).toBe(false);
    expect(quiet({ start: "22:00", end: "07:00" })).toBe(false);
    const twice = [...prefs.workspaces, ...prefs.workspaces];
    expect(body.safeParse({ ...prefs, workspaces: twice }).success).toBe(false);
  });

  it("a cancel's subject names the transaction it stops, with every attempt and why it is stuck", () => {
    expect(ApprovalDetail.parse(f.cancelApprovalDetail)).toEqual(f.cancelApprovalDetail);
    const subject = f.cancelApprovalDetail.subject;
    // The envelope a passkey approves names the target by its approval id, never by a hash.
    expect(
      ApprovalDetail.safeParse({
        ...f.cancelApprovalDetail,
        envelope: { ...f.cancelApprovalDetail.envelope, targetApprovalId: f.CANCEL_APPROVAL },
      }).success,
    ).toBe(false);
    const transaction = f.transactionInfo;

    for (const broken of [
      { ...transaction, attempts: [] },
      { ...transaction, stuckReason: "gas_too_low" },
      { ...transaction, attempts: [{ ...transaction.attempts[0], status: "replaced" }] },
      { ...transaction, canCancel: undefined },
    ]) {
      expect(ApprovalSubject.safeParse({ ...subject, transaction: broken }).success).toBe(false);
    }
  });

  it("a lifecycle state that contradicts itself does not parse, and a deletion names its wallets", () => {
    expect(ApprovalDetail.parse(f.deleteApprovalDetail)).toEqual(f.deleteApprovalDetail);

    const wallet = (lifecycle: JsonValue) =>
      WalletSummary.safeParse({ ...f.wallet, lifecycle }).success;

    expect(wallet({ state: "retiring", destroyAfter: 1_700_604_800 })).toBe(true);
    expect(wallet({ state: "destroyed", destroyAfter: 1_700_604_800 })).toBe(true);
    expect(wallet({ state: "held", destroyAfter: null })).toBe(true);
    expect(wallet({ state: "retiring", destroyAfter: null })).toBe(false);
    expect(wallet({ state: "held", destroyAfter: 1_700_604_800 })).toBe(false);
    expect(wallet({ state: "removed", destroyAfter: null })).toBe(false);

    const workspace = (lifecycle: JsonValue) =>
      WorkspaceSummary.safeParse({ ...f.workspaceSummary, lifecycle }).success;

    expect(workspace({ state: "deleting", destroyAfter: 1_700_604_800, deletedAt: null })).toBe(
      true,
    );
    expect(workspace({ state: "deleting", destroyAfter: null, deletedAt: null })).toBe(false);
    expect(
      workspace({ state: "deleting", destroyAfter: 1_700_604_800, deletedAt: 1_700_604_900 }),
    ).toBe(false);
    expect(
      workspace({ state: "deleted", destroyAfter: 1_700_604_800, deletedAt: 1_700_604_900 }),
    ).toBe(true);
    // A deletion is always for a time, and the preflight never claims to speak for the signer.
    expect(routes.requestDeleteWorkspace.body.safeParse({}).success).toBe(false);
    expect(DeletionPreflight.safeParse({ ...f.deletionPreflight, source: "signer" }).success).toBe(
      false,
    );
    expect(
      DeletionPreflight.safeParse({ ...f.deletionPreflight, blockers: ["keys_destroyed"] }).success,
    ).toBe(false);
  });

  it("a template carries no mandate and points requesters only at its own agents' wallets", () => {
    const template = f.workspaceTemplate;
    expect(WorkspaceTemplate.parse(template)).toEqual(template);
    const [agentWallet, treasury] = template.wallets;

    if (!agentWallet?.policy || !treasury) throw new Error("fixture changed");

    const withPolicy = (requesters: string[]) => ({
      ...template,
      wallets: [{ ...agentWallet, policy: { ...agentWallet.policy, requesters } }, treasury],
    });

    // A requester is a ref of a template wallet with an agent, never an id or the treasury.
    expect(WorkspaceTemplate.safeParse(withPolicy(["w2"])).success).toBe(false);
    expect(WorkspaceTemplate.safeParse(withPolicy([f.AGENT])).success).toBe(false);
    expect(WorkspaceTemplate.safeParse(withPolicy(["w9"])).success).toBe(false);
    // Strict: nothing else rides along, a mandate least of all.
    expect(WorkspaceTemplate.safeParse({ ...template, mandates: [] }).success).toBe(false);
    expect(
      WorkspaceTemplate.safeParse({
        ...template,
        wallets: [{ ...treasury, address: "0x1111111111111111111111111111111111111111" }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceTemplate.safeParse({ ...template, wallets: [treasury, { ...treasury, ref: "w3" }] })
        .success,
    ).toBe(false);
    expect(
      WorkspaceTemplate.safeParse({
        ...template,
        wallets: [{ ...treasury, agent: { name: "bot" } }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceTemplate.safeParse({
        ...template,
        members: [...template.members, ...template.members],
      }).success,
    ).toBe(false);
  });

  it("a sweep's subject carries the exact sweep, and a sweep the protocol refuses does not parse", () => {
    expect(ApprovalDetail.parse(f.sweepApprovalDetail)).toEqual(f.sweepApprovalDetail);
    const subject = f.sweepApprovalDetail.subject;
    const zero = "0x0000000000000000000000000000000000000000";
    expect(ApprovalSubject.safeParse({ ...subject, sweep: { ...f.sweep, to: zero } }).success).toBe(
      false,
    );
    expect(ApprovalSubject.safeParse({ ...subject, destination: "anywhere" }).success).toBe(false);
    // A sweep goes to an address, never to "whatever the server picks".
    expect(
      routes.requestSweep.body.safeParse({ chainId: "eip155:8453", asset: "native" }).success,
    ).toBe(false);
  });
});

type Seen = { url: string; init: RequestInit };

function fakeClient(status: number, payload: string | null, headers?: Record<string, string>) {
  const seen: Seen[] = [];

  const fetch: typeof globalThis.fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    seen.push({ url: String(input), init });

    return new Response(payload, { status });
  };

  const options: ApiClientOptions = { baseUrl: "https://os.example.com/", fetch };

  if (headers) options.headers = headers;

  return { client: createApiClient(options), seen };
}

describe("api client", () => {
  // A value per parameter that would change the path if it were not encoded.
  const hostile = "a/../b?c=d#e f";

  // SAFETY: `routes` is a `const` object literal, so its own keys are exactly `RouteName`.
  it.each(Object.keys(routes) as RouteName[])(
    "%s: fills and encodes every path parameter",
    async (name) => {
      const route = routes[name];
      const example = examples[name];
      const { client, seen } = fakeClient(200, JSON.stringify(example.response));
      const params = Object.fromEntries(paramNames(route.path).map((p) => [p, `${p}-${hostile}`]));
      // SAFETY: deliberately unchecked: `name` is chosen at run time, so no single `RouteInput`
      // applies; `params` names every parameter of the route's path and the example's body and
      // query are the ones the contract test above parses with the route's own schemas.
      await client.call(name, { params, body: example.body, query: example.query } as never);
      const sent = seen[0];

      if (!sent) throw new Error("no request");
      const url = new URL(sent.url);
      expect(url.origin).toBe("https://os.example.com");
      expect(url.pathname).not.toContain(":");
      expect(url.hash).toBe("");
      let expected: string = route.path;

      for (const [key, value] of Object.entries(params)) {
        expected = expected.replace(`:${key}`, encodeURIComponent(value));
      }

      expect(url.pathname).toBe(expected);
      expect(sent.init.method).toBe(route.method);

      if (route.body === null) {
        expect(sent.init.body).toBeUndefined();
      } else {
        expect(JSON.parse(String(sent.init.body))).toEqual(example.body);
        expect(new Headers(sent.init.headers).get("content-type")).toBe("application/json");
      }
    },
  );

  it("drops undefined query values and encodes the rest", async () => {
    const { client, seen } = fakeClient(200, JSON.stringify(examples.listApprovals.response));
    await client.call("listApprovals", {
      params: { workspaceId: f.WS },
      query: { status: undefined, cursor: "a&b=c" },
    });
    expect(new URL(seen[0]?.url ?? "").search).toBe("?cursor=a%26b%3Dc");
    await client.call("listApprovals", { params: { workspaceId: f.WS } });
    expect(seen[1]?.url).toBe(`https://os.example.com/api/v1/workspaces/${f.WS}/approvals`);
  });

  it("sends configured headers", async () => {
    const { client, seen } = fakeClient(200, JSON.stringify(f.session), { cookie: "sid=1" });
    await client.call("getSession");
    expect(new Headers(seen[0]?.init.headers).get("cookie")).toBe("sid=1");
  });

  it("surfaces an error body as ApiError with code, status and detail", async () => {
    const body = { error: { code: "signer_refused", message: "refused", detail: "nonce_reused" } };
    const { client } = fakeClient(422, JSON.stringify(body));

    const error = await client
      .call("getApproval", { params: { approvalId: f.APPROVAL } })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "signer_refused",
      status: 422,
      detail: "nonce_reused",
      message: "refused",
    });
  });

  it("a non-JSON or unknown error body becomes an internal ApiError with the real status", async () => {
    const html = fakeClient(502, "<html>bad gateway</html>");
    await expect(html.client.call("getSession")).rejects.toMatchObject({
      code: "internal",
      status: 502,
    });
    const odd = fakeClient(400, JSON.stringify({ error: { code: "nope", message: "x" } }));
    await expect(odd.client.call("getSession")).rejects.toMatchObject({
      code: "internal",
      status: 400,
    });
  });

  it("rejects a malformed success body", async () => {
    const { client } = fakeClient(200, JSON.stringify({ ...f.session, user: { id: "nope" } }));
    await expect(client.call("getSession")).rejects.not.toBeInstanceOf(ApiError);
  });
});
