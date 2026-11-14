import { describe, expect, it } from "vitest";
import {
  ApiError,
  ApprovalDetail,
  ApprovalSubject,
  apiErrorStatus,
  createApiClient,
  DisplayName,
  type RouteName,
  routes,
} from "../src/index.ts";
import * as f from "./fixtures.ts";

const approvalsList = { approvals: [f.approvalSummary] };

/**
 * One realistic request body and response per route. A route missing here fails the coverage
 * test below, so a new endpoint cannot ship without its shapes being exercised once.
 */
const examples: { [N in RouteName]: { body?: unknown; query?: unknown; response: unknown } } = {
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
  listWorkspaces: { response: { items: [f.workspaceSummary] } },
  createWorkspace: { body: { name: "Acme" }, response: f.workspace },
  getWorkspace: { response: f.workspace },
  pauseWorkspace: { body: {}, response: { ...f.workspace, paused: true } },
  requestResume: { body: {}, response: f.approvalSummary },
  requestAdminThreshold: { body: { adminThreshold: 2 }, response: f.approvalSummary },
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
  listApprovals: {
    query: { status: "pending" },
    response: { items: [f.approvalSummary], nextCursor: "c1" },
  },
  getApproval: { response: f.approvalDetail },
  startApproval: { body: {}, response: { options: { challenge: f.approvalDetail.challenge } } },
  approve: { body: { response: f.assertionResponse }, response: f.approvalDetail },
  collectApproval: { body: {}, response: f.approvalDetail },
  reject: {
    body: {},
    response: { ...f.approvalDetail, status: "rejected", rejectedBy: f.user, confirmUrl: null },
  },
  listIntents: {
    query: { cursor: "c1" },
    response: { items: [f.intentSummary], nextCursor: null },
  },
  getIntent: { response: f.intentDetail },
  listAudit: { query: {}, response: { items: [f.auditEvent], nextCursor: null } },
  verifyAudit: { response: { ok: true, checked: 1, brokenAt: null } },
  listSignerDecisions: { query: { after: "3" }, response: { items: [f.signerDecision] } },
};

function paramNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] ?? "");
}

describe("route contract", () => {
  it("every route has an example", () => {
    expect(Object.keys(examples).sort()).toEqual(Object.keys(routes).sort());
  });

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
    }
    expect(names[0].safeParse({ name: "Ops — café 東京" }).success).toBe(true);
  });

  it("approval subjects refuse fields of another kind", () => {
    expect(ApprovalSubject.safeParse({ kind: "resume-workspace", proposed: 2 }).success).toBe(
      false,
    );
    expect(ApprovalDetail.safeParse({ ...f.approvalDetail, extra: 1 }).success).toBe(false);
  });

  it("the confirmation link the UI turns into a link is only ever an http or https address", () => {
    for (const hostile of ["javascript:alert(1)", "data:text/html,<b>x</b>", "/a/relative"]) {
      expect(ApprovalDetail.safeParse({ ...f.approvalDetail, confirmUrl: hostile }).success).toBe(
        false,
      );
    }
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
  const client = createApiClient({
    baseUrl: "https://os.example.com/",
    ...(headers ? { headers } : {}),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return new Response(payload, { status });
    }) as typeof globalThis.fetch,
  });
  return { client, seen };
}

describe("api client", () => {
  // A value per parameter that would change the path if it were not encoded.
  const hostile = "a/../b?c=d#e f";

  it.each(Object.keys(routes) as RouteName[])(
    "%s: fills and encodes every path parameter",
    async (name) => {
      const route = routes[name];
      const example = examples[name];
      const { client, seen } = fakeClient(200, JSON.stringify(example.response));
      const params = Object.fromEntries(paramNames(route.path).map((p) => [p, `${p}-${hostile}`]));
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
      .catch((e: unknown) => e);
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
