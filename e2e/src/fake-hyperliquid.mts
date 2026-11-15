/**
 * TEST EQUIPMENT. The fake Hyperliquid venue of the end-to-end stack: service `fake-hyperliquid`
 * in `e2e/compose.venue.yaml`, run by Node from the pinned image with the repository's
 * installed dependencies mounted read-only. Never deploy it and never point a real wallet at it.
 *
 * Everything it does is `FakeHyperliquid` in `packages/testkit/src/fake-hyperliquid.ts`; this
 * file only puts it on a port. It listens on the Compose `chain` network, where the server
 * reaches it as `http://fake-hyperliquid:8080`, and the overlay publishes the port on the host's
 * loopback only, for the gates.
 *
 *   GET  /healthz              200 once listening
 *   POST /exchange             order, cancelByCloid, withdraw3 (testnet signatures only)
 *   POST /info                 meta, orderStatus, clearinghouseState
 *   POST /control/accounts     {"address", "usdc"}: create an account or set its balance
 *   PUT  /control/meta         {"universe": [{"name", "szDecimals", "maxLeverage", "isDelisted"?}]}
 *   PUT  /control/book         {"asset", "bid", "ask"}: best prices, null for an empty side
 *   POST /control/fill         {"user", "cloid"}: fill a resting order at its limit price
 *   PUT  /control/clock        {"offsetMs"}: move the venue's clock
 *   POST /control/failures     {"endpoint"?, "mode": "error"|"http"|"drop", "response"?, "status"?, "count"?}
 *   POST /control/reset        forget everything
 *   GET  /control/exchange     every /exchange request with its answer, signer and acceptance
 *   GET  /control/orders       every order kept, by cloid
 *   GET  /control/cancels      every cancel taken, with its result
 *   GET  /control/withdrawals  every withdrawal taken
 */
import { createServer, type IncomingMessage } from "node:http";
import {
  FAKE_HYPERLIQUID_MAX_BODY_BYTES,
  FakeHyperliquid,
} from "@askgina/os-testkit/fake-hyperliquid";

const PORT = 8080;
const venue = new FakeHyperliquid({ network: "testnet" });

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > FAKE_HYPERLIQUID_MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
  const body = await readBody(request);
  if (body === null) {
    response.writeHead(413).end();
    return;
  }
  const path = new URL(request.url ?? "/", "http://fake-hyperliquid").pathname;
  const answer = await venue.handle({ method: request.method ?? "GET", path, body });
  if (answer.kind === "drop") {
    request.socket.destroy();
    return;
  }
  if (answer.status === 204) {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(answer.status, { "content-type": answer.contentType }).end(answer.body);
});

server.listen(PORT, () => {
  process.stdout.write(`${JSON.stringify({ event: "listening", port: PORT })}\n`);
});
// Stop at once when Compose stops the stack; nothing here needs saving.
process.on("SIGTERM", () => process.exit(0));
