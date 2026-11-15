// The claim this package exists for: with the encrypting World, nothing a person or an agent
// typed into a workflow can be read from Postgres. Ten unique markers go through every kind
// of payload the SDK stores (M1 workflow input, M2 step input, M3 step return, M4 hook
// metadata, M5 hook payload, M6 stream chunk, M7 workflow return, M8 step error text) and
// through run attributes, which the SDK never encrypts and this World withholds (M9 given at
// start, M10 set while the run is in progress). The whole database is then scanned for them.
// The same scenario on the stock Postgres World must expose all ten, or the scanner is blind
// and a clean result means nothing.
//
// The encrypting World's scenario and shredding run once per key provider: the keyring file,
// and OpenBao Transit (the dev server from `deploy/compose.test.yaml`, required when `CI=true`,
// skipped elsewhere when it is not up). On OpenBao a run is also carried through a 20-second
// outage of the server. The stock control does not use a key provider, so it runs once.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DataKeyStore, keyProviderFromEnv, LocalKeyring } from "@askgina/os-keys";
import {
  createTestDatabase,
  type MarkerScan,
  scanForMarkers,
  type TestDatabase,
} from "@askgina/os-testkit";
import {
  holdOpenBao,
  OPENBAO_TEST_ADDR,
  openBaoReachable,
  pauseOpenBao,
  prepareTransit,
  unpauseOpenBao,
} from "@askgina/os-testkit/openbao";
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
  fileA: 25750,
  fileB: 25751,
  fileC: 25752,
  failStart: 25753,
  probe: 25754,
  stockA: 25755,
  stockB: 25756,
  bodyAttribute: 25757,
  openbaoA: 25760,
  openbaoB: 25761,
  openbaoC: 25762,
  outageA: 25763,
  outageB: 25764,
};
/** How long the OpenBao container stays paused in the outage test. */
const OUTAGE_MS = 20_000;
/** Generous bounds on recovery after the outage; the measured delays are printed. */
const RESUME_CEILING_MS = 60_000;
const COMPLETION_CEILING_MS = 240_000;
/** Longer than any other file holds the OpenBao test server. */
const OPENBAO_HOLD_WAIT_MS = 600_000;

const dir = mkdtempSync(join(tmpdir(), "os-world-proof-"));
const keyringFile = join(dir, "keyring.json");
writeFileSync(keyringFile, JSON.stringify(LocalKeyring.generate("k1")), { mode: 0o600 });

const markers = (nonce: string) => Array.from({ length: 10 }, (_, i) => `OSMARK${i + 1}_${nonce}`);

/** Which of the ten markers a scan found, e.g. ["OSMARK1", "OSMARK4"]. */
function markersFound(scan: MarkerScan): string[] {
  return [...new Set(scan.hits.map((hit) => hit.marker.split("_")[0] ?? ""))].sort();
}

function report(line: Record<string, unknown>): void {
  process.stdout.write(`[ciphertext-at-rest] ${JSON.stringify(line)}\n`);
}

/** A key provider as the proof host selects it: harness environment, and its KEK id. */
interface ProviderSetup {
  name: "file" | "openbao";
  env: Record<string, string>;
  kekId: string;
}

const fileProvider: ProviderSetup = {
  name: "file",
  // Empty OPENBAO_ADDR: the file provider refuses to start beside an OpenBao address.
  env: { KEY_PROVIDER: "file", HARNESS_KEYRING_FILE: keyringFile, OPENBAO_ADDR: "" },
  kekId: "k1",
};

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

/** The run's return value the markers workflow produces for `nonce`. */
const expectedValue = (n: string) => ({
  m1: `OSMARK1_${n}`,
  m3: `OSMARK3_${n}`,
  m5: `OSMARK5_${n}`,
  m7: `OSMARK7_${n}`,
  m8: `OSMARK8_${n}`,
});

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
  const first = await startHost({ port: ports[0], databaseUrl, env });
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

  const second = await startHost({ port: ports[1], databaseUrl, env });
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

async function runStatus(databaseUrl: string, runId: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }>(
    databaseUrl,
    "SELECT status::text AS status FROM workflow.workflow_runs WHERE id = $1",
    [runId],
  );
  return row?.status;
}

async function runCount(databaseUrl: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    databaseUrl,
    "SELECT count(*)::int AS n FROM workflow.workflow_runs",
  );
  return row?.n ?? 0;
}

/**
 * The encrypting World's scenario and shredding on one key provider, in a database of its own.
 * `provider` is read when the tests run, after the enclosing `beforeAll` has prepared it.
 */
