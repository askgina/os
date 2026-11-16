import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalId, type AssertionResponse } from "@askgina/os-protocol";
import {
  CONFIRM_TOKEN_HEADER,
  type ConfirmClient,
  ConfirmToken,
  SignerError,
  type SignerErrorBody,
  type SignerErrorCode,
  SubmitConfirmationRequest,
  SubmitPossessionRequest,
} from "@askgina/os-protocol/signer";
import { type Context, Hono } from "hono";
import type { Logger } from "./log.ts";

/**
 * The confirmation page's Content-Security-Policy: our one script and one stylesheet, and
 * requests to this origin only. It is stricter than the control plane's
 * (`CONTENT_SECURITY_POLICY` in `@askgina/os-api`): no inline style attributes, no `data:`
 * images, no form submission anywhere, and Trusted Types turn every sink that could create
 * script from a string into an error.
 */
export const CONFIRMATION_PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

/** Sent with every response, whatever its status. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONFIRMATION_PAGE_POLICY,
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy": "publickey-credentials-get=(self), publickey-credentials-create=()",
  "cache-control": "no-store",
};

/** Far above one passkey assertion (about 1 KiB); the signer would refuse anything larger anyway. */
export const MAX_BODY_BYTES = 16 * 1024;

/** The page's files, read once at start. Every confirmation link gets the same bytes. */
export interface PageFiles {
  html: string;
  script: string;
  style: string;
  icon: string;
}

export function readPageFiles(directory = join(import.meta.dirname, "..", "public")): PageFiles {
  const read = (name: string) => readFileSync(join(directory, name), "utf8");

  return {
    html: read("index.html"),
    script: read("approve.js"),
    style: read("approve.css"),
    icon: read("favicon.svg"),
  };
}

export interface ApproveAppOptions {
  /** The signer's two confirm routes, with this service's secret. */
  confirm: ConfirmClient;
  files: PageFiles;
  /** The confirmation page's origin. Over HTTPS, browsers are told to stay on HTTPS. */
  approveOrigin: string;
  log: Logger;
}

type Refusal = { status: 400 | 404 | 413 | 502; code: SignerErrorCode; message: string };

const NOT_FOUND: Refusal = { status: 404, code: "not_found", message: "no such page" };

const TOO_LARGE: Refusal = {
  status: 413,
  code: "invalid_request",
  message: "the request body is too large",
};

const MALFORMED: Refusal = {
  status: 400,
  code: "invalid_request",
  message: "expected one passkey assertion",
};

const UNREACHABLE: Refusal = {
  status: 502,
  code: "internal",
  message: "the signer could not be reached",
};

/**
 * Read a request body, giving up as soon as it passes the limit. `content-length` is only a
 * hint (a chunked request has none), so the count is taken while reading.
 */
