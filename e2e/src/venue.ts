/**
 * What the venue gates (`e2e/test/venue.spec.ts`) read and set around an order: the fake
 * Hyperliquid venue of `e2e/compose.venue.yaml` (TEST EQUIPMENT), through the control routes on
 * the port it publishes on the host's loopback, and the signer's own record of what it signed,
 * read from its SQLite file. Nothing here reaches Hyperliquid.
 */
import type {
  ExchangeRecord,
  FakeAsset,
  FakeCancel,
  FakeOrder,
} from "@askgina/os-testkit/fake-hyperliquid";
import { z } from "zod";
import { compose, stack } from "./stack.ts";

/** Call one of the fake venue's control routes; fails on anything but a 2xx answer. */
async function control(method: string, path: string, body?: unknown): Promise<string> {
  const response = await fetch(`${stack.venueUrl}/control/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `the fake venue refused ${method} /control/${path}: ${response.status} ${text}`,
    );
  }
  return text;
}

/** Create the wallet's account at the venue, or set its USDC, as a deposit would. */
export async function seedVenueAccount(address: string, usdc: string): Promise<void> {
  await control("POST", "accounts", { address, usdc });
}

/** The perpetuals the venue lists; the asset index is the position. */
export async function setVenueUniverse(universe: FakeAsset[]): Promise<void> {
  await control("PUT", "meta", { universe });
}

/** The best bid and ask of one asset; an order that crosses them fills at its limit price. */
export async function setVenueBook(asset: number, bid: string, ask: string): Promise<void> {
  await control("PUT", "book", { asset, bid, ask });
}

/** Every `/exchange` request the venue received, oldest first, with what it made of it. */
export async function venueExchangeLog(): Promise<ExchangeRecord[]> {
  return JSON.parse(await control("GET", "exchange")) as ExchangeRecord[];
}

export async function venueOrders(): Promise<FakeOrder[]> {
  return JSON.parse(await control("GET", "orders")) as FakeOrder[];
}

export async function venueCancels(): Promise<FakeCancel[]> {
  return JSON.parse(await control("GET", "cancels")) as FakeCancel[];
}

/** Just enough of a request body to find the client order ids it names. */
const NamedCloids = z.object({
  action: z.object({
    orders: z.array(z.object({ c: z.string().optional() })).optional(),
    cancels: z.array(z.object({ cloid: z.string() })).optional(),
  }),
});

/** The client order ids a request body names, lower-case: an order's `c`, a cancel's `cloid`. */
function cloidsOf(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const named = NamedCloids.safeParse(parsed);
  if (!named.success) return [];
  const { orders = [], cancels = [] } = named.data.action;
  return [
    ...orders.flatMap((order) => (order.c === undefined ? [] : [order.c])),
    ...cancels.map((cancel) => cancel.cloid),
  ].map((cloid) => cloid.toLowerCase());
}

/** Every `/exchange` request that names `cloid`, accepted or not, oldest first. */
export async function requestsFor(cloid: string): Promise<ExchangeRecord[]> {
  const wanted = cloid.toLowerCase();
  return (await venueExchangeLog()).filter((record) => cloidsOf(record.body).includes(wanted));
}

/** What the fake venue holds, for a failed gate's output. Never throws. */
export async function venueReport(): Promise<string> {
  try {
    const [exchange, orders, cancels] = await Promise.all([
      venueExchangeLog(),
      venueOrders(),
      venueCancels(),
    ]);
    return JSON.stringify({ exchange, orders, cancels }, null, 2);
  } catch (error) {
    return `the fake venue could not be read: ${(error as Error).message}`;
  }
}

/** Where the signer keeps its state, inside its container (`SIGNER_DATA_DIR`). */
const SIGNER_DATABASE = "/data/signer.sqlite";

/** Reads the signer's SQLite file as the signer host's operator can, without changing it. */
const SIGNER_QUERY_SCRIPT = [
  'const { DatabaseSync } = require("node:sqlite");',
  "const db = new DatabaseSync(process.env.SIGNER_DATABASE, { readOnly: true });",
  "try {",
  "  const rows = db.prepare(process.env.QUERY).all(...JSON.parse(process.env.PARAMS));",
  '  process.stdout.write(JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? Number(value) : value)));',
  "} finally {",
  "  db.close();",
  "}",
].join("\n");

/** Rows of `sql` in the signer's SQLite file. */
export async function signerQuery(
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>[]> {
  const output = await compose(
    "exec",
    "-T",
    "-e",
    `SIGNER_DATABASE=${SIGNER_DATABASE}`,
    "-e",
    `QUERY=${sql}`,
    "-e",
    `PARAMS=${JSON.stringify(params)}`,
    "signer",
    "node",
    "-e",
    SIGNER_QUERY_SCRIPT,
  );
  return JSON.parse(output) as Record<string, unknown>[];
}

/** What the signer recorded for an approval it signed (`venue_signatures`). */
export interface SignedRequest {
  /** The exact body it handed over, to be posted byte for byte. */
  request: string;
  /** An order's client order id; null for a withdrawal. */
  cloid: string | null;
}

/** The one request the signer signed for an approval, exactly as it handed it over; or null. */
export async function signedRequest(approvalId: string): Promise<SignedRequest | null> {
  const [row] = await signerQuery(
    "SELECT request, cloid FROM venue_signatures WHERE approval_id = ?",
    approvalId,
  );
  if (row === undefined) return null;
  return { request: String(row.request), cloid: row.cloid === null ? null : String(row.cloid) };
}

/** The cancels the signer signed for an order's approval, oldest first, as handed over. */
export async function signedCancels(approvalId: string): Promise<string[]> {
  const rows = await signerQuery(
    "SELECT request FROM venue_cancels WHERE approval_id = ? ORDER BY seq",
    approvalId,
  );
  return rows.map((row) => String(row.request));
}