function encryptingWorld(
  provider: () => ProviderSetup,
  ports: { a: number; b: number; c: number },
): { db(): TestDatabase } {
  let db: TestDatabase | undefined;
  let enc: Scenario;
  const database = () => {
    if (!db) throw new Error("the provider's database was not created");
    return db;
  };

  beforeAll(async () => {
    db = await createTestDatabase(`world_enc_${provider().name}`);
    await bootstrapWorkflowSchema(db.url);
  });

  afterAll(async () => {
    await killAllHosts();
    await db?.drop();
  });

  test("a run survives SIGKILL between hook creation and resume, and no marker is readable anywhere", async () => {
    const { name, env, kekId } = provider();
    enc = await runScenario(database().url, [ports.a, ports.b], env);
    const n = enc.nonce;
    // The run really used every payload path: everything reads back through the SDK.
    expect(enc.result.status).toBe(200);
    expect(enc.result.json.value).toEqual(expectedValue(n));
    expect(enc.stream.json.chunk).toBe(`OSMARK6_${n}`);
    expect(enc.hook.json.metadata).toEqual({ m4: `OSMARK4_${n}` });

    report({
      world: "encrypting",
      provider: name,
      markersFound: markersFound(enc.finalScan).length,
      hits: enc.finalScan.hits.length,
      hitsWhileSuspended: enc.suspendedScan.hits.length,
      tables: enc.finalScan.tables.length,
      columns: enc.finalScan.columns,
      rows: enc.finalScan.rows,
    });
    expect(enc.suspendedScan.hits).toEqual([]);
    expect(enc.finalScan.hits).toEqual([]);
    // The run's key is wrapped by the provider under test, not by some other one.
    const keys = await sql<{ kek_id: string }>(
      database().url,
      "SELECT kek_id FROM os_keys.data_keys WHERE scope = 'run' AND key_id = $1 AND wrapped_key IS NOT NULL",
      [enc.runId],
    );
    expect(keys).toEqual([{ kek_id: kekId }]);
    // Attributes cannot be encrypted: their values are replaced, except under a key the World
    // was told may stay readable.
    const [run] = await sql<{ attributes: Record<string, string> }>(
      database().url,
      "SELECT attributes FROM workflow.workflow_runs WHERE id = $1",
      [enc.runId],
    );
    expect(run?.attributes).toEqual({ note: "[withheld]", progress: "[withheld]", kind: "proof" });
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
    const { name, env } = provider();
    await enc.finalHost.kill();
    const pool = new pg.Pool({ connectionString: database().url, max: 2 });
    const keyProvider = keyProviderFromEnv(env, { keyringFileVariable: "HARNESS_KEYRING_FILE" });
    try {
      const keys = new DataKeyStore({ pool, provider: keyProvider, cacheTtlMs: 0 });
      expect(await keys.shred("run", enc.runId)).toBe(true);
    } finally {
      await keyProvider.close();
      await pool.end();
    }
    // A fresh process, so no key is left in any cache.
    const reader = await startHost({ port: ports.c, databaseUrl: database().url, env });
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
      database().url,
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
    report({ world: "encrypting", provider: name, shredded: enc.runId, rowsRemaining: rows });
    expect(rows).toMatchObject({ runs: 1, status: "completed", live_keys: 0, tombstones: 1 });
    expect(rows?.events).toBeGreaterThan(0);
    expect(rows?.steps).toBeGreaterThan(0);
    expect(rows?.chunks).toBeGreaterThan(0);
    await reader.kill();
  });

  return { db: database };
}

let stockDb: TestDatabase;

beforeAll(async () => {
  stockDb = await createTestDatabase("world_stock");
  await bootstrapWorkflowSchema(stockDb.url);
});

