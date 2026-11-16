/**
 * What the venue gates (`e2e/test/venue.spec.ts`) read and set around an order: the fake
 * Hyperliquid testnet and mainnet venues of `e2e/compose.venue.yaml` (TEST EQUIPMENT), through
 * the control routes on the ports they publish on the host's loopback (every helper that talks
 * to a fake takes its network, the testnet unless named); the signer's own record of what it
 * signed, read from its SQLite file; the server's sealed copy, read from Postgres; what a
 * container of the stack can reach; and how the server's boot treats a venues file. Nothing here
 * reaches Hyperliquid.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExchangeRecord,
  FakeAsset,
  FakeCancel,
  FakeNetwork,
  FakeOrder,
  FakeWithdrawal,
} from "@askgina/os-testkit/fake-hyperliquid";
import pg from "pg";
import { z } from "zod";
import { compose, composeArgs, containersOf, databaseUrl, docker, execIn, stack } from "./stack.ts";

const run = promisify(execFile);

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * The fake venue of each network: its Compose service, which the server reaches by name on the
 * `chain` network, and the URL of the port it publishes on the host's loopback.
 */
const FAKES: Record<FakeNetwork, { service: string; url: string }> = {
  testnet: { service: "fake-hyperliquid", url: stack.venueUrl },
  mainnet: { service: "fake-hyperliquid-mainnet", url: stack.venueMainnetUrl },
};

const NETWORKS: readonly FakeNetwork[] = ["testnet", "mainnet"];

/** Call one of a fake venue's control routes; fails on anything but a 2xx answer. */
async function control(
  network: FakeNetwork,
  method: string,
  path: string,
  body?: unknown,
): Promise<string> {
  const response = await fetch(`${FAKES[network].url}/control/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `the fake ${network} venue refused ${method} /control/${path}: ${response.status} ${text}`,
    );
  }

  return text;
}

/** Create the wallet's account at the venue, or set its USDC, as a deposit would. */
export async function seedVenueAccount(
  address: string,
  usdc: string,
  network: FakeNetwork = "testnet",
): Promise<void> {
  await control(network, "POST", "accounts", { address, usdc });
}

/** The perpetuals the venue lists; the asset index is the position. */
export async function setVenueUniverse(
  universe: FakeAsset[],
  network: FakeNetwork = "testnet",
): Promise<void> {
  await control(network, "PUT", "meta", { universe });
}

/** The best bid and ask of one asset; an order that crosses them fills at its limit price. */
export async function setVenueBook(
  asset: number,
  bid: string,
  ask: string,
  network: FakeNetwork = "testnet",
): Promise<void> {
  await control(network, "PUT", "book", { asset, bid, ask });
}

/** Every `/exchange` request the venue received, oldest first, with what it made of it. */
export async function venueExchangeLog(
  network: FakeNetwork = "testnet",
): Promise<ExchangeRecord[]> {
  return JSON.parse(await control(network, "GET", "exchange")) as ExchangeRecord[];
}

export async function venueOrders(network: FakeNetwork = "testnet"): Promise<FakeOrder[]> {
  return JSON.parse(await control(network, "GET", "orders")) as FakeOrder[];
}

export async function venueCancels(network: FakeNetwork = "testnet"): Promise<FakeCancel[]> {
  return JSON.parse(await control(network, "GET", "cancels")) as FakeCancel[];
}

/** Every withdrawal the venue took, oldest first, with the destination it was signed for. */
export async function venueWithdrawals(
  network: FakeNetwork = "testnet",
): Promise<FakeWithdrawal[]> {
  return JSON.parse(await control(network, "GET", "withdrawals")) as FakeWithdrawal[];
}

/**
 * Post `body` to the venue's `/exchange` as anyone holding a copy of a signed request could
 * (the control plane, a log, the network), and return the venue's answer, parsed when it is JSON.
 */
export async function postToVenue(
  body: string,
  network: FakeNetwork = "testnet",
): Promise<{ status: number; answer: unknown }> {
  const response = await fetch(`${FAKES[network].url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const text = await response.text();

  try {
    return { status: response.status, answer: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, answer: text };
  }
}

/** A fake venue's IPv4 address on the Compose `chain` network, the only one it is on. */
export async function venueAddress(network: FakeNetwork = "testnet"): Promise<string> {
  const { service } = FAKES[network];
  const [fake] = await containersOf(service);

  if (fake === undefined) throw new Error(`the stack has no ${service} container`);
  const chain = `${stack.project}_chain`;

  const address = (
    await docker(
      "inspect",
      "--format",
      `{{with index .NetworkSettings.Networks "${chain}"}}{{.IPAddress}}{{end}}`,
      fake,
    )
  ).trim();

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    throw new Error(`the fake ${service} has no IPv4 address on ${chain}: "${address}"`);
  }

  return address;
}

/** One HTTP request a container is asked to make; a POST carries `{}` as JSON. */
export interface ProbeRequest {
  method: "GET" | "POST";
  url: string;
}

/**
 * From inside `container`: whether it resolves the name of either fake venue, and the status
 * each request got, in order, or "unreachable" when it got no answer within 4 seconds.
 */
export async function reachFrom(
  container: string,
  requests: readonly ProbeRequest[],
): Promise<{ resolvesVenue: boolean; statuses: (number | "unreachable")[] }> {
  const script = `
    const requests = ${JSON.stringify(requests)};
    const names = ${JSON.stringify(NETWORKS.map((network) => FAKES[network].service))};
    (async () => {
      const { lookup } = require("node:dns/promises");
      let resolvesVenue = false;
      for (const name of names) {
        if (await lookup(name).then(() => true, () => false)) resolvesVenue = true;
      }
      const statuses = [];
      for (const { method, url } of requests) {
        const body = method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {};
        statuses.push(
          await fetch(url, { method, ...body, signal: AbortSignal.timeout(4000) }).then((r) => r.status, () => "unreachable"),
        );
      }
      process.stdout.write(JSON.stringify({ resolvesVenue, statuses }) + "\\n");
    })();`;

  const output = await execIn(container, "node", "-e", script);

  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
    resolvesVenue: boolean;
    statuses: (number | "unreachable")[];
  };
}

