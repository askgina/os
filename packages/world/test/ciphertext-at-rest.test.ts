// The claim this package exists for: with the encrypting World, nothing a person or an agent
// typed into a workflow can be read from Postgres. Eight unique markers go through every kind
// of payload the SDK stores (M1 workflow input, M2 step input, M3 step return, M4 hook
// metadata, M5 hook payload, M6 stream chunk, M7 workflow return, M8 step error text). The
// whole database is then scanned for them. The same scenario on the stock Postgres World must
// expose all eight, or the scanner is blind and a clean result means nothing.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataKeyStore, LocalKeyring } from "@askgina/os-keys";
import {
  createTestDatabase,
  type MarkerScan,
  scanForMarkers,
  type TestDatabase,
} from "@askgina/os-testkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  bootstrapWorkflowSchema,
  type Host,
  killAllHosts,
  sql,
  startHost,
  waitForHook,
} from "./harness/host.ts";

// Below Linux's default ephemeral range (32768 and up), so a server that another test starts on
// "any free port" cannot be handed one of these first.
const PORTS = {
  encA: 25750,
  encB: 25751,
  encC: 25752,
  failStart: 25753,
  probe: 25754,
  stockA: 25755,
  stockB: 25756,
};
const dir = mkdtempSync(join(tmpdir(), "os-world-proof-"));
const keyringFile = join(dir, "keyring.json");
writeFileSync(keyringFile, JSON.stringify(LocalKeyring.generate("k1")), { mode: 0o600 });

const markers = (nonce: string) => Array.from({ length: 8 }, (_, i) => `OSMARK${i + 1}_${nonce}`);

/** Which of the eight markers a scan found, e.g. ["OSMARK1", "OSMARK4"]. */
function markersFound(scan: MarkerScan): string[] {
  return [...new Set(scan.hits.map((hit) => hit.marker.split("_")[0] ?? ""))].sort();
}

function report(line: Record<string, unknown>): void {
  process.stdout.write(`[ciphertext-at-rest] ${JSON.stringify(line)}\n`);
}

interface Scenario {
  nonce: string;
  token: string;
  runId: string;
  finalHost: Host;
  suspendedScan: MarkerScan;
  finalScan: MarkerScan;
  stream: { status: number; json: { chunk?: string } };
  hook: { status: number; json: { metadata?: unknown } };
  result: { status: number; json: { value?: unknown } };
}

/**
 * Start a run, wait until it is suspended on its hook, read its stream, kill the host with
 * SIGKILL, then resume the hook from a fresh process (empty key cache) and wait for the result.
 */
async function runScenario(
  databaseUrl: string,
  ports: [number, number],
  env: Record<string, string>,
) {
  const nonce = randomBytes(8).toString("hex");
  const token = `tok-${nonce}`;
  const first = await startHost({ port: ports[0], databaseUrl, keyringFile, env });
  const started = await first.call<{ runId?: string; error?: string }>("/start", {
    nonce,
    tenant: "ws_proof",
  });
  expect(started.status, started.json.error).toBe(200);
  const runId = started.json.runId ?? "";
  await waitForHook(databaseUrl, token);
  const stream = await first.call<{ chunk?: string }>(`/stream/${runId}`);
  const suspendedScan = await scanForMarkers(databaseUrl, markers(nonce));
  await first.kill();

  const second = await startHost({ port: ports[1], databaseUrl, keyringFile, env });
  const hook = await second.call<{ metadata?: unknown }>(`/hook/${token}`);
  const resumed = await second.call<{ error?: string }>("/resume", {
    token,
    m5: `OSMARK5_${nonce}`,
  });
  expect(resumed.status, resumed.json.error).toBe(200);
  // returnValue waits for the run to finish.
  const result = await second.call<{ value?: unknown }>(`/result/${runId}`);
  const finalScan = await scanForMarkers(databaseUrl, markers(nonce));
  return {
    nonce,
    token,
    runId,
    finalHost: second,
    suspendedScan,
    finalScan,
    stream,
    hook,
    result,
  } satisfies Scenario;
}

let encDb: TestDatabase;
let stockDb: TestDatabase;
let enc: Scenario;