afterAll(async () => {
  await killAllHosts();
  await stockDb?.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("encrypting World on the keyring file", () => {
  const world = encryptingWorld(() => fileProvider, {
    a: PORTS.fileA,
    b: PORTS.fileB,
    c: PORTS.fileC,
  });

  test("an attribute set in a workflow body under an unlisted key fails the run and is not stored", async () => {
    // Replacing this one write would break replay (see src/attributes.ts), so it is refused.
    const url = world.db().url;
    const marker = `OSMARKBODY_${randomBytes(8).toString("hex")}`;
    const host = await startHost({
      port: PORTS.bodyAttribute,
      databaseUrl: url,
      env: fileProvider.env,
    });
    const started = await host.call<{ runId?: string; error?: string }>("/start-body-attribute", {
      marker,
    });
    expect(started.status, started.json.error).toBe(200);
    await expect
      .poll(async () => runStatus(url, started.json.runId ?? ""), {
        timeout: 60_000,
        interval: 200,
      })
      .toBe("failed");
    expect((await scanForMarkers(url, [marker])).hits).toEqual([]);
    await host.kill();
  });

  test("when the key method throws at start, start fails and no run row is written", async () => {
    const url = world.db().url;
    const before = await runCount(url);
    const host = await startHost({
      port: PORTS.failStart,
      databaseUrl: url,
      env: { ...fileProvider.env, HARNESS_KEY_FAIL: "1" },
    });
    const started = await host.call<{ runId?: string; error?: string }>("/start", {
      nonce: randomBytes(8).toString("hex"),
    });
    expect(started.status).toBe(500);
    expect(started.json.runId).toBeUndefined();
    expect(await runCount(url)).toEqual(before);
    await host.kill();
  });

  test("a health probe that names a run mints that run's key before the run exists, without a tenant", async () => {
    // Upstream's start() sends this probe only when starting a run on another deployment. The
    // responder asks its World for the named run's key to publish the run's public key. This
    // pins down what our World does then, so a change upstream shows up here.
    const url = world.db().url;
    const host = await startHost({ port: PORTS.probe, databaseUrl: url, env: fileProvider.env });
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
      url,
      "SELECT tenant_id, wrapped_key IS NOT NULL AS live FROM os_keys.data_keys WHERE scope = 'run' AND key_id = $1",
      [runId],
    );
    expect(rows).toEqual([{ tenant_id: null, live: true }]);
    const runs = await sql(url, "SELECT 1 FROM workflow.workflow_runs WHERE id = $1", [runId]);
    expect(runs).toHaveLength(0);
    // If a start then named a tenant for this run id, the key store refuses rather than binding
    // the run to no tenant: see DataKeyTenantMismatchError.
    const pool = new pg.Pool({ connectionString: url, max: 1 });
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

const openBaoUp = await openBaoReachable();

describe.skipIf(!openBaoUp && process.env.CI !== "true")(
  "encrypting World on OpenBao Transit (deploy/compose.test.yaml)",
  () => {
    let release: (() => Promise<void>) | undefined;
    let openbao: ProviderSetup | undefined;
    const provider = () => {
      if (!openbao) throw new Error("the OpenBao provider was not prepared");
      return openbao;
    };

    // The whole section holds the OpenBao test server: the outage below pauses it, and the
    // keys package's tests pause it too.
    beforeAll(async () => {
      release = await holdOpenBao(
        "packages/world/test/ciphertext-at-rest.test.ts",
        OPENBAO_HOLD_WAIT_MS,
      );
      const transit = await prepareTransit();
      const roleIdFile = join(dir, "openbao-role-id");
      const secretIdFile = join(dir, "openbao-secret-id");
      writeFileSync(roleIdFile, `${transit.roleId}\n`, { mode: 0o600 });
      writeFileSync(secretIdFile, `${transit.secretId}\n`, { mode: 0o600 });
      openbao = {
        name: "openbao",
        env: {
          KEY_PROVIDER: "openbao",
          OPENBAO_ADDR: OPENBAO_TEST_ADDR,
          OPENBAO_AUTH: "approle",
          OPENBAO_ROLE_ID_FILE: roleIdFile,
          OPENBAO_SECRET_ID_FILE: secretIdFile,
          OPENBAO_TRANSIT_MOUNT: transit.mount,
          OPENBAO_TRANSIT_KEY: transit.key,
          // No keyring file, so the World runs on Transit alone rather than the composite.
          HARNESS_KEYRING_FILE: "",
        },
        kekId: `bao:${transit.mount}/${transit.key}@1`,
      };
    }, OPENBAO_HOLD_WAIT_MS + 30_000);

    afterAll(async () => {
      try {
        await killAllHosts();
      } finally {
        await release?.();
      }
    });

    const world = encryptingWorld(provider, {
      a: PORTS.openbaoA,
      b: PORTS.openbaoB,
      c: PORTS.openbaoC,
    });

    test(
      "with OpenBao paused for 20 seconds, a new run is refused and stores nothing, and a run resumed during the outage completes after it",
      async () => {
        const url = world.db().url;
        const { env } = provider();
        const nonce = randomBytes(8).toString("hex");
        const token = `tok-${nonce}`;
        const first = await startHost({ port: PORTS.outageA, databaseUrl: url, env });
        const started = await first.call<{ runId?: string; error?: string }>("/start", {
          nonce,
          tenant: "ws_proof",
        });
        expect(started.status, started.json.error).toBe(200);
        const runId = started.json.runId ?? "";
        await waitForHook(url, token);
        await first.kill();
        // A fresh process signs in while OpenBao answers, then holds no data key: every key it
        // needs from here on must come from Transit.
        const host = await startHost({ port: PORTS.outageB, databaseUrl: url, env });
        const runsBefore = await runCount(url);
        const refusedNonce = randomBytes(8).toString("hex");

        type Answer = {
          status: number;
          json: { runId?: string; error?: string; chain?: { name: string; message: string }[] };
        };
        let refusedStart: Answer | undefined;
        let refusedStartMs = 0;
        let resumeDuringOutage: Answer | undefined;
        let resumeDuringOutageMs = 0;
        let statusAtUnpause: string | undefined;
        let runsAtUnpause = 0;

        await pauseOpenBao();
        const pausedAt = performance.now();
        let unpausedAt: number;
        try {
          let at = performance.now();
          refusedStart = await host.call("/start", { nonce: refusedNonce, tenant: "ws_proof" });
          refusedStartMs = performance.now() - at;
          // The run published a public key at start, so the SDK may seal the hook payload to it
          // without the run's key; the run itself cannot go on until its key unwraps.
          at = performance.now();
          resumeDuringOutage = await host.call("/resume", { token, m5: `OSMARK5_${nonce}` });
          resumeDuringOutageMs = performance.now() - at;
          await delay(Math.max(0, OUTAGE_MS - 1_000 - (performance.now() - pausedAt)));
          statusAtUnpause = await runStatus(url, runId);
          runsAtUnpause = await runCount(url);
          await delay(Math.max(0, OUTAGE_MS - (performance.now() - pausedAt)));
        } finally {
          await unpauseOpenBao();
          unpausedAt = performance.now();
        }

        // During the outage: the new run fails as unavailable and no row of it exists.
        expect(refusedStart?.status).toBe(500);
        expect(refusedStart?.json.runId).toBeUndefined();
        const chain = refusedStart?.json.chain ?? [];
        expect(
          chain.some(
            (error) =>
              error.name === "KeyProviderUnavailableError" || error.message.startsWith("openbao:"),
          ),
          JSON.stringify(chain),
        ).toBe(true);
        expect(chain.some((error) => error.name === "KeyProviderRefusedError")).toBe(false);
        expect(runsAtUnpause).toBe(runsBefore);
        // The suspended run neither finished nor failed without its key.
        expect(["completed", "failed", "cancelled"]).not.toContain(statusAtUnpause);

        // After the outage: the resume goes through (again, if it was refused), the run
        // completes with every marker read back, and new runs start.
        if (resumeDuringOutage?.status !== 200) {
          await expect
            .poll(
              async () => (await host.call("/resume", { token, m5: `OSMARK5_${nonce}` })).status,
              { timeout: RESUME_CEILING_MS, interval: 500 },
            )
            .toBe(200);
        }
        const resumedAfterMs = performance.now() - unpausedAt;
        await expect
          .poll(async () => runStatus(url, runId), {
            timeout: COMPLETION_CEILING_MS,
            interval: 250,
          })
          .toBe("completed");
        const completedAfterMs = performance.now() - unpausedAt;
        const result = await host.call<{ value?: unknown; error?: string }>(`/result/${runId}`);
        expect(result.status, result.json.error).toBe(200);
        expect(result.json.value).toEqual(expectedValue(nonce));
        const nextNonce = randomBytes(8).toString("hex");
        let at = performance.now();
        const next = await host.call<{ runId?: string; error?: string }>("/start", {
          nonce: nextNonce,
          tenant: "ws_proof",
        });
        const nextStartMs = performance.now() - at;
        expect(next.status, next.json.error).toBe(200);
        at = performance.now();
        const scan = await scanForMarkers(url, [
          ...markers(nonce),
          ...markers(refusedNonce),
          ...markers(nextNonce),
        ]);
        const scanMs = performance.now() - at;

        report({
          gate: "world-openbao-outage",
          pausedMs: Math.round(unpausedAt - pausedAt),
          refusedStartMs: Math.round(refusedStartMs),
          resumeDuringOutage: resumeDuringOutage?.status,
          resumeDuringOutageMs: Math.round(resumeDuringOutageMs),
          statusAtUnpause,
          resumedAfterUnpauseMs: Math.round(resumedAfterMs),
          completedAfterUnpauseMs: Math.round(completedAfterMs),
          nextStartMs: Math.round(nextStartMs),
          hits: scan.hits.length,
          scanMs: Math.round(scanMs),
          refusal: chain,
        });
        expect(unpausedAt - pausedAt).toBeGreaterThanOrEqual(OUTAGE_MS);
        expect(scan.hits).toEqual([]);
        await host.kill();
      },
      OUTAGE_MS + RESUME_CEILING_MS + COMPLETION_CEILING_MS + 120_000,
    );
  },
);

describe("stock Postgres World (control)", () => {
  test("the identical scenario exposes all ten markers, so the scanner can see plaintext", async () => {
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
    expect(found).toEqual(
      markers("")
        .map((marker) => marker.slice(0, -1))
        .sort(),
    );
  });
});
