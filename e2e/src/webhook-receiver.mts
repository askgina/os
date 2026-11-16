/**
 * The operator's webhook receiver in the end-to-end stack: service `webhook-receiver` in
 * `e2e/compose.e2e.yaml`, run by Node from the pinned image with no dependencies. The server
 * posts every notification to `/hook`; the gates read what it recorded through the port the
 * overlay publishes, and verify the signatures themselves with the secret from the server's
 * volume. It checks nothing and trusts nothing.
 *
 * It answers every delivery with 200, so the gates that do not look at it see an operator whose
 * webhook accepts everything. While a gate asks for it (`PUT /mode`), it answers the first
 * attempt of each delivery it has not seen before with 503 and `Retry-After: 1`, and later
 * attempts with 200.
 *
 *   GET /healthz    200 once listening
 *   GET /requests   every request to /hook, oldest first, with the status it was answered
 *   PUT /mode       {"failFirstAttempt": true | false}
 */
import { createServer, type IncomingMessage } from "node:http";

const PORT = 8080;

/** A notification body is a few hundred bytes; anything far larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

interface Recorded {
  /** Milliseconds since the Unix epoch, on this container's clock. */
  receivedAt: number;
  method: string;
  path: string;
  /** Every header, lower-cased, repeated ones joined with ", ". */
  headers: Record<string, string>;
  /** The body exactly as received, decoded as UTF-8. */
  body: string;
  /** The status this receiver answered. */
  status: number;
}

const recorded: Recorded[] = [];

/** Every `x-os-delivery` received so far: the first attempt of a delivery is the one not here. */
const seen = new Set<string>();

let failFirstAttempt = false;

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    // SAFETY: an IncomingMessage with no encoding set yields Buffer chunks, and nothing in this
    // file calls `setEncoding` on a request.
    const bytes = chunk as Buffer;
    size += bytes.length;

    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function headersOf(request: IncomingMessage) {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  return headers;
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://receiver").pathname;
  const body = await readBody(request);

  if (body === null) {
    response.writeHead(413).end();

    return;
  }

  if (request.method === "GET" && path === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");

    return;
  }

  if (request.method === "GET" && path === "/requests") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(recorded));

    return;
  }

  if (request.method === "PUT" && path === "/mode") {
    let mode: unknown;

    try {
      mode = JSON.parse(body);
    } catch {}

    const wanted =
      typeof mode === "object" && mode !== null && "failFirstAttempt" in mode
        ? mode.failFirstAttempt
        : undefined;

    if (typeof wanted !== "boolean") {
      response.writeHead(400).end();

      return;
    }

    failFirstAttempt = wanted;
    response.writeHead(204).end();

    return;
  }

  if (path !== "/hook") {
    response.writeHead(404).end();

    return;
  }

  const headers = headersOf(request);
  const delivery = headers["x-os-delivery"];
  const firstAttempt = delivery !== undefined && !seen.has(delivery);

  if (delivery !== undefined) seen.add(delivery);
  const status = failFirstAttempt && firstAttempt ? 503 : 200;
  recorded.push({
    receivedAt: Date.now(),
    method: request.method ?? "",
    path,
    headers,
    body,
    status,
  });

  if (status === 503) response.writeHead(503, { "retry-after": "1" }).end();
  else response.writeHead(200).end();
});

server.listen(PORT, () => {
  process.stdout.write(`${JSON.stringify({ event: "listening", port: PORT })}\n`);
});

// Stop at once when Compose stops the stack; nothing here needs saving.
process.on("SIGTERM", () => process.exit(0));
