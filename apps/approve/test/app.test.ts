import { randomBytes } from "node:crypto";
import {
  type ApprovalId,
  ConfirmationView,
  Envelope,
  envelopeChallenge,
  keyFingerprint,
  newId,
  renderConfirmation,
  type UserId,
} from "@askgina/os-protocol";
import {
  CONFIRM_TOKEN_HEADER,
  createConfirmClient,
  SIGNATURE_HEADER,
  type SignerErrorBody,
  type SignerErrorCode,
  signerErrorStatus,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
} from "@askgina/os-protocol/signer";
import { approverCredentialOf, b64url, SoftAuthenticator } from "@askgina/os-protocol/testing";
import { verifyAuthorization } from "@askgina/os-protocol/webauthn";
import { describe, expect, it } from "vitest";
import {
  encodeAssertion,
  fromBase64Url,
  possessionOf,
  requestOptions,
  toBase64Url,
} from "../public/approve.js";
import { createApproveApp, MAX_BODY_BYTES, readPageFiles } from "../src/app.ts";
import type { Logger } from "../src/log.ts";

const ORIGIN = "http://localhost:8081";
const SECRET = new Uint8Array(randomBytes(32));
const NOW = 1_800_000_000;
const TOKEN = randomBytes(16).toString("base64url");
const files = readPageFiles();

/** What every response must carry, whatever its route or status (`specs/trusted-display.md`). */
const HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy": "publickey-credentials-get=(self), publickey-credentials-create=()",
  "cache-control": "no-store",
};

/** A new approver's passkey, as an `add-approver` envelope carries it. */
const NEW_PASSKEY = {
  userId: newId("usr"),
  credentialId: randomBytes(32).toString("base64url"),
  publicKey: randomBytes(77).toString("base64url"),
};

/**
 * A confirmation view as the signer would send it, for an envelope-only request: by default a
 * resumption, or an approver change whose new person has or has not proven their passkey.
 */
function viewOf(
  approvalId: ApprovalId = newId("apr"),
  change: { possessionProven: boolean } | null = null,
): ConfirmationView {
  const envelope = Envelope.parse({
    v: 1,
    ...(change === null ? { type: "resume-workspace" } : { type: "add-approver", ...NEW_PASSKEY }),
    approvalId,
    workspaceId: newId("ws"),
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: NOW,
    expiresAt: NOW + 3_600,
  });
  const subject = { kind: "envelope-only" } as const;
  const approvals = { collected: 0, required: 1 };
  const rendered = renderConfirmation({
    envelope,
    subject,
    wallet: null,
    chains: [],
    assets: [],
    currentPolicy: null,
    spent24h: 0n,
    approvals,
    adminThreshold: 1,
    possessionProven: change?.possessionProven ?? false,
    treasuries: [],
    cancelTarget: null,
    wallets: [],
  });
  return ConfirmationView.parse({
    v: 1,
    approvalId,
    workspaceId: envelope.workspaceId,
    kind: envelope.type,
    state: "open",
    expiresAt: envelope.expiresAt,
    ...rendered,
    approvals,
    envelope,
    subject,
    webauthn: {
      rpId: "localhost",
      challenge: b64url(envelopeChallenge(envelope)),
      allowCredentials: [randomBytes(32).toString("base64url")],
      userVerification: "required",
      timeoutMs: 120_000,
    },
    returnUrl: `http://localhost:8080/w/${envelope.workspaceId}/approvals/${approvalId}`,
  });
}

type Answer = { status: number; body: unknown } | "unreachable";

/**
 * A stand-in for the signer. It accepts only requests signed with the confirm secret, records
 * what reached it, and answers what the test set.
 */
function fakeSigner() {
  const calls: { method: string; path: string; token: string | null; body: string }[] = [];
  let answer: Answer = { status: 200, body: {} };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const authentic = verifyRequestSignature(SECRET, {
      method: request.method,
      pathWithQuery: `${url.pathname}${url.search}`,
      timestamp: Number(request.headers.get(TIMESTAMP_HEADER)),
      body,
      signature: request.headers.get(SIGNATURE_HEADER) ?? "",
      now: NOW,
    });
    if (!authentic) throw new Error("not signed with the confirm secret");
    calls.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      token: request.headers.get(CONFIRM_TOKEN_HEADER),
      body: Buffer.from(body).toString("utf8"),
    });
    if (answer === "unreachable") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    fetch,
    answer: (next: Answer) => {
      answer = next;
    },
  };
}