async function readLimited(c: Context): Promise<Uint8Array | null> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const stream = c.req.raw.body;

  if (stream === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of stream) {
    total += chunk.byteLength;

    if (total > MAX_BODY_BYTES) {
      await stream.cancel().catch(() => undefined);

      return null;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * The `approve` service: it serves the confirmation page and relays to the signer the view of
 * one approval, one passkey assertion, and the two halves of an approver change's possession
 * step (a challenge, and the new passkey's answer), each with the token from the link. It holds
 * no key, sets no cookie and reads none, and its secret reaches no other signer route.
 * Everything not listed here is 404.
 */
export function createApproveApp(options: ApproveAppOptions): Hono {
  const { confirm, files, log } = options;
  const https = options.approveOrigin.startsWith("https:");
  const app = new Hono();

  app.use(async (c, next) => {
    await next();

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);

    if (https) c.header("strict-transport-security", "max-age=63072000");
  });

  const refuse = (c: Context, route: string, refusal: Refusal) => {
    log.info("request", { route, status: refusal.status, code: refusal.code });
    const body: SignerErrorBody = { error: { code: refusal.code, message: refusal.message } };

    return c.json(body, refusal.status);
  };

  /** The signer's answer as it gave it: its body on success, its code and status on refusal. */
  const relay = async (c: Context, route: string, call: () => Promise<object>) => {
    try {
      const result = await call();
      log.info("request", { route, status: 200 });

      return c.json(result, 200);
    } catch (error) {
      if (!(error instanceof SignerError)) {
        log.warn("signer unreachable", {
          route,
          kind: error instanceof Error ? error.name : "unknown",
        });

        return refuse(c, route, UNREACHABLE);
      }

      log.info("request", { route, status: error.status, code: error.code });

      const body: SignerErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      };

      return c.json(body, error.status as 400);
    }
  };

  /** The approval id and the token, or null when either cannot be one the signer issued. */
  const target = (c: Context) => {
    const approvalId = ApprovalId.safeParse(c.req.param("approvalId"));
    const token = ConfirmToken.safeParse(c.req.header(CONFIRM_TOKEN_HEADER) ?? "");

    return approvalId.success && token.success
      ? { approvalId: approvalId.data, token: token.data }
      : null;
  };

  const file = (route: string, type: string, body: string) => (c: Context) => {
    log.info("request", { route, status: 200 });

    return c.body(body, 200, { "content-type": type });
  };

  app.get("/a/:approvalId", (c) => {
    if (!ApprovalId.safeParse(c.req.param("approvalId")).success) {
      return refuse(c, "page", NOT_FOUND);
    }

    return file("page", "text/html; charset=utf-8", files.html)(c);
  });
  app.get("/approve.js", file("script", "text/javascript; charset=utf-8", files.script));
  app.get("/approve.css", file("style", "text/css; charset=utf-8", files.style));
  app.get("/favicon.svg", file("icon", "image/svg+xml", files.icon));

  app.get("/api/approvals/:approvalId", async (c) => {
    const found = target(c);

    if (found === null) return refuse(c, "view", NOT_FOUND);

    return relay(c, "view", () => confirm.getConfirmation(found.approvalId, found.token));
  });

  /**
   * The one passkey assertion a POST carries, refused here before the signer is called when the
   * body is too large or anything else.
   */
  const readAssertion = async (
    c: Context,
    schema: typeof SubmitConfirmationRequest | typeof SubmitPossessionRequest,
  ): Promise<{ response: AssertionResponse } | Refusal> => {
    const body = await readLimited(c);

    if (body === null) return TOO_LARGE;
    let parsed: unknown;

    try {
      parsed = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      return MALFORMED;
    }

    const request = schema.safeParse(parsed);

    return request.success ? request.data : MALFORMED;
  };

  app.post("/api/approvals/:approvalId/assertions", async (c) => {
    const found = target(c);

    if (found === null) return refuse(c, "submit", NOT_FOUND);
    const request = await readAssertion(c, SubmitConfirmationRequest);

    if ("status" in request) return refuse(c, "submit", request);

    return relay(c, "submit", () =>
      confirm.submitConfirmation(found.approvalId, found.token, request.response),
    );
  });

  // The possession step of an approver change: the person being added proves here, with the
  // passkey the request carries, that it is theirs.
  app.get("/api/approvals/:approvalId/possession", async (c) => {
    const found = target(c);

    if (found === null) return refuse(c, "challenge", NOT_FOUND);

    return relay(c, "challenge", () => confirm.getPossession(found.approvalId, found.token));
  });

  app.post("/api/approvals/:approvalId/possession", async (c) => {
    const found = target(c);

    if (found === null) return refuse(c, "prove", NOT_FOUND);
    const request = await readAssertion(c, SubmitPossessionRequest);

    if ("status" in request) return refuse(c, "prove", request);

    return relay(c, "prove", () =>
      confirm.submitPossession(found.approvalId, found.token, request.response),
    );
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.notFound((c) => refuse(c, "unknown", NOT_FOUND));
  app.onError((error, c) => {
    log.error("unexpected failure", { kind: error.name });
    const body: SignerErrorBody = { error: { code: "internal", message: "something went wrong" } };

    return c.json(body, 500);
  });

  return app;
}
