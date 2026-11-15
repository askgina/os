import { describe, expect, it } from "vitest";
import { mandateHash } from "../src/index.ts";
import {
  CONFIRM_TOKEN_HEADER,
  createConfirmClient,
  createSignerClient,
  MAX_CLOCK_SKEW_SECONDS,
  SIGNATURE_HEADER,
  type SignedRequestParts,
  SignerError,
  signerRoutes,
  signRequest,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
} from "../src/signer/index.ts";
import {
  APPROVAL,
  approveIntent,
  cancelTransaction,
  DESTROY_DELAY,
  deleteWorkspace,
  grantMandate,
  intent,
  MANDATE,
  mandate,
  retireWallet,
  sweep,
  sweepWallet,
  T0,
  TARGET_APPROVAL,
  venueIntent,
  WALLET,
  WALLET_ADDRESS,
  WS,
} from "./fixtures.ts";

const SECRET = new Uint8Array(32).fill(7);
const encode = (text: string) => new TextEncoder().encode(text);

describe("request signatures", () => {
  const parts: SignedRequestParts = {
    method: "POST",
    pathWithQuery: "/v1/wallets/wal_x/policy?dry=1",
    timestamp: T0,
    body: encode('{"a":1}'),
  };
  const signature = signRequest(SECRET, parts);
  const check = (changed: Partial<SignedRequestParts & { now: number; signature: string }>) =>
    verifyRequestSignature(SECRET, { ...parts, signature, now: T0, ...changed });

  it("round trips, with the method case-insensitive", () => {
    expect(check({})).toBe(true);
    expect(check({ method: "post" })).toBe(true);
  });

  it("any change to what was signed fails", () => {
    expect(check({ method: "PUT" })).toBe(false);
    expect(check({ pathWithQuery: "/v1/wallets/wal_y/policy?dry=1" })).toBe(false);
    expect(check({ pathWithQuery: "/v1/wallets/wal_x/policy?dry=0" })).toBe(false);
    expect(check({ pathWithQuery: "/v1/wallets/wal_x/policy" })).toBe(false);
    expect(check({ timestamp: T0 + 1, now: T0 + 1 })).toBe(false);
    expect(check({ body: encode('{"a":2}') })).toBe(false);
    expect(check({ body: new Uint8Array() })).toBe(false);
  });

  it("another secret fails", () => {
    expect(
      verifyRequestSignature(new Uint8Array(32).fill(8), { ...parts, signature, now: T0 }),
    ).toBe(false);
  });

  it("stale and future timestamps fail just past the window", () => {
    expect(check({ now: T0 + MAX_CLOCK_SKEW_SECONDS })).toBe(true);
    expect(check({ now: T0 + MAX_CLOCK_SKEW_SECONDS + 1 })).toBe(false);
    expect(check({ now: T0 - MAX_CLOCK_SKEW_SECONDS })).toBe(true);
    expect(check({ now: T0 - MAX_CLOCK_SKEW_SECONDS - 1 })).toBe(false);
  });

  it("malformed signatures and timestamps fail without throwing", () => {
    expect(check({ signature: signature.toUpperCase() })).toBe(false);
    expect(check({ signature: signature.slice(2) })).toBe(false);
    expect(check({ signature: "" })).toBe(false);
    expect(check({ timestamp: T0 + 0.5 })).toBe(false);
    expect(check({ timestamp: Number.NaN })).toBe(false);
  });

  it("a secret shorter than 32 bytes is refused", () => {
    expect(() => signRequest(new Uint8Array(31), parts)).toThrow(RangeError);
    expect(signRequest(new Uint8Array(32), parts)).toMatch(/^[0-9a-f]{64}$/);
  });
});