function setUp(approveOrigin = ORIGIN) {
  const signer = fakeSigner();
  const logged: string[] = [];
  const record = (message: string, fields = {}) => logged.push(JSON.stringify({ message, fields }));
  const log: Logger = { info: record, warn: record, error: record };
  const app = createApproveApp({
    confirm: createConfirmClient({
      baseUrl: "http://signer:8787",
      secret: SECRET,
      fetch: signer.fetch,
      now: () => NOW,
    }),
    files,
    approveOrigin,
    log,
  });
  return { app, signer, logged };
}

const withToken = (init: RequestInit = {}, token = TOKEN): RequestInit => ({
  ...init,
  headers: { ...init.headers, [CONFIRM_TOKEN_HEADER]: token },
});

/** A passkey assertion as the page posts it. */
function assertionFor(view: ConfirmationView) {
  const authenticator = new SoftAuthenticator();
  const { credential } = authenticator.register({
    rpId: "localhost",
    challenge: b64url(randomBytes(32)),
  });
  return authenticator.authenticate({
    credentialId: b64url(credential.id),
    challenge: view.webauthn.challenge,
    origin: ORIGIN,
  });
}

async function errorOf(response: Response): Promise<SignerErrorBody["error"]> {
  return ((await response.json()) as SignerErrorBody).error;
}

