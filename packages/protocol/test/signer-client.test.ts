import { describe, expect, it } from "vitest";
import {
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
import { APPROVAL, approveIntent, sweep, sweepWallet, T0, WALLET, WS } from "./fixtures.ts";

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

const workspaceState = { workspaceId: WS, adminThreshold: 1, paused: false, approvers: [] };
const approvalState = { approvalId: APPROVAL, state: "unknown", transactionHash: null };

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

function verifyRecorded(call: Recorded): boolean {
  const url = new URL(call.url);
  const headers = new Headers(call.init.headers);
  const body = call.init.body;
  return verifyRequestSignature(SECRET, {
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
    expect(calls.every(verifyRecorded)).toBe(true);
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

  it("rejects a malformed success body instead of returning it", async () => {
    const { signer } = client(() => ({ status: 200, body: { ...workspaceState, paused: "no" } }));
    await expect(signer.getWorkspace(WS)).rejects.not.toBeInstanceOf(SignerError);
    const extra = client(() => ({ status: 200, body: { ...approvalState, extra: 1 } }));
    await expect(extra.signer.getApproval(APPROVAL)).rejects.toThrow();
    const notJson = client(() => ({ status: 200, body: null, raw: "ok" }));
    await expect(notJson.signer.health()).rejects.toThrow();
  });
});