type Recorded = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string) => { status: number; body: unknown; raw?: string }) {
  const calls: Recorded[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body, raw } = respond(url);
    return new Response(raw ?? JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const workspaceState = {
  workspaceId: WS,
  adminThreshold: 1,
  paused: false,
  approvers: [],
  state: "active",
  destroyAfter: null,
  minDestroyDelaySeconds: DESTROY_DELAY,
};
const approvalState = {
  approvalId: APPROVAL,
  state: "unknown",
  transactionHash: null,
  attempts: [],
  cloid: null,
};

function client(respond: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(respond);
  return {
    ...fake,
    signer: createSignerClient({
      baseUrl: "http://signer:8787/",
      secret: SECRET,
      fetch: fake.fetch,
      now: () => T0,
    }),
  };
}

function verifyRecorded(call: Recorded, secret: Uint8Array = SECRET): boolean {
  const url = new URL(call.url);
  const headers = new Headers(call.init.headers);
  const body = call.init.body;
  return verifyRequestSignature(secret, {
    method: call.init.method ?? "GET",
    pathWithQuery: `${url.pathname}${url.search}`,
    timestamp: Number(headers.get(TIMESTAMP_HEADER)),
    body: body instanceof Uint8Array ? body : new Uint8Array(),
    signature: headers.get(SIGNATURE_HEADER) ?? "",
    now: T0,
  });
}

describe("signer client", () => {
  it("builds paths, encodes parameters and signs what it sends", async () => {
    const { signer, calls } = client(() => ({ status: 200, body: workspaceState }));
    await signer.getWorkspace(WS);
    await signer.pauseWorkspace(WS);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", `http://signer:8787/v1/workspaces/${WS}`],
      ["POST", `http://signer:8787/v1/workspaces/${WS}/pause`],
    ]);
    expect(calls[0]?.init.body).toBeUndefined();
    for (const call of calls) expect(verifyRecorded(call)).toBe(true);
  });

  it("a parameter cannot escape its path segment", async () => {
    const { signer, calls } = client(() => ({ status: 200, body: approvalState }));
    await signer.getApproval("apr_../../v1/sign?x=1" as typeof APPROVAL);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe(
      "/v1/approvals/apr_..%2F..%2Fv1%2Fsign%3Fx%3D1",
    );
  });

  it("puts paging into the query string and signs it", async () => {
    const { signer, calls } = client(() => ({ status: 200, body: { decisions: [] } }));
    await signer.listDecisions(WS, { after: 5, limit: 10 });
    await signer.listDecisions(WS);
    expect(calls[0]?.url).toBe(`http://signer:8787/v1/workspaces/${WS}/decisions?after=5&limit=10`);
    expect(calls[1]?.url).toBe(`http://signer:8787/v1/workspaces/${WS}/decisions`);
    expect(calls.every((call) => verifyRecorded(call))).toBe(true);
  });

  it("a signature over one request does not verify for another", async () => {
    const { signer, calls } = client(() => ({ status: 200, body: workspaceState }));
    await signer.getWorkspace(WS);
    const [call] = calls;
    if (!call) throw new Error("no call");
    expect(
      verifyRecorded({ ...call, url: call.url.replace(WS, `ws_01jd000000000000000000000z`) }),
    ).toBe(false);
  });

  it("sends the request body as JSON", async () => {
    const { signer, calls } = client(() => ({ status: 200, body: workspaceState }));
    const authorization = { envelope: approveIntent(), assertions: [] };
    await signer.resumeWorkspace(WS, authorization as never);
    const body = calls[0]?.init.body;
    expect(JSON.parse(new TextDecoder().decode(body as Uint8Array))).toEqual({ authorization });
  });

  it("uses each route's method and path", async () => {
    const { signer, calls } = client((url) => ({
      status: 200,
      body: url.endsWith("/healthz")
        ? { ok: true, version: "0.1.0" }
        : url.includes("/approvals/")
          ? approvalState
          : workspaceState,
    }));
    await signer.health();
    await signer.revokeApproval(APPROVAL, WS);
    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      `${signerRoutes.health.method} ${signerRoutes.health.path}`,
      `POST /v1/approvals/${APPROVAL}/revoke`,
    ]);
    // The workspace travels in the body so the signer can record the revocation in its log.
    const body = calls[1]?.init.body as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ workspaceId: WS });
  });

  it("sends a sweep to its wallet's path, with the sweep and its authorization in the body", async () => {
    const signed = {
      approvalId: APPROVAL,
      walletId: WALLET,
      from: "0x1111111111111111111111111111111111111111",
      signedTransaction: "0x02",
      transactionHash: `0x${"ab".repeat(32)}`,
    };
    const { signer, calls } = client(() => ({ status: 200, body: signed }));
    const request = {
      sweep: sweep(),
      authorization: { envelope: sweepWallet(), assertions: [] },
      transaction: { nonce: 0, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
    };
    expect(await signer.sweep(WALLET, request)).toEqual(signed);
    const [call] = calls;
    expect(`${call?.init.method} ${new URL(call?.url ?? "").pathname}`).toBe(
      `POST /v1/wallets/${WALLET}/sweep`,
    );
    expect(JSON.parse(new TextDecoder().decode(call?.init.body as Uint8Array))).toEqual(request);
    expect(verifyRecorded(call as Recorded)).toBe(true);
  });

  it("sends each mandate call to its route, signed, with its body, and parses the answer", async () => {
    const state = {
      mandate: mandate(),
      mandateHash: mandateHash(mandate()),
      status: "active",
      grantApprovalId: APPROVAL,
      grantedAt: T0,
      grantedBy: ["usr_01jd0000000000000000000006"],
      revokedAt: null,
      revokedReason: null,
      usage: { uses: 0, assets: [] },
    };
    const signed = {
      approvalId: APPROVAL,
      walletId: WALLET,
      from: "0x1111111111111111111111111111111111111111",
      signedTransaction: "0x02",
      transactionHash: `0x${"ab".repeat(32)}`,
    };
    const { signer, calls } = client((url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/sign")) return { status: 200, body: signed };
      if (path.endsWith("/mandates") && path.startsWith("/v1/wallets/")) {
        return { status: 200, body: { mandates: [state] } };
      }
      return { status: 200, body: state };
    });
    const grant = {
      mandate: mandate(),
      authorization: { envelope: grantMandate(), assertions: [] },
    };
    const use = {
      approvalId: APPROVAL,
      intent: intent(),
      transaction: { nonce: 0, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
    };

    expect(await signer.grantMandate(MANDATE, grant as never)).toEqual(state);
    expect(await signer.getMandate(MANDATE)).toEqual(state);
    expect(await signer.listMandates(WALLET)).toEqual({ mandates: [state] });
    expect(await signer.revokeMandate(MANDATE, WS)).toEqual(state);
    expect(await signer.signUnderMandate(MANDATE, use)).toEqual(signed);

    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      `PUT /v1/mandates/${MANDATE}`,
      `GET /v1/mandates/${MANDATE}`,
      `GET /v1/wallets/${WALLET}/mandates`,
      `POST /v1/mandates/${MANDATE}/revoke`,
      `POST /v1/mandates/${MANDATE}/sign`,
    ]);
    for (const name of [
      "grantMandate",
      "getMandate",
      "listMandates",
      "revokeMandate",
      "signUnderMandate",
    ] as const) {
      expect(signerRoutes[name].scope).toBe("control");
    }
    for (const call of calls) expect(verifyRecorded(call)).toBe(true);
    const body = (call: Recorded | undefined) =>
      call?.init.body === undefined
        ? undefined
        : JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array));
    expect(calls.map(body)).toEqual([grant, undefined, undefined, { workspaceId: WS }, use]);
  });

  it("the client signs reprice and cancel requests like every other route", async () => {
    const attempted = {
      approvalId: TARGET_APPROVAL,
      walletId: WALLET,
      from: "0x1111111111111111111111111111111111111111",
      attempt: {
        attempt: 1,
        kind: "reprice",
        transactionHash: `0x${"ab".repeat(32)}`,
        gas: "21000",
        maxFeePerGas: "3",
        maxPriorityFeePerGas: "2",
        signedAt: T0,
      },
      signedTransaction: "0x02",
    };
    const { signer, calls } = client(() => ({ status: 200, body: attempted }));
    const fees = { attempt: 1, maxFeePerGas: "3", maxPriorityFeePerGas: "2" };
    const reprice = { intent: intent(), envelope: approveIntent(), ...fees };
    const byMandate = { intent: intent(), mandateId: MANDATE, ...fees };
    const cancel = {
      authorization: { envelope: cancelTransaction(), assertions: [] },
      ...fees,
    };

    expect(await signer.reprice(TARGET_APPROVAL, reprice)).toEqual(attempted);
    expect(await signer.reprice(TARGET_APPROVAL, byMandate)).toEqual(attempted);
    expect(await signer.cancelTransaction(TARGET_APPROVAL, cancel)).toEqual(attempted);
    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      `POST /v1/approvals/${TARGET_APPROVAL}/reprice`,
      `POST /v1/approvals/${TARGET_APPROVAL}/reprice`,
      `POST /v1/approvals/${TARGET_APPROVAL}/cancel`,
    ]);
    expect([signerRoutes.reprice.scope, signerRoutes.cancelTransaction.scope]).toEqual([
      "control",
      "control",
    ]);
    for (const call of calls) expect(verifyRecorded(call)).toBe(true);
    expect(
      calls.map((call) => JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array))),
    ).toEqual([reprice, byMandate, cancel]);

    // A refusal keeps its code; an answer that is not an attempt is not passed on.
    const refusing = client(() => ({
      status: 403,
      body: { error: { code: "fee_not_raised", message: "raise both fees" } },
    }));
    await expect(refusing.signer.reprice(TARGET_APPROVAL, reprice)).rejects.toMatchObject({
      name: "SignerError",
      code: "fee_not_raised",
      status: 403,
    });
    const odd = client(() => ({
      status: 200,
      body: { ...attempted, attempt: { ...attempted.attempt, kind: "original" } },
    }));
    await expect(odd.signer.reprice(TARGET_APPROVAL, reprice)).rejects.not.toBeInstanceOf(
      SignerError,
    );
  });

  it("sends venue signing and cancels to their routes, signed, and keeps the body's key order", async () => {
    const cloid = `0x${"12".repeat(16)}` as const;
    const signature = { r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}`, v: 27 };
    // The answer's keys out of the venue's order: the parsed body puts them back.
    const order = {
      approvalId: APPROVAL,
      walletId: WALLET,
      network: "hyperliquid:testnet",
      account: WALLET_ADDRESS,
      cloid,
      request: {
        expiresAfter: T0 * 1000 + 60_000,
        vaultAddress: null,
        signature,
        nonce: T0 * 1000,
        action: {
          grouping: "na",
          orders: [
            {
              c: cloid,
              t: { limit: { tif: "Ioc" } },
              r: false,
              s: "0.01",
              p: "65000",
              b: true,
              a: 3,
            },
          ],
          type: "order",
        },
      },
    };
    const cancelled = {
      approvalId: APPROVAL,
      cloid,
      request: {
        action: { type: "cancelByCloid", cancels: [{ asset: 3, cloid }] },
        nonce: T0 * 1000 + 1,
        signature,
        vaultAddress: null,
        expiresAfter: T0 * 1000 + 60_001,
      },
    };
    const { signer, calls } = client((url) => ({
      status: 200,
      body: url.endsWith("/cancel") ? cancelled : order,
    }));
    const request = {
      intent: venueIntent(),
      authorization: { envelope: approveIntent(), assertions: [] },
    };
    const signed = await signer.signVenue(request as never);
    expect(JSON.stringify(signed.request)).toBe(
      JSON.stringify({
        action: {
          type: "order",
          orders: [
            {
              a: 3,
              b: true,
              p: "65000",
              s: "0.01",
              r: false,
              t: { limit: { tif: "Ioc" } },
              c: cloid,
            },
          ],
          grouping: "na",
        },
        nonce: T0 * 1000,
        signature,
        vaultAddress: null,
        expiresAfter: T0 * 1000 + 60_000,
      }),
    );
    expect(await signer.cancelVenueOrder(APPROVAL, WS)).toEqual(cancelled);
    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v1/venue/sign",
      `POST /v1/venue/orders/${APPROVAL}/cancel`,
    ]);
    expect([signerRoutes.signVenue.scope, signerRoutes.cancelVenueOrder.scope]).toEqual([
      "control",
      "control",
    ]);
    for (const call of calls) expect(verifyRecorded(call)).toBe(true);
    expect(
      calls.map((call) => JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array))),
    ).toEqual([request, { workspaceId: WS }]);

    // An answer the contract does not allow is not passed on: an order with another cloid, an
    // extra key in the action, or a cancel of another order.
    for (const body of [
      { ...order, cloid: `0x${"34".repeat(16)}` },
      { ...order, request: { ...order.request, action: { ...order.request.action, builder: {} } } },
      { ...order, request: { ...order.request, expiresAfter: null } },
    ]) {
      const odd = client(() => ({ status: 200, body }));
      await expect(odd.signer.signVenue(request as never)).rejects.not.toBeInstanceOf(SignerError);
    }
    const otherCancel = client(() => ({
      status: 200,
      body: { ...cancelled, cloid: `0x${"34".repeat(16)}` },
    }));
    await expect(otherCancel.signer.cancelVenueOrder(APPROVAL, WS)).rejects.not.toBeInstanceOf(
      SignerError,
    );
  });

  it("sends each retire and delete call to its route, signed, with its body, and parses the answer", async () => {
    const destroyAfter = T0 + DESTROY_DELAY;
    const retiring = {
      walletId: WALLET,
      workspaceId: WS,
      kind: "agent",
      label: "Operations",
      address: WALLET_ADDRESS,
      policy: null,
      policyHash: null,
      spent: [],
      venueSpent: [],
      state: "retiring",
      destroyAfter,
    };
    const deleting = { ...workspaceState, paused: true, state: "deleting", destroyAfter };
    const { signer, calls } = client((url) => ({
      status: 200,
      body: new URL(url).pathname.startsWith("/v1/wallets/") ? retiring : deleting,
    }));
    const retire = { envelope: retireWallet(), assertions: [] };
    const remove = { envelope: deleteWorkspace(), assertions: [] };

    expect(await signer.retireWallet(WALLET, retire as never)).toEqual(retiring);
    expect(await signer.cancelRetireWallet(WALLET, WS)).toEqual(retiring);
    expect(await signer.finalizeRetireWallet(WALLET, WS)).toEqual(retiring);
    expect(await signer.deleteWorkspace(WS, remove as never)).toEqual(deleting);
    expect(await signer.cancelDeleteWorkspace(WS)).toEqual(deleting);
    expect(await signer.finalizeDeleteWorkspace(WS)).toEqual(deleting);

    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      `POST /v1/wallets/${WALLET}/retire`,
      `POST /v1/wallets/${WALLET}/retire/cancel`,
      `POST /v1/wallets/${WALLET}/retire/finalize`,
      `POST /v1/workspaces/${WS}/delete`,
      `POST /v1/workspaces/${WS}/delete/cancel`,
      `POST /v1/workspaces/${WS}/delete/finalize`,
    ]);
    for (const call of calls) expect(verifyRecorded(call)).toBe(true);
    expect(
      calls.map((call) => JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array))),
    ).toEqual([
      { authorization: retire },
      { workspaceId: WS },
      { workspaceId: WS },
      { authorization: remove },
      {},
      {},
    ]);

    // A refusal keeps its code and status; a state that contradicts itself is not passed on.
    const early = client(() => ({
      status: 409,
      body: { error: { code: "destroy_not_due", message: "not yet" } },
    }));
    await expect(early.signer.finalizeDeleteWorkspace(WS)).rejects.toMatchObject({
      name: "SignerError",
      code: "destroy_not_due",
      status: 409,
    });
    const odd = client(() => ({ status: 200, body: { ...retiring, destroyAfter: null } }));
    await expect(odd.signer.retireWallet(WALLET, retire as never)).rejects.not.toBeInstanceOf(
      SignerError,
    );
  });

  it("passes a mandate refusal on with its code and detail, and refuses a state with another hash", async () => {
    const { signer } = client(() => ({
      status: 403,
      body: {
        error: { code: "mandate_denied", message: "denied", detail: "mandate_over_window_cap" },
      },
    }));
    const use = {
      approvalId: APPROVAL,
      intent: intent(),
      transaction: { nonce: 0, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
    };
    await expect(signer.signUnderMandate(MANDATE, use)).rejects.toMatchObject({
      name: "SignerError",
      code: "mandate_denied",
      status: 403,
      detail: "mandate_over_window_cap",
    });
    const forged = client(() => ({
      status: 200,
      body: {
        mandate: mandate(),
        mandateHash: "a".repeat(64),
        status: "active",
        grantApprovalId: APPROVAL,
        grantedAt: T0,
        grantedBy: ["usr_01jd0000000000000000000006"],
        revokedAt: null,
        revokedReason: null,
        usage: { uses: 0, assets: [] },
      },
    }));
    const error = await forged.signer.getMandate(MANDATE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SignerError);
  });

  it("gives up on a signer that never answers", async () => {
    let aborted = false;
    const hang = ((_input: string | URL | Request, init: RequestInit = {}) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal?.reason);
      });
      return promise;
    }) as typeof globalThis.fetch;
    const signer = createSignerClient({
      baseUrl: "http://signer:8787",
      secret: SECRET,
      fetch: hang,
      now: () => T0,
      timeoutMs: 50,
    });
    await expect(signer.health()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(aborted).toBe(true);
  });

  it("turns an error body into SignerError with code, status and detail", async () => {
    const { signer } = client(() => ({
      status: 403,
      body: { error: { code: "policy_denied", message: "denied", detail: "over_daily_cap" } },
    }));
    const error = await signer.getWallet(WALLET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignerError);
    expect(error).toMatchObject({
      code: "policy_denied",
      status: 403,
      detail: "over_daily_cap",
      message: "denied",
    });
  });

  it("an unrecognized error body becomes an internal SignerError", async () => {
    const { signer } = client(() => ({ status: 502, body: null, raw: "<html>bad gateway</html>" }));
    await expect(signer.getWallet(WALLET)).rejects.toMatchObject({
      name: "SignerError",
      code: "internal",
      status: 502,
    });
    const odd = client(() => ({ status: 403, body: { error: { code: "made_up", message: "x" } } }));
    await expect(odd.signer.getWallet(WALLET)).rejects.toMatchObject({
      code: "internal",
      status: 403,
    });
  });

  it("sends confirmation calls to their routes, the token only in its header, each signed with its own secret", async () => {
    const CONFIRM_SECRET = new Uint8Array(32).fill(9);
    const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
    const view = `/v1/confirm/${APPROVAL}`;
    const fake = fakeFetch((url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/confirmation"))
        return { status: 200, body: { path: `/a/${APPROVAL}#${TOKEN}` } };
      if (path.endsWith("/assertions") && !path.startsWith("/v1/confirm/")) {
        return { status: 200, body: { assertions: [] } };
      }
      if (path === view) {
        return { status: 409, body: { error: { code: "confirmation_closed", message: "closed" } } };
      }
      return {
        status: 200,
        body: {
          collected: 1,
          required: 2,
          returnUrl: `https://os.example/w/${WS}/approvals/${APPROVAL}`,
        },
      };
    });
    const control = createSignerClient({
      baseUrl: "http://signer:8787",
      secret: SECRET,
      fetch: fake.fetch,
      now: () => T0,
    });
    const confirm = createConfirmClient({
      baseUrl: "http://signer:8787",
      secret: CONFIRM_SECRET,
      fetch: fake.fetch,
      now: () => T0,
    });
    const request = {
      envelope: approveIntent(),
      subject: { kind: "approve-intent" as const, intent: intent() },
    };
    const response = {
      id: "Y3JlZC1h",
      rawId: "Y3JlZC1h",
      type: "public-key" as const,
      response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
      clientExtensionResults: {},
    };

    expect(await control.openConfirmation(APPROVAL, request)).toEqual({
      path: `/a/${APPROVAL}#${TOKEN}`,
    });
    expect(await control.listConfirmationAssertions(APPROVAL)).toEqual({ assertions: [] });
    await expect(confirm.getConfirmation(APPROVAL, TOKEN)).rejects.toMatchObject({
      code: "confirmation_closed",
      status: 409,
    });
    expect(await confirm.submitConfirmation(APPROVAL, TOKEN, response)).toMatchObject({
      collected: 1,
      required: 2,
    });

    const [opened, listed, viewed, submitted] = fake.calls as [
      Recorded,
      Recorded,
      Recorded,
      Recorded,
    ];
    expect(fake.calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
      `POST /v1/approvals/${APPROVAL}/confirmation`,
      `GET /v1/approvals/${APPROVAL}/assertions`,
      `GET ${view}`,
      `POST ${view}/assertions`,
    ]);
    for (const call of [opened, listed]) {
      expect(verifyRecorded(call, SECRET)).toBe(true);
      expect(verifyRecorded(call, CONFIRM_SECRET)).toBe(false);
      expect(new Headers(call.init.headers).has(CONFIRM_TOKEN_HEADER)).toBe(false);
    }
    for (const call of [viewed, submitted]) {
      expect(verifyRecorded(call, CONFIRM_SECRET)).toBe(true);
      expect(verifyRecorded(call, SECRET)).toBe(false);
      expect(new Headers(call.init.headers).get(CONFIRM_TOKEN_HEADER)).toBe(TOKEN);
      // The token never travels in the URL, where a proxy's access log would keep it.
      expect(call.url).not.toContain(TOKEN);
    }
    const body = (call: Recorded) =>
      JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array));
    expect(body(opened)).toEqual(request);
    expect(body(submitted)).toEqual({ response });
  });

  it("sends the possession step to its routes, the token only in its header, signed with the confirm secret", async () => {
    const CONFIRM_SECRET = new Uint8Array(32).fill(9);
    const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
    const options = {
      rpId: "os.example",
      challenge: "7voVoMiWeZwDat_WCB8R-xOqaIfjygPAYO7xmCsm8ec",
      allowCredentials: ["Y3JlZC1h"],
      userVerification: "required",
      timeoutMs: 120_000,
    };
    const fake = fakeFetch((url) =>
      url.endsWith("/possession") && fake.calls.length === 1
        ? { status: 200, body: options }
        : { status: 200, body: { fingerprint: "0123-4567-89AB-CDEF" } },
    );
    const confirm = createConfirmClient({
      baseUrl: "http://signer:8787",
      secret: CONFIRM_SECRET,
      fetch: fake.fetch,
      now: () => T0,
    });
    const response = {
      id: "Y3JlZC1h",
      rawId: "Y3JlZC1h",
      type: "public-key" as const,
      response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
      clientExtensionResults: {},
    };

    expect(await confirm.getPossession(APPROVAL, TOKEN)).toEqual(options);
    expect(await confirm.submitPossession(APPROVAL, TOKEN, response)).toEqual({
      fingerprint: "0123-4567-89AB-CDEF",
    });
    expect(fake.calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
      `${signerRoutes.getPossession.method} /v1/confirm/${APPROVAL}/possession`,
      `${signerRoutes.submitPossession.method} /v1/confirm/${APPROVAL}/possession`,
    ]);
    expect([signerRoutes.getPossession.scope, signerRoutes.submitPossession.scope]).toEqual([
      "confirm",
      "confirm",
    ]);
    for (const call of fake.calls) {
      expect(verifyRecorded(call, CONFIRM_SECRET)).toBe(true);
      expect(verifyRecorded(call, SECRET)).toBe(false);
      expect(new Headers(call.init.headers).get(CONFIRM_TOKEN_HEADER)).toBe(TOKEN);
      expect(call.url).not.toContain(TOKEN);
    }
    expect(JSON.parse(new TextDecoder().decode(fake.calls[1]?.init.body as Uint8Array))).toEqual({
      response,
    });

    // A fingerprint that is not one is not passed on.
    const odd = fakeFetch(() => ({ status: 200, body: { fingerprint: "0123-4567-89AB-CDEU" } }));
    const oddClient = createConfirmClient({
      baseUrl: "http://signer:8787",
      secret: CONFIRM_SECRET,
      fetch: odd.fetch,
      now: () => T0,
    });
    await expect(oddClient.submitPossession(APPROVAL, TOKEN, response)).rejects.toThrow();
  });

  it("rejects a malformed success body instead of returning it", async () => {
    const { signer } = client(() => ({ status: 200, body: { ...workspaceState, paused: "no" } }));
    await expect(signer.getWorkspace(WS)).rejects.not.toBeInstanceOf(SignerError);
    const extra = client(() => ({ status: 200, body: { ...approvalState, extra: 1 } }));
    await expect(extra.signer.getApproval(APPROVAL)).rejects.toThrow();
    const notJson = client(() => ({ status: 200, body: null, raw: "ok" }));
    await expect(notJson.signer.health()).rejects.toThrow();
  });
});