describe("the approve service", () => {
  it("every response carries the security headers", async () => {
    const view = viewOf();
    const page = `/a/${view.approvalId}`;
    const api = `/api/approvals/${view.approvalId}`;
    const submit = { method: "POST", body: JSON.stringify({ response: assertionFor(view) }) };
    const { app, signer } = setUp();
    const requests: [string, () => Promise<Response>][] = [
      ["page", async () => app.request(page)],
      ["script", async () => app.request("/approve.js")],
      ["style", async () => app.request("/approve.css")],
      ["icon", async () => app.request("/favicon.svg")],
      ["health", async () => app.request("/healthz")],
      ["unknown path", async () => app.request("/index.html")],
      [
        "view",
        async () => {
          signer.answer({ status: 200, body: view });
          return app.request(api, withToken());
        },
      ],
      [
        "submit",
        async () => {
          signer.answer({
            status: 200,
            body: { collected: 1, required: 1, returnUrl: view.returnUrl },
          });
          return app.request(`${api}/assertions`, withToken(submit));
        },
      ],
      [
        "challenge",
        async () => {
          signer.answer({ status: 200, body: { ...view.webauthn, allowCredentials: ["AA"] } });
          return app.request(`${api}/possession`, withToken());
        },
      ],
      [
        "prove",
        async () => {
          signer.answer({ status: 200, body: { fingerprint: "0123-4567-89AB-CDEF" } });
          return app.request(`${api}/possession`, withToken(submit));
        },
      ],
      [
        "a signer refusal",
        async () => {
          signer.answer({
            status: 409,
            body: { error: { code: "confirmation_closed", message: "closed" } },
          });
          return app.request(api, withToken());
        },
      ],
      [
        "an unreachable signer",
        async () => {
          signer.answer("unreachable");
          return app.request(api, withToken());
        },
      ],
      ["a missing token", async () => app.request(api)],
      [
        "an oversized body",
        async () =>
          app.request(
            `${api}/assertions`,
            withToken({ method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) }),
          ),
      ],
      [
        "a body that is not an assertion",
        async () => app.request(`${api}/assertions`, withToken({ method: "POST", body: "{}" })),
      ],
    ];
    const statuses = new Set<number>();
    for (const [name, send] of requests) {
      // A cookie a browser might send is ignored, and none is ever set.
      const response = await send();
      statuses.add(response.status);
      for (const [header, value] of Object.entries(HEADERS)) {
        expect(response.headers.get(header), `${name}: ${header}`).toBe(value);
      }
      expect(response.headers.get("set-cookie"), name).toBeNull();
      // Over plain HTTP there is no HSTS: it would pin a scheme the page is not served with.
      expect(response.headers.get("strict-transport-security"), name).toBeNull();
    }
    expect([...statuses].sort()).toEqual([200, 400, 404, 409, 413, 502]);

    const secure = setUp("https://approve.os.example.com");
    for (const path of [page, "/approve.js", "/nothing"]) {
      const response = await secure.app.request(path);
      expect(response.headers.get("content-security-policy")).toBe(
        HEADERS["content-security-policy"],
      );
      expect(response.headers.get("strict-transport-security"), path).toBe("max-age=63072000");
    }
  });

  it("only the listed routes exist", async () => {
    const id = newId("apr");
    const { app, signer } = setUp();
    signer.answer({ status: 200, body: viewOf(id) });

    // The page is the same bytes for every approval; what it shows comes from the signer.
    const first = await app.request(`/a/${id}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await first.text();
    expect(html).toBe(files.html);
    expect(await (await app.request(`/a/${newId("apr")}`)).text()).toBe(html);
    expect((await app.request("/approve.js")).headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect((await app.request("/approve.css")).headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true });
    expect(signer.calls).toEqual([]);

    const unknown: [string, string][] = [
      ["GET", "/"],
      ["GET", "/index.html"],
      ["GET", "/public/approve.js"],
      ["GET", "/approve.js/more"],
      ["GET", "/a"],
      ["GET", "/a/"],
      ["GET", "/a/apr_not-an-id"],
      ["GET", `/a/${id.toUpperCase()}`],
      ["GET", `/a/${id}/more`],
      ["POST", `/a/${id}`],
      ["POST", "/healthz"],
      ["GET", `/api/approvals/${id}/assertions`],
      ["POST", `/api/approvals/${id}`],
      ["PUT", `/api/approvals/${id}/assertions`],
      ["DELETE", `/api/approvals/${id}`],
      ["PUT", `/api/approvals/${id}/possession`],
      ["DELETE", `/api/approvals/${id}/possession`],
      ["GET", `/api/approvals/${id}/possession/more`],
      ["GET", "/api/approvals/apr_not-an-id"],
      ["POST", "/api/approvals/apr_not-an-id/assertions"],
      ["GET", "/api/approvals/apr_not-an-id/possession"],
      ["GET", `/v1/confirm/${id}`],
      ["GET", `/v1/confirm/${id}/possession`],
      ["POST", "/v1/sign"],
      ["GET", "/.well-known/workflow/v1/flow"],
    ];
    for (const [method, path] of unknown) {
      const response = await app.request(path, withToken({ method }));
      expect(response.status, `${method} ${path}`).toBe(404);
      expect((await errorOf(response)).code, `${method} ${path}`).toBe("not_found");
    }

    // A token that cannot be one the signer issued never reaches it either.
    for (const token of ["", "short", `${TOKEN}A`, "!".repeat(22)]) {
      for (const [method, path] of [
        ["GET", `/api/approvals/${id}`],
        ["POST", `/api/approvals/${id}/assertions`],
        ["GET", `/api/approvals/${id}/possession`],
        ["POST", `/api/approvals/${id}/possession`],
      ] as const) {
        const response = await app.request(
          path,
          withToken({ method, body: method === "POST" ? "{}" : null }, token),
        );
        expect(response.status, `${method} ${path} with token "${token}"`).toBe(404);
      }
    }
    expect(signer.calls).toEqual([]);
  });

  it.each([
    ["an assertion", "assertions"],
    ["a possession step's answer", "possession"],
  ])("an oversized body is refused before the signer is called: %s", async (_, route) => {
    const view = viewOf();
    const path = `/api/approvals/${view.approvalId}/${route}`;
    const assertion = JSON.stringify({ response: assertionFor(view) });
    const { app, signer } = setUp();
    signer.answer({ status: 200, body: { collected: 1, required: 1, returnUrl: view.returnUrl } });

    // Sent in chunks with no length announced, the count is taken while reading.
    const chunked = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(text);
          for (let at = 0; at < bytes.length; at += 4_096) {
            controller.enqueue(bytes.subarray(at, at + 4_096));
          }
          controller.close();
        },
      });
    const oversized = `${assertion}${" ".repeat(MAX_BODY_BYTES + 1 - assertion.length)}`;
    for (const body of [oversized, chunked(oversized)]) {
      const response = await app.request(
        path,
        withToken({ method: "POST", body, duplex: "half" } as RequestInit),
      );
      expect(response.status).toBe(413);
      expect((await errorOf(response)).code).toBe("invalid_request");
    }
    const announced = await app.request(
      path,
      withToken({ method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 1) } }),
    );
    expect(announced.status).toBe(413);

    // Whatever is not exactly one assertion is refused here too.
    for (const body of [
      "not json",
      "{}",
      JSON.stringify({ response: {} }),
      `{"response":${assertion},"x":1}`,
    ]) {
      const response = await app.request(path, withToken({ method: "POST", body }));
      expect(response.status, body.slice(0, 40)).toBe(400);
    }
    expect(signer.calls).toEqual([]);

    // A body of exactly the limit is read and relayed.
    const atLimit = `${assertion}${" ".repeat(MAX_BODY_BYTES - assertion.length)}`;
    expect(new TextEncoder().encode(atLimit).length).toBe(MAX_BODY_BYTES);
    if (route === "possession")
      signer.answer({ status: 200, body: { fingerprint: "0123-4567-89AB-CDEF" } });
    const accepted = await app.request(path, withToken({ method: "POST", body: atLimit }));
    expect(accepted.status).toBe(200);
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]?.path).toBe(`/v1/confirm/${view.approvalId}/${route}`);
  });

  it("the signer's answer is relayed unchanged", async () => {
    const view = viewOf();
    const api = `/api/approvals/${view.approvalId}`;
    const { app, signer, logged } = setUp();

    signer.answer({ status: 200, body: view });
    const shown = await app.request(api, withToken());
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual(JSON.parse(JSON.stringify(view)));
    // The token goes to the signer in its header only, never in the path.
    expect(signer.calls.at(-1)).toEqual({
      method: "GET",
      path: `/v1/confirm/${view.approvalId}`,
      token: TOKEN,
      body: "",
    });

    const response = assertionFor(view);
    const recorded = { collected: 1, required: 2, returnUrl: view.returnUrl };
    signer.answer({ status: 200, body: recorded });
    const submitted = await app.request(
      `${api}/assertions`,
      withToken({ method: "POST", body: JSON.stringify({ response }) }),
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual(recorded);
    const call = signer.calls.at(-1);
    expect(call?.path).toBe(`/v1/confirm/${view.approvalId}/assertions`);
    expect(call?.token).toBe(TOKEN);
    expect(JSON.parse(call?.body ?? "")).toEqual({ response });

    // The possession step of an approver change: a challenge, then the new passkey's answer.
    const challenge = { ...view.webauthn, allowCredentials: [NEW_PASSKEY.credentialId] };
    signer.answer({ status: 200, body: challenge });
    const asked = await app.request(`${api}/possession`, withToken());
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual(challenge);
    expect(signer.calls.at(-1)).toEqual({
      method: "GET",
      path: `/v1/confirm/${view.approvalId}/possession`,
      token: TOKEN,
      body: "",
    });
    const fingerprint = { fingerprint: keyFingerprint(NEW_PASSKEY.publicKey) };
    signer.answer({ status: 200, body: fingerprint });
    const proven = await app.request(
      `${api}/possession`,
      withToken({ method: "POST", body: JSON.stringify({ response }) }),
    );
    expect(proven.status).toBe(200);
    expect(await proven.json()).toEqual(fingerprint);
    const proof = signer.calls.at(-1);
    expect(proof?.path).toBe(`/v1/confirm/${view.approvalId}/possession`);
    expect(proof?.token).toBe(TOKEN);
    expect(JSON.parse(proof?.body ?? "")).toEqual({ response });

    const refusals: { code: SignerErrorCode; detail?: string }[] = [
      { code: "confirmation_closed" },
      { code: "possession_unproven" },
      { code: "rate_limited" },
      { code: "not_found" },
      { code: "conflict" },
      { code: "assertion_invalid" },
      { code: "approver_unknown" },
      { code: "policy_denied", detail: "over_daily_cap" },
    ];
    for (const refusal of refusals) {
      const body = { error: { message: `refused: ${refusal.code}`, ...refusal } };
      signer.answer({ status: signerErrorStatus[refusal.code], body });
      for (const [path, init] of [
        [api, withToken()],
        [`${api}/assertions`, withToken({ method: "POST", body: JSON.stringify({ response }) })],
        [`${api}/possession`, withToken()],
        [`${api}/possession`, withToken({ method: "POST", body: JSON.stringify({ response }) })],
      ] as const) {
        const relayed = await app.request(path, init);
        expect(relayed.status, refusal.code).toBe(signerErrorStatus[refusal.code]);
        expect(await relayed.json()).toEqual(body);
      }
    }

    // Logs name the route, the status and the code: never the token or what the page shows.
    const lines = logged.join("\n");
    expect(lines).toContain("rate_limited");
    expect(lines).not.toContain(TOKEN);
    expect(lines).not.toContain(view.title);
    expect(lines).not.toContain(view.webauthn.challenge);
  });

  it("a view that does not describe its own envelope, or no answer, is not shown", async () => {
    const view = viewOf();
    const api = `/api/approvals/${view.approvalId}`;
    const { app, signer } = setUp();
    const other = viewOf();
    for (const forged of [
      { ...view, approvalId: other.approvalId },
      { ...view, envelope: other.envelope },
      { ...view, expiresAt: view.expiresAt + 1 },
      { ...view, returnUrl: "javascript:alert(1)" },
    ]) {
      signer.answer({ status: 200, body: forged });
      const response = await app.request(api, withToken());
      expect(response.status).toBe(502);
      expect((await errorOf(response)).code).toBe("internal");
    }
    signer.answer("unreachable");
    const unreachable = await app.request(api, withToken());
    expect(unreachable.status).toBe(502);
    expect((await errorOf(unreachable)).code).toBe("internal");
  });
});

describe("the page's passkey code", () => {
  it("encodes the browser's assertion into exactly the JSON the signer verifies", async () => {
    const view = viewOf();
    const userId = newId("usr") as UserId;
    const authenticator = new SoftAuthenticator();
    const { credential } = authenticator.register({
      rpId: "localhost",
      challenge: b64url(randomBytes(32)),
    });
    const credentialId = b64url(credential.id);
    const options = requestOptions({ ...view.webauthn, allowCredentials: [credentialId] });
    // The browser is asked to sign the envelope's digest, with this person's passkey only.
    expect(Buffer.from(options.challenge as ArrayBuffer)).toEqual(
      Buffer.from(envelopeChallenge(view.envelope)),
    );
    expect(
      options.allowCredentials?.map((allowed) =>
        Buffer.from(allowed.id as ArrayBuffer).toString("base64url"),
      ),
    ).toEqual([credentialId]);
    expect(options).toMatchObject({
      rpId: "localhost",
      userVerification: "required",
      timeout: 120_000,
    });

    // What `navigator.credentials.get` hands the page: the same fields, as bytes.
    const json = authenticator.authenticate({
      credentialId,
      challenge: Buffer.from(options.challenge as ArrayBuffer).toString("base64url"),
      origin: ORIGIN,
    });
    const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64url")).buffer;
    for (const userHandle of [json.response.userHandle, undefined]) {
      const encoded = encodeAssertion({
        id: json.id,
        rawId: bytes(json.rawId),
        type: "public-key",
        response: {
          clientDataJSON: bytes(json.response.clientDataJSON),
          authenticatorData: bytes(json.response.authenticatorData),
          signature: bytes(json.response.signature),
          userHandle: userHandle === undefined ? null : bytes(userHandle),
        },
        getClientExtensionResults: () => ({}),
      });
      expect(encoded.response.userHandle).toBe(userHandle);
      const verdict = await verifyAuthorization({
        authorization: {
          envelope: view.envelope,
          assertions: [{ userId, credentialId, response: encoded }],
        },
        approvers: [approverCredentialOf(userId, credential)],
        relyingParty: { id: "localhost", origins: [ORIGIN] },
        threshold: 1,
        maxTtlSeconds: 3_600,
        now: NOW,
      });
      expect(verdict.ok).toBe(true);
    }
  });

  it("an approver change can be approved on the page only once the new passkey was proven", () => {
    expect(possessionOf(viewOf())).toBe("none");
    const unproven = viewOf(newId("apr"), { possessionProven: false });
    expect(possessionOf(unproven)).toBe("unproven");
    expect(possessionOf(viewOf(newId("apr"), { possessionProven: true }))).toBe("proven");
    // Both sides read the same fingerprint: the page shows the one the signer computed.
    expect(unproven.lines).toContainEqual({
      label: "Key fingerprint",
      value: keyFingerprint(NEW_PASSKEY.publicKey),
      kind: "code",
    });
  });

  it("base64url round-trips every length", () => {
    for (let length = 0; length <= 64; length += 1) {
      const data = Uint8Array.from({ length }, (_, index) => (index * 37 + length * 11) % 256);
      const text = toBase64Url(data.buffer);
      expect(text).toBe(Buffer.from(data).toString("base64url"));
      expect(new Uint8Array(fromBase64Url(text))).toEqual(data);
    }
  });
});