beforeAll(async () => {
  [encDb, stockDb] = await Promise.all([
    createTestDatabase("world_enc"),
    createTestDatabase("world_stock"),
  ]);
  await Promise.all([bootstrapWorkflowSchema(encDb.url), bootstrapWorkflowSchema(stockDb.url)]);
});

afterAll(async () => {
  await killAllHosts();
  await Promise.all([encDb?.drop(), stockDb?.drop()]);
  rmSync(dir, { recursive: true, force: true });
});

describe("encrypting World", () => {
  test("a run survives SIGKILL between hook creation and resume, and no marker is readable anywhere", async () => {
    enc = await runScenario(encDb.url, [PORTS.encA, PORTS.encB], {});
    const n = enc.nonce;
    // The run really used every payload path: everything reads back through the SDK.
    expect(enc.result.status).toBe(200);
    expect(enc.result.json.value).toEqual({
      m1: `OSMARK1_${n}`,
      m3: `OSMARK3_${n}`,
      m5: `OSMARK5_${n}`,
      m7: `OSMARK7_${n}`,
      m8: `OSMARK8_${n}`,
    });
    expect(enc.stream.json.chunk).toBe(`OSMARK6_${n}`);
    expect(enc.hook.json.metadata).toEqual({ m4: `OSMARK4_${n}` });

    report({
      world: "encrypting",
      markersFound: markersFound(enc.finalScan).length,
      hits: enc.finalScan.hits.length,
      hitsWhileSuspended: enc.suspendedScan.hits.length,
      tables: enc.finalScan.tables.length,
      columns: enc.finalScan.columns,
      rows: enc.finalScan.rows,
    });
    expect(enc.suspendedScan.hits).toEqual([]);
    expect(enc.finalScan.hits).toEqual([]);
    // The scan covered the workflow tables and the key table, not an empty database.
    expect(enc.finalScan.tables).toEqual(
      expect.arrayContaining([
        "workflow.workflow_runs",
        "workflow.workflow_events",
        "os_keys.data_keys",
      ]),
    );
  });

  test("after shredding the run's key, payload reads fail and metadata rows remain", async () => {
    await enc.finalHost.kill();
    const pool = new pg.Pool({ connectionString: encDb.url, max: 2 });
    try {
      const keys = new DataKeyStore({
        pool,
        provider: LocalKeyring.fromFile(keyringFile),
        cacheTtlMs: 0,
      });
      expect(await keys.shred("run", enc.runId)).toBe(true);
    } finally {
      await pool.end();
    }
    // A fresh process, so no key is left in any cache.
    const reader = await startHost({ port: PORTS.encC, databaseUrl: encDb.url, keyringFile });
    const result = await reader.call<{ value?: unknown; error?: string }>(`/result/${enc.runId}`);
    const stream = await reader.call<{ chunk?: string; error?: string }>(`/stream/${enc.runId}`);
    expect(result.status).toBe(500);
    expect(result.json.value).toBeUndefined();
    expect(stream.status).toBe(500);
    expect(stream.json.chunk).toBeUndefined();

    const [rows] = await sql<{
      runs: number;
      events: number;
      steps: number;
      chunks: number;
      status: string;
      live_keys: number;
      tombstones: number;
    }>(
      encDb.url,
      `SELECT
         (SELECT count(*) FROM workflow.workflow_runs WHERE id = $1)::int AS runs,
         (SELECT count(*) FROM workflow.workflow_events WHERE run_id = $1)::int AS events,
         (SELECT count(*) FROM workflow.workflow_steps WHERE run_id = $1)::int AS steps,
         (SELECT count(*) FROM workflow.workflow_stream_chunks WHERE run_id = $1)::int AS chunks,
         (SELECT status::text FROM workflow.workflow_runs WHERE id = $1) AS status,
         (SELECT count(*) FROM os_keys.data_keys WHERE key_id = $1 AND wrapped_key IS NOT NULL)::int AS live_keys,
         (SELECT count(*) FROM os_keys.data_keys WHERE key_id = $1 AND shredded_at IS NOT NULL)::int AS tombstones`,
      [enc.runId],
    );
    report({ world: "encrypting", shredded: enc.runId, rowsRemaining: rows });
    expect(rows).toMatchObject({ runs: 1, status: "completed", live_keys: 0, tombstones: 1 });
    expect(rows?.events).toBeGreaterThan(0);
    expect(rows?.steps).toBeGreaterThan(0);
    expect(rows?.chunks).toBeGreaterThan(0);
    await reader.kill();
  });

  test("when the key method throws at start, start fails and no run row is written", async () => {
    const before = await sql<{ n: number }>(
      encDb.url,
      "SELECT count(*)::int AS n FROM workflow.workflow_runs",
    );
    const host = await startHost({
      port: PORTS.failStart,
      databaseUrl: encDb.url,
      keyringFile,
      env: { HARNESS_KEY_FAIL: "1" },
    });
    const started = await host.call<{ runId?: string; error?: string }>("/start", {
      nonce: randomBytes(8).toString("hex"),
    });
    expect(started.status).toBe(500);
    expect(started.json.runId).toBeUndefined();
    const after = await sql<{ n: number }>(
      encDb.url,
      "SELECT count(*)::int AS n FROM workflow.workflow_runs",
    );
    expect(after).toEqual(before);
    await host.kill();
  });

  test("a health probe that names a run mints that run's key before the run exists, without a tenant", async () => {
    // Upstream's start() sends this probe only when starting a run on another deployment. The
    // responder asks its World for the named run's key to publish the run's public key. This
    // pins down what our World does then, so a change upstream shows up here.
    const host = await startHost({ port: PORTS.probe, databaseUrl: encDb.url, keyringFile });
    const runId = `wrun_PROBE${randomBytes(8).toString("hex").toUpperCase()}`;
    const probe = await host.call<{ healthy: boolean; publicKey: string | null }>("/probe", {
      runId,
    });
    expect(probe.json.healthy).toBe(true);
    expect(probe.json.publicKey).toEqual(expect.any(String));
    const keyRequests = (
      await host.call<{ requests: { runId: string; context: unknown }[] }>("/keylog")
    ).json.requests;
    expect(keyRequests.filter((request) => request.runId === runId)).toHaveLength(1);
    const rows = await sql<{ tenant_id: string | null; live: boolean }>(
      encDb.url,
      "SELECT tenant_id, wrapped_key IS NOT NULL AS live FROM os_keys.data_keys WHERE scope = 'run' AND key_id = $1",
      [runId],
    );
    expect(rows).toEqual([{ tenant_id: null, live: true }]);
    const runs = await sql(encDb.url, "SELECT 1 FROM workflow.workflow_runs WHERE id = $1", [
      runId,
    ]);
    expect(runs).toHaveLength(0);
    // If a start then named a tenant for this run id, the key store refuses rather than binding
    // the run to no tenant: see DataKeyTenantMismatchError.
    const pool = new pg.Pool({ connectionString: encDb.url, max: 1 });
    try {
      const keys = new DataKeyStore({
        pool,
        provider: LocalKeyring.fromFile(keyringFile),
        cacheTtlMs: 0,
      });
      await expect(keys.getOrCreate("run", runId, "ws_proof")).rejects.toThrow(/different tenant/);
    } finally {
      await pool.end();
    }
    report({ hazard: "probe-mints-key", runId, tenant: null, runRowCreated: false });
    await host.kill();
  });
});

describe("stock Postgres World (control)", () => {
  test("the identical scenario exposes all eight markers, so the scanner can see plaintext", async () => {
    const stock = await runScenario(stockDb.url, [PORTS.stockA, PORTS.stockB], {
      HARNESS_WORLD: "stock",
    });
    await stock.finalHost.kill();
    expect(stock.result.status).toBe(200);
    const found = markersFound(stock.finalScan);
    report({
      world: "stock",
      markersFound: found.length,
      hits: stock.finalScan.hits.length,
      tables: stock.finalScan.tables.length,
      columns: stock.finalScan.columns,
    });
    expect(found).toEqual(markers("").map((marker) => marker.slice(0, -1)));
  });
});
