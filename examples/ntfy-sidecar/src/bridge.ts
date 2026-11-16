import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

/** How far a delivery's `x-os-timestamp` may be from this host's clock, in seconds. */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

/** How long a forwarded delivery id is remembered, in seconds: far longer than any retry. */
export const DEDUPE_SECONDS = 86_400;

/** A delivery is a few hundred bytes; anything far larger is not one. */
const MAX_BODY_BYTES = 16 * 1024;

const NTFY_TIMEOUT_MS = 5_000;

/**
 * The whole text of each notification, by the webhook's event. Nothing from the delivery is in
 * it: the delivery holds identifiers only, and a phone's lock screen needs none of them.
 */
export const MESSAGES = {
  "approval.opened": "Approval waiting",
  "approval.reminder": "Approval expiring soon",
  "mandate.used": "Paid under an approval in advance",
} as const;

type Event = keyof typeof MESSAGES;

/** Whether a delivery's event is one this sidecar has a text for. */
function isEvent(name: string): name is Event {
  return Object.hasOwn(MESSAGES, name);
}

/** One log line's fields: identifiers, codes and settings, never a body. */
export type LogFields = { [field: string]: string | number | null | undefined };

/** The headers of one publish to ntfy. */
type NtfyHeaders = { "content-type": string; authorization?: string; click?: string };

export interface BridgeConfig {
  /** The webhook's signing secret: the trimmed text of the control plane's file. */
  secret: string;
  /** The ntfy server's base URL, without a trailing slash. */
  ntfyUrl: string;
  topic: string;
  /** An ntfy access token for a protected topic, or null. */
  token: string | null;
  /**
   * The control plane's origin when tapping a notification opens the delivery's link (ntfy's
   * `Click` header), or null for no link. A link on any other origin is left out.
   */
  linkOrigin: string | null;
}

export interface BridgeOptions {
  /** The clock, in Unix seconds. */
  now?: () => number;
  /** Where one line per delivery goes: identifiers and codes only, never a body. */
  log?: (fields: LogFields) => void;
}

/** What one request came to: the status answered, and a short code saying why. */
interface Answer {
  status: number;
  code: string;
  deliveryId?: string;
  event?: string;
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    // SAFETY: nothing calls `setEncoding` on this request, so Node's IncomingMessage yields its
    // body as raw Buffer chunks.
    const bytes = chunk as Buffer;
    size += bytes.length;

    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];

  return Array.isArray(value) ? undefined : value;
}

/** The delivery's link when it is a page on `origin`, else null. */
function linkOn(origin: string, value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);

  return url.origin === origin ? url.href : null;
}

/**
 * The sidecar: an HTTP server that takes the control plane's signed webhook and publishes a fixed
 * text to one ntfy topic. It answers the control plane with
 *
 * - 204 when the delivery was published, was published before (same `x-os-delivery`), or is an
 *   event it does not know;
 * - 401 when the signature does not verify or the timestamp is more than 300 seconds away;
 * - 400 when a signed body is not a version 1 delivery under the id in its header;
 * - 502 when ntfy did not take it, so the control plane tries again later.
 *
 * Delivery ids are remembered in memory for a day, only once published: a restart forgets them,
 * so a retry that arrives after a restart can publish a second time. A link that is not on
 * `linkOrigin` is left out and the text published without it, so a control plane that sends
 * one cannot point people at another site through this sidecar.
 */
export function createBridge(config: BridgeConfig, options: BridgeOptions = {}): Server {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? ((fields) => process.stdout.write(`${JSON.stringify(fields)}\n`));
  /** Published delivery ids and when each may be forgotten, oldest first. */
  const published = new Map<string, number>();
  /** Deliveries being published right now; a retry meanwhile waits for the same outcome. */
  const publishing = new Map<string, Promise<boolean>>();

  function forget(): void {
    for (const [deliveryId, until] of published) {
      if (until > now()) return;
      published.delete(deliveryId);
    }
  }

  async function publish(event: Event, link: string | null): Promise<boolean> {
    const headers: NtfyHeaders = { "content-type": "text/plain; charset=utf-8" };

    if (config.token !== null) headers.authorization = `Bearer ${config.token}`;

    if (link !== null) headers.click = link;

    try {
      const response = await fetch(`${config.ntfyUrl}/${config.topic}`, {
        method: "POST",
        headers,
        body: MESSAGES[event],
        redirect: "manual",
        signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
      });

      await response.body?.cancel();

      return response.ok;
    } catch {
      return false;
    }
  }

  async function receive(request: IncomingMessage): Promise<Answer> {
    const path = new URL(request.url ?? "/", "http://sidecar").pathname;

    if (request.method === "GET" && path === "/healthz") return { status: 200, code: "healthy" };

    if (request.method !== "POST") return { status: 405, code: "method_not_allowed" };
    const body = await readBody(request);

    if (body === null) return { status: 413, code: "too_large" };

    // Nothing in the request is believed before the signature over its exact bytes verifies.
    const timestamp = header(request, "x-os-timestamp");
    const signature = /^v1=([0-9a-f]{64})$/.exec(header(request, "x-os-signature") ?? "")?.[1];

    if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp) || signature === undefined) {
      return { status: 401, code: "unsigned" };
    }

    if (Math.abs(now() - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) {
      return { status: 401, code: "stale_timestamp" };
    }

    const expected = createHmac("sha256", config.secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest();

    if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) {
      return { status: 401, code: "bad_signature" };
    }

    let delivery: object;

    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { status: 400, code: "not_a_delivery" };
      }

      delivery = parsed;
    } catch {
      return { status: 400, code: "not_a_delivery" };
    }

    const version = "v" in delivery ? delivery.v : undefined;

    if (version !== 1) return { status: 400, code: "unknown_version" };
    // The header is not signed; the id in the body is. Dedupe on the signed one.
    const deliveryId = "deliveryId" in delivery ? delivery.deliveryId : undefined;

    if (typeof deliveryId !== "string" || deliveryId !== header(request, "x-os-delivery")) {
      return { status: 400, code: "delivery_id_mismatch" };
    }

    const event = "event" in delivery ? delivery.event : undefined;

    if (typeof event !== "string" || !isEvent(event)) {
      return { status: 204, code: "ignored", deliveryId };
    }

    const linked = "link" in delivery ? delivery.link : undefined;

    const link =
      config.linkOrigin === null || typeof linked !== "string"
        ? null
        : linkOn(config.linkOrigin, linked);

    const linkDropped = config.linkOrigin !== null && link === null;

    forget();

    if (published.has(deliveryId)) return { status: 204, code: "duplicate", deliveryId, event };
    const outcome = linkDropped ? "published_without_link" : "published";
    let attempt = publishing.get(deliveryId);
    const first = attempt === undefined;

    if (attempt === undefined) {
      attempt = publish(event, link);
      publishing.set(deliveryId, attempt);
    }

    const ok = await attempt;

    if (first) {
      publishing.delete(deliveryId);

      if (ok) published.set(deliveryId, now() + DEDUPE_SECONDS);
    }

    if (!ok) return { status: 502, code: "ntfy_failed", deliveryId, event };

    return { status: 204, code: first ? outcome : "duplicate", deliveryId, event };
  }

  return createServer((request, response) => {
    receive(request).then(
      (answer) => {
        response.writeHead(answer.status).end();

        if (answer.code !== "healthy") log({ message: "delivery", ...answer });
      },
      () => {
        response.writeHead(500).end();
        log({ message: "delivery", status: 500, code: "error" });
      },
    );
  });
}