/** The server's sealed copy of every request the signer signed, by approval, as Postgres holds it. */
export async function sealedVenueRequests(): Promise<{ approvalId: string; request: Buffer }[]> {
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();

  try {
    const { rows } = await db.query<{ approval_id: string; request: Buffer }>(
      "SELECT approval_id, request FROM os.venue_orders ORDER BY approval_id",
    );

    return rows.map((row) => ({ approvalId: row.approval_id, request: row.request }));
  } finally {
    await db.end();
  }
}

/**
 * A database no container can reach, for a boot that must stop before it. Should the boot ever
 * get past its venues, it stops at the database instead of joining the running stack.
 */
const UNREACHABLE_DATABASE = "postgres://postgres@database.invalid:5432/postgres";

/**
 * Write the venues file, then start the server exactly as its image does. A boot that is not
 * refused is stopped after 60 seconds with exit code 99; an import that fails exits 98.
 */
const BOOT_SCRIPT = [
  'const fs = process.getBuiltinModule("node:fs");',
  'const url = process.getBuiltinModule("node:url");',
  "setTimeout(() => process.exit(99), 60_000).unref();",
  "fs.writeFileSync(process.env.VENUES_FILE, process.env.VENUES_JSON);",
  'import(url.pathToFileURL("/app/apps/server/src/main.ts").href).catch((error) => {',
  "  console.error(error);",
  "  process.exit(98);",
  "});",
].join("\n");

/**
 * Start a throwaway server container of the stack (`compose run --rm --no-deps`) whose
 * `VENUES_FILE` holds `venues`, and an unreachable database, and report how it exited and
 * everything it wrote. The running stack is not touched.
 */
export async function bootServerWith(
  venues: unknown,
): Promise<{ exitCode: number | null; output: string }> {
  const args = composeArgs(
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "-e",
    "VENUES_FILE=/tmp/venues.json",
    "-e",
    `VENUES_JSON=${JSON.stringify(venues)}`,
    "-e",
    `DATABASE_URL=${UNREACHABLE_DATABASE}`,
    "server",
    "node",
    "-e",
    BOOT_SCRIPT,
  );

  try {
    const { stdout, stderr } = await run("docker", args, {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 150_000,
    });

    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };

    return {
      exitCode: typeof failure.code === "number" ? failure.code : null,
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
    };
  }
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

/** Every `/exchange` request to one venue that names `cloid`, accepted or not, oldest first. */
export async function requestsFor(
  cloid: string,
  network: FakeNetwork = "testnet",
): Promise<ExchangeRecord[]> {
  const wanted = cloid.toLowerCase();

  return (await venueExchangeLog(network)).filter((record) =>
    cloidsOf(record.body).includes(wanted),
  );
}

/** What each fake venue holds, for a failed gate's output. Never throws. */
export async function venueReport(): Promise<string> {
  const report: Record<string, unknown> = {};

  for (const network of NETWORKS) {
    try {
      const [exchange, orders, cancels] = await Promise.all([
        venueExchangeLog(network),
        venueOrders(network),
        venueCancels(network),
      ]);

      report[network] = { exchange, orders, cancels };
    } catch (error) {
      report[network] = `the fake ${network} venue could not be read: ${(error as Error).message}`;
    }
  }

  return JSON.stringify(report, null, 2);
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
