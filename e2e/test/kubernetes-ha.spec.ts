/**
 * The HA Postgres gate (specs/beyond-one-machine.md, milestone 6), against the kind stack that
 * `e2e/run-k8s.sh --ha` starts from `deploy/k8s/overlays/kind-ha`: the kind stack with Postgres
 * as the CloudNativePG cluster `os-db` of three instances, quorum commit to one standby and
 * `dataDurability: required`.
 *
 * In order, on one installation: the cluster is what the component says and the isolation probe
 * passes; a payment confirms; the primary is deleted while a payment is being signed, and that
 * payment still ends confirmed with exactly one transaction; after the failover both server
 * replicas are ready again, a new payment confirms, every `LISTEN` connection a replica had
 * before is back (this answers the plan's open question about the World's listeners), both
 * replicas hold the workflow-bundle lock and another bundle is refused, and a shred made on one
 * replica is heard by the other at once; last, with both standbys gone, a write waits instead of
 * committing on the primary alone, and lands once a standby returns. Measured times are printed
 * as JSON lines starting with `{"gate":`.
 *
 * Postgres is read through `psql` inside the instances (`kubectl exec`, the local superuser),
 * never through a Service, so the gate opens no way in that the policies would have to allow.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PolicyDraft } from "@askgina/os-api";
import { expect, test } from "@playwright/test";
import { formatEther, parseEther } from "viem";
import { z } from "zod";
import { chain, withMiningHeld } from "../src/chain.ts";
import {
  CHAIN,
  intentSettles,
  type PayingAgent,
  payingAgent,
  propose,
} from "../src/installation.ts";
import { Person } from "../src/person.ts";
import { stack } from "../src/stack.ts";

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const NAMESPACE = "os";
const CLUSTER = "os-db";
const RECIPIENT = "0x00000000000000000000000000000000000c0ffe";
const PROBE = "deploy/k8s/isolation-probe.yaml";
const PROBE_LABEL = "app.kubernetes.io/name=isolation-probe";
const PROBE_JOBS = [
  "isolation-probe-agent",
  "isolation-probe-bystander",
  "isolation-probe-outsider",
] as const;
/** `apps/server/src/execution/bundle-guard.ts`: the class of the shared bundle lock. */
const BUNDLE_LOCK_CLASS = 18_680;
/** The bundle the server image runs (`GENERATED_DIR` in `workflow-runtime.ts`). */
const FLOW_FILE = "/app/apps/server/.well-known/workflow/v1/flow.mjs";
const SHRED_CHANNEL = "os_keys_shred";
const tag = Date.now().toString(36);

let ada: Person;
let payer: PayingAgent;
/** Each server pod's restarts when the stack came up; none may be added by a failover. */
let restartsAtStart = new Map<string, number>();
/** Per server pod address, the channels it listened on just before the primary was deleted. */
let listenedBefore = new Map<string, Set<string>>();
let failoverAt = 0;

const seconds = (since: number): number => Math.round((Date.now() - since) / 100) / 10;
const report = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/** Run `kubectl ...` from the repository root and return its stdout. */
async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await run("kubectl", args, {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  return stdout;
}

/** Ask `probe` once a second until it returns a value, for up to `timeoutMs`. */
async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no ${what} after ${timeoutMs / 1000} s${last ? ` (last error: ${last})` : ""}`,
      );
    }
    await delay(1_000);
  }
}

const Cluster = z.object({
  spec: z.object({
    instances: z.number(),
    postgresql: z.object({
      synchronous: z.object({
        method: z.string(),
        number: z.number(),
        dataDurability: z.string().optional(),
      }),
      parameters: z.record(z.string(), z.string()).optional(),
    }),
  }),
  status: z.object({
    phase: z.string().optional(),
    currentPrimary: z.string().optional(),
    targetPrimary: z.string().optional(),
    readyInstances: z.number().optional(),
    instanceNames: z.array(z.string()).optional(),
  }),
});

async function cluster(): Promise<z.infer<typeof Cluster>> {
  return Cluster.parse(
    JSON.parse(
      await kubectl(
        "get",
        "clusters.postgresql.cnpg.io",
        "--namespace",
        NAMESPACE,
        CLUSTER,
        "-o",
        "json",
      ),
    ),
  );
}

/** One statement through `psql` inside an instance, as the local superuser; its output. */
async function sql(instance: string, query: string): Promise<string> {
  return (
    await kubectl(
      "exec",
      "--namespace",
      NAMESPACE,
      instance,
      "--container",
      "postgres",
      "--",
      "psql",
      "--dbname",
      "os",
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
      "--command",
      query,
    )
  ).trim();
}

async function rows<T>(instance: string, query: string, row: z.ZodType<T>): Promise<T[]> {
  const output = await sql(instance, `SELECT coalesce(json_agg(r), '[]'::json) FROM (${query}) r`);
  return z.array(row).parse(JSON.parse(output));
}

/** The instance the operator names primary, once it takes writes; not `not`, if given. */
async function primaryInstance(timeoutMs = 180_000, not?: string): Promise<string> {
  return until("primary that takes writes", timeoutMs, async () => {
    const name = (await cluster()).status.currentPrimary;
    if (name === undefined || name === not) return undefined;
    return (await sql(name, "SELECT pg_is_in_recovery()")) === "f" ? name : undefined;
  });
}

async function threeInstancesReady(timeoutMs: number): Promise<void> {
  await until("three ready instances", timeoutMs, async () =>
    (await cluster()).status.readyInstances === 3 ? true : undefined,
  );
}

const ServerPods = z.object({
  items: z.array(
    z.object({
      metadata: z.object({ name: z.string() }),
      status: z.object({
        podIP: z.string().optional(),
        containerStatuses: z.array(z.object({ restartCount: z.number() })).optional(),
      }),
    }),
  ),
});

async function serverPods(): Promise<{ name: string; ip: string; restarts: number }[]> {
  const pods = ServerPods.parse(
    JSON.parse(
      await kubectl(
        "get",
        "pods",
        "--namespace",
        NAMESPACE,
        "--selector",
        "app.kubernetes.io/name=server",
        "-o",
        "json",
      ),
    ),
  ).items;
  return pods
    .map((pod) => ({
      name: pod.metadata.name,
      ip: pod.status.podIP ?? "",
      restarts: (pod.status.containerStatuses ?? []).reduce((sum, c) => sum + c.restartCount, 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function expectNoServerRestarted(): Promise<void> {
  const now = await serverPods();
  expect(now.map((pod) => pod.name)).toEqual([...restartsAtStart.keys()]);
  for (const pod of now) expect(pod.restarts, pod.name).toBe(restartsAtStart.get(pod.name));
}

/** The JSON objects one server pod logged, oldest first. */
async function logLines(pod: string): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const logs = await kubectl("logs", "--namespace", NAMESPACE, pod, "--container", "server");
  for (const line of logs.split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        lines.push(parsed as Record<string, unknown>);
      }
    } catch {}
  }
  return lines;
}

/** The server pod that logged `step.started` for `approvalId`'s signing step, once one has. */
async function podThatStartsSigning(approvalId: string, timeoutMs: number): Promise<string> {
  return until(`signing step for ${approvalId}`, timeoutMs, async () => {
    for (const pod of await serverPods()) {
      const started = (await logLines(pod.name)).some(
        (line) =>
          line.event === "step.started" && line.approvalId === approvalId && line.step === "sign",
      );
      if (started) return pod.name;
    }
    return undefined;
  });
}

/** Run Node inside a server pod, with the server's environment and `env`; its last line. */
async function nodeIn(
  pod: string,
  script: string,
  env: Record<string, string> = {},
  inputType: "commonjs" | "module" = "module",
): Promise<string> {
  const output = await kubectl(
    "exec",
    "--namespace",
    NAMESPACE,
    pod,
    "--container",
    "server",
    "--",
    "env",
    ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
    "node",
    `--input-type=${inputType}`,
    "-e",
    script,
  );
  return output.trim().split("\n").at(-1) ?? "";
}

/** What `GET /readyz` answers inside one server pod, on its own port. */
async function readyzIn(pod: string): Promise<string> {
  return nodeIn(
    pod,
    "fetch('http://127.0.0.1:3000/readyz').then((r) => console.log(r.status), () => console.log('unreachable'))",
  );
}

const API_GET = `
  const http = require("node:http");
  const request = http.request({
    host: "127.0.0.1", port: 3000, path: process.env.API_PATH, method: "GET",
    headers: { host: process.env.API_HOST, origin: process.env.API_ORIGIN, cookie: process.env.API_COOKIE },
  }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => console.log(JSON.stringify({ status: response.statusCode, body: body.slice(0, 300) })));
  });
  request.on("error", (error) => console.log(JSON.stringify({ status: 0, body: String(error) })));
  request.end();`;

/** A person's `GET` answered by one server pod itself, not by whichever the edge picks. */
async function getFrom(pod: string, path: string, cookie: string): Promise<number> {
  const answer = z.object({ status: z.number(), body: z.string() }).parse(
    JSON.parse(
      await nodeIn(
        pod,
        API_GET,
        {
          API_PATH: path,
          API_HOST: new URL(stack.origin).host,
          API_ORIGIN: stack.origin,
          API_COOKIE: cookie,
        },
        "commonjs",
      ),
    ),
  );
  return answer.status;
}

/** The session cookie `person` sends, seen on the way out of one of their requests. */
async function sessionCookie(person: Person): Promise<string> {
  const original = globalThis.fetch;
  const seen: { cookie?: string } = {};
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.cookie = new Headers(init?.headers).get("cookie") ?? undefined;
    return original(input, init);
  }) as typeof fetch;
  try {
    await person.api.call("getSession");
  } finally {
    globalThis.fetch = original;
  }
  if (seen.cookie === undefined) throw new Error(`${person.name} sends no session cookie`);
  return seen.cookie;
}

/** The server's own modules, loaded inside its pod the way `apps/server/src/cli.ts` runs. */
const SERVER_PRELUDE = `
  import { createRequire } from "node:module";
  import { loadConfig } from "/app/apps/server/src/config.ts";
  const pg = createRequire("/app/apps/server/src/main.ts")("pg");
  const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 2 });`;

/** A process with another workflow bundle, and one with the server's own, try to start. */
const BUNDLE_ATTEMPTS = `${SERVER_PRELUDE}
  import { writeFile } from "node:fs/promises";
  import { BundleMismatchError, holdBundleLock } from "/app/apps/server/src/execution/bundle-guard.ts";
  const attempt = async (flowFile) => {
    try {
      const lock = await holdBundleLock(pool, flowFile, () => {});
      await lock.release();
      return "accepted";
    } catch (error) {
      return error instanceof BundleMismatchError ? "refused" : "failed: " + (error && error.name);
    }
  };
  await writeFile("/tmp/another-flow.mjs", "export const another = true;\\n");
  const other = await attempt("/tmp/another-flow.mjs");
  const same = await attempt(process.env.FLOW_FILE);
  await pool.end();
  console.log(JSON.stringify({ other, same }));`;

/** The data-key store's own shred of a workspace's key, announced to every listener. */
const SHRED = `${SERVER_PRELUDE}
  import { DataKeyStore, keyProviderFromEnv } from "/app/packages/keys/src/index.ts";
  const keys = new DataKeyStore({ pool, provider: keyProviderFromEnv(process.env, { keyringFileVariable: "KEYRING_FILE" }) });
  const destroyed = await keys.shred("workspace", process.env.SHRED_WORKSPACE);
  await keys.close();
  await pool.end();
  console.log(JSON.stringify({ destroyed }));`;

/** Per client address, the channels its connections to `instance` listen on. */
async function listeners(instance: string): Promise<Map<string, Set<string>>> {
  const found = await rows(
    instance,
    `SELECT host(client_addr) AS address, substr(query, 8) AS channel FROM pg_stat_activity
     WHERE datname = 'os' AND client_addr IS NOT NULL AND query ILIKE 'LISTEN %'`,
    z.object({ address: z.string(), channel: z.string() }),
  );
  const byAddress = new Map<string, Set<string>>();
  for (const { address, channel } of found) {
    byAddress.set(address, (byAddress.get(address) ?? new Set()).add(channel.trim()));
  }
  return byAddress;
}

/** The client addresses holding the shared workflow-bundle lock on `instance`. */
async function bundleHolders(instance: string): Promise<string[]> {
  const found = await rows(
    instance,
    `SELECT DISTINCT host(a.client_addr) AS address FROM pg_locks l
     JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.granted AND l.classid = ${BUNDLE_LOCK_CLASS}
       AND l.objsubid = 2 AND a.client_addr IS NOT NULL`,
    z.object({ address: z.string() }),
  );
  return found.map((row) => row.address).sort();
}

const Job = z.object({
  metadata: z.object({ name: z.string(), namespace: z.string() }),
  status: z.object({
    conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
  }),
});

/** Run the isolation probe's Jobs afresh; each Job's outcome and log, by name. */
async function runProbe(): Promise<Record<string, { outcome: string; log: string }>> {
  await kubectl(
    "delete",
    "jobs",
    "--all-namespaces",
    "--selector",
    PROBE_LABEL,
    "--ignore-not-found",
    "--cascade=foreground",
    "--wait=true",
  );
  await kubectl("apply", "--filename", PROBE);
  return until("finished isolation probe", 240_000, async () => {
    const jobs = z
      .object({ items: z.array(Job) })
      .parse(
        JSON.parse(
          await kubectl("get", "jobs", "--all-namespaces", "--selector", PROBE_LABEL, "-o", "json"),
        ),
      ).items;
    const finished = jobs.flatMap((job) => {
      const done = job.status.conditions?.find(
        (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
      );
      return done ? [{ job, outcome: done.type === "Complete" ? "succeeded" : "failed" }] : [];
    });
    if (jobs.length !== PROBE_JOBS.length || finished.length !== jobs.length) return undefined;
    const results: Record<string, { outcome: string; log: string }> = {};
    for (const { job, outcome } of finished) {
      const log = await kubectl(
        "logs",
        "--namespace",
        job.metadata.namespace,
        `job/${job.metadata.name}`,
      ).catch((error: unknown) => `no log: ${String(error)}`);
      results[job.metadata.name] = { outcome, log };
    }
    return results;
  });
}

/** Run the probe's script with `checks` inside a running container; its output either way. */
async function probeInside(
  namespace: string,
  target: string,
  checks: object[],
): Promise<{ ok: boolean; output: string }> {
  const script = await kubectl(
    "get",
    "job",
    "--namespace",
    "os-agents",
    "isolation-probe-agent",
    "-o",
    "jsonpath={.spec.template.spec.containers[0].args[0]}",
  );
  if (!script.includes("PROBE_CHECKS")) throw new Error(`no probe script in ${PROBE}'s agent Job`);
  try {
    const output = await kubectl(
      "exec",
      "--namespace",
      namespace,
      target,
      "--",
      "node",
      "-e",
      script,
      JSON.stringify(checks),
      "0",
    );
    return { ok: true, output };
  } catch (error) {
    const output =
      error instanceof Error && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
    return { ok: false, output: `${output}\n${String(error)}` };
  }
}

/** The agent pays 0.01 ETH, Ada approves, and it lands as exactly one transaction. */
async function paymentLandsOnce(memo: string, timeoutMs: number): Promise<number> {
  const started = Date.now();
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: payer.wallet.address });
  const { intentId, approvalId } = await propose(payer.agent, RECIPIENT, "0.01", memo);
  await ada.confirm(approvalId);
  expect(await intentSettles(ada, intentId, timeoutMs)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: payer.wallet.address })).toBe(nonceBefore + 1);
  return seconds(started);
}

/** A workspace with an agent and a waiting policy request, whose detail is sealed. */
async function sealedRequest(name: string): Promise<{ workspaceId: string; approvalId: string }> {
  const workspace = await ada.api.call("createWorkspace", { body: { name } });
  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Reader" },
  });
  const draft: PolicyDraft = {
    chains: [CHAIN],
    requesters: [created.agent.id as PolicyDraft["requesters"][number]],
    assets: [
      {
        chainId: CHAIN,
        asset: "native",
        maxPerTx: parseEther("0.01").toString(),
        maxPerDay: parseEther("0.02").toString(),
      },
    ],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: parseEther("0.01").toString() },
    approvals: { threshold: 1, ttlSeconds: 3600 },
  };
  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId: workspace.id, walletId: created.wallet.id },
    body: { draft },
  });
  return { workspaceId: workspace.id, approvalId: request.id };
}

test.afterAll(async () => {
  await payer?.agent.close();
});

test("the database is three instances that commit only with a standby, and the server uses its read-write Service", async () => {
  const state = await cluster();
  expect(state.spec.instances).toBe(3);
  expect(state.status.readyInstances).toBe(3);
  expect(state.spec.postgresql.synchronous).toMatchObject({
    method: "any",
    number: 1,
    dataDurability: "required",
  });
  const primary = await primaryInstance();
  expect(await sql(primary, "SHOW max_connections")).toBe("200");
  expect(await sql(primary, "SHOW synchronous_standby_names")).toMatch(/^ANY 1 \(/);
  const standbys = await rows(
    primary,
    "SELECT application_name, state, sync_state FROM pg_stat_replication",
    z.object({ application_name: z.string(), state: z.string(), sync_state: z.string() }),
  );
  expect(
    standbys.filter((s) => s.state === "streaming" && s.sync_state === "quorum"),
    JSON.stringify(standbys),
  ).toHaveLength(2);

  const pods = await serverPods();
  expect(pods).toHaveLength(2);
  restartsAtStart = new Map(pods.map((pod) => [pod.name, pod.restarts]));
  for (const pod of pods) {
    expect(await nodeIn(pod.name, "console.log(process.env.DATABASE_URL)", {}, "commonjs")).toBe(
      "postgres://os@os-db-rw.os.svc:5432/os",
    );
    expect(await readyzIn(pod.name), pod.name).toBe("200");
  }
  report({ gate: "ha-up", primary, standbys: standbys.map((s) => s.application_name) });
});

test("the isolation probe passes, and only the server and the instances reach Postgres", async () => {
  const results = await runProbe();
  expect(Object.keys(results).sort()).toEqual([...PROBE_JOBS].sort());
  for (const [job, result] of Object.entries(results)) {
    expect(result.outcome, `${job}:\n${result.log}`).toBe("succeeded");
  }

  const readWrite = (
    await kubectl(
      "get",
      "service",
      "--namespace",
      NAMESPACE,
      `${CLUSTER}-rw`,
      "-o",
      "jsonpath={.spec.clusterIP}",
    )
  ).trim();
  for (const [namespace, target] of [
    ["os-signer", "statefulset/signer"],
    ["os-signer", "deployment/approve"],
  ] as const) {
    const probe = await probeInside(namespace, target, [
      { name: "not Postgres", tcp: { host: readWrite, port: 5432 }, expect: "blocked" },
      { name: "not an instance manager", tcp: { host: readWrite, port: 8000 }, expect: "blocked" },
    ]);
    expect(probe.ok, `${target}: ${probe.output}`).toBe(true);
  }
});

test("the installation is claimed with a setup token from the operator's command, and a payment lands once", async () => {
  test.setTimeout(300_000);
  const printed = await kubectl(
    "exec",
    "--namespace",
    NAMESPACE,
    "deployment/server",
    "--",
    "node",
    "apps/server/src/cli.ts",
    "setup-token",
  );
  const answer = z
    .object({ ok: z.literal(true), setupToken: z.string().min(16) })
    .parse(JSON.parse(printed.trim().split("\n").at(-1) ?? ""));
  ada = new Person(stack.origin, "Ada");
  expect((await ada.setUp(answer.setupToken)).setupRequired).toBe(false);

  payer = await payingAgent(ada, `HA ${tag}`);
  report({
    gate: "first-payment",
    confirmedAfterSeconds: await paymentLandsOnce("before", 120_000),
  });
});

test("the primary is deleted while a payment is being signed, and the payment lands once", async () => {
  // A minute for the step to start, three for the failover and the payment, five for the old
  // primary to rejoin.
  test.setTimeout(900_000);
  const oldPrimary = await primaryInstance();
  listenedBefore = await listeners(oldPrimary);
  const auditBefore = await ada.api.call("verifyAudit", {
    params: { workspaceId: payer.workspace.id },
  });
  expect(auditBefore.ok).toBe(true);
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: payer.wallet.address });
  const { intentId, approvalId } = await propose(
    payer.agent,
    RECIPIENT,
    "0.01",
    "survives a failover",
  );

  let signingPod = "";
  let newPrimary = "";
  let promotedAfter = 0;
  // With mining held, the payment cannot confirm before the primary is gone, whatever the step
  // has reached; the approval's answer may wait on the database, so it is not awaited first.
  await withMiningHeld(async ({ resume }) => {
    const approving = ada.confirm(approvalId).catch((error: unknown) => error);
    signingPod = await podThatStartsSigning(approvalId, 60_000);
    failoverAt = Date.now();
    await kubectl(
      "delete",
      "pod",
      "--namespace",
      NAMESPACE,
      oldPrimary,
      "--grace-period=0",
      "--force",
      "--wait=false",
    );
    newPrimary = await primaryInstance(180_000, oldPrimary);
    promotedAfter = seconds(failoverAt);
    await approving;
    await resume();
  });

  expect(await intentSettles(ada, intentId, 180_000)).toBe("confirmed");
  const confirmedAfter = seconds(failoverAt);
  expect(confirmedAfter).toBeLessThanOrEqual(180);
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: payer.wallet.address })).toBe(nonceBefore + 1);

  const auditAfter = await ada.api.call("verifyAudit", {
    params: { workspaceId: payer.workspace.id },
  });
  expect(auditAfter.ok, JSON.stringify(auditAfter)).toBe(true);
  expect(auditAfter.checked).toBeGreaterThanOrEqual(auditBefore.checked);

  await threeInstancesReady(300_000);
  const threeInstancesAfter = seconds(failoverAt);
  await expectNoServerRestarted();
  report({
    gate: "primary-deleted",
    oldPrimary,
    newPrimary,
    signingPod,
    promotedAfterSeconds: promotedAfter,
    paymentConfirmedAfterSeconds: confirmedAfter,
    threeInstancesAfterSeconds: threeInstancesAfter,
    auditEntries: { before: auditBefore.checked, after: auditAfter.checked },
  });
});

test("after the failover both replicas are ready and a new payment lands once", async () => {
  test.setTimeout(300_000);
  for (const pod of await serverPods()) {
    await until(`/readyz 200 on ${pod.name}`, 120_000, async () =>
      (await readyzIn(pod.name)) === "200" ? true : undefined,
    );
  }
  const readyAfter = seconds(failoverAt);
  const confirmedIn = await paymentLandsOnce("after the failover", 120_000);
  await expectNoServerRestarted();
  report({
    gate: "after-failover",
    bothReadyAfterSeconds: readyAfter,
    paymentSeconds: confirmedIn,
  });
});

test("every LISTEN a replica had before the failover is back, and both replicas hold the bundle lock", async () => {
  test.setTimeout(300_000);
  const pods = await serverPods();
  const addresses = pods.map((pod) => pod.ip).sort();
  const primary = await primaryInstance();

  // Each pod listened for shreds before; the World's listeners open on first use, so whatever
  // each pod had then (run status, run events, streams) must be there again.
  for (const address of addresses) {
    expect(listenedBefore.get(address), `${address} before the failover`).toContain(SHRED_CHANNEL);
  }
  const listenedAfter = await until("restored listeners", 120_000, async () => {
    const now = await listeners(primary);
    const missing = [...listenedBefore].some(([address, channels]) =>
      [...channels].some((channel) => !now.get(address)?.has(channel)),
    );
    return missing ? undefined : now;
  });
  const restoredAfter = seconds(failoverAt);

  expect(
    await until("bundle lock held by both replicas", 120_000, async () => {
      const holders = await bundleHolders(primary);
      return holders.join() === addresses.join() ? holders : undefined;
    }),
  ).toEqual(addresses);

  const attempts = z
    .object({ other: z.string(), same: z.string() })
    .parse(JSON.parse(await nodeIn(pods[0]?.name ?? "", BUNDLE_ATTEMPTS, { FLOW_FILE })));
  expect(attempts).toEqual({ other: "refused", same: "accepted" });

  report({
    gate: "listeners-and-bundle-lock",
    before: Object.fromEntries([...listenedBefore].map(([a, channels]) => [a, [...channels]])),
    after: Object.fromEntries([...listenedAfter].map(([a, channels]) => [a, [...channels]])),
    restoredAfterSeconds: restoredAfter,
    bundleLockHolders: addresses,
    anotherBundle: attempts.other,
  });
});

test("a shred made on one replica is heard by the other at once", async () => {
  test.setTimeout(300_000);
  const [first = "", second = "", ...others] = (await serverPods()).map((pod) => pod.name);
  expect(others).toEqual([]);
  expect(second, "two server pods").not.toBe("");
  const cookie = await sessionCookie(ada);
  const heard: Record<string, number> = {};
  const directions: [reader: string, shredder: string][] = [
    [first, second],
    [second, first],
  ];

  for (const [reader, shredder] of directions) {
    const { workspaceId, approvalId } = await sealedRequest(`Shred ${tag} ${reader}`);
    const path = `/api/v1/approvals/${approvalId}`;
    // The reader opens the sealed detail, which caches the workspace's key: a store caches only
    // while it listens (packages/keys/src/data-key-store.ts).
    expect(await getFrom(reader, path, cookie)).toBe(200);
    // The key is tombstoned in the table with no announcement. A reader that still answers is
    // serving its cache, which proves it listens; one that did not listen would fail here.
    const primary = await primaryInstance();
    expect(
      await sql(
        primary,
        `UPDATE os_keys.data_keys SET kek_id = NULL, wrapped_key = NULL, shredded_at = now()
         WHERE scope = 'workspace' AND key_id = '${workspaceId}' AND shredded_at IS NULL
         RETURNING key_id`,
      ),
    ).toBe(workspaceId);
    expect(await getFrom(reader, path, cookie)).toBe(200);

    // The other replica's data-key store shreds it and announces it; the reader drops the key.
    const shredAt = Date.now();
    expect(JSON.parse(await nodeIn(shredder, SHRED, { SHRED_WORKSPACE: workspaceId }))).toEqual({
      destroyed: false,
    });
    const status = await until(`${reader} to drop the shredded key`, 5_000, async () => {
      const answer = await getFrom(reader, path, cookie);
      return answer === 200 ? undefined : answer;
    });
    expect(status).toBeGreaterThanOrEqual(400);
    heard[`${shredder} -> ${reader}`] = seconds(shredAt);
  }
  report({ gate: "shred-across-replicas", heardAfterSeconds: heard });
});

test("with both standbys gone a write waits instead of committing alone, and lands once one returns", async () => {
  test.setTimeout(900_000);
  const primary = await primaryInstance();
  const standbys = ((await cluster()).status.instanceNames ?? []).filter(
    (name) => name !== primary,
  );
  expect(standbys).toHaveLength(2);
  const node = (
    await kubectl(
      "get",
      "pod",
      "--namespace",
      NAMESPACE,
      primary,
      "-o",
      "jsonpath={.spec.nodeName}",
    )
  ).trim();
  const countWorkspaces = () => sql(primary, "SELECT count(*) FROM os.workspaces");
  const workspacesBefore = Number(await countWorkspaces());

  const write: { settled: boolean; outcome?: unknown } = { settled: false };
  let deletedAt = 0;
  let writtenAt = 0;
  let waiting = Promise.resolve();
  try {
    // The node takes no new pod, so the operator's replacements stay Pending until uncordoned.
    await kubectl("cordon", node);
    deletedAt = Date.now();
    await kubectl(
      "delete",
      "pod",
      "--namespace",
      NAMESPACE,
      ...standbys,
      "--grace-period=0",
      "--force",
      "--wait=false",
    );
    // Gone from the primary's view: no WAL sender left (CloudNativePG's wal_sender_timeout is
    // seconds, not minutes).
    await until("no standby connected to the primary", 120_000, async () =>
      (await sql(primary, "SELECT count(*) FROM pg_stat_replication")) === "0" ? true : undefined,
    );
    writtenAt = Date.now();
    waiting = ada.api.call("createWorkspace", { body: { name: `Paused ${tag}` } }).then(
      (outcome) => {
        write.settled = true;
        write.outcome = outcome;
      },
      (error: unknown) => {
        write.settled = true;
        write.outcome = error;
      },
    );
    await delay(20_000);
    expect(write.settled, "the write answered with no standby to confirm it").toBe(false);
    // Not visible either: the commit waits on a standby, so the row is not committed yet.
    expect(Number(await countWorkspaces())).toBe(workspacesBefore);
    expect(
      Number(
        await sql(primary, "SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'SyncRep'"),
      ),
    ).toBeGreaterThan(0);
  } finally {
    await kubectl("uncordon", node);
  }
  const uncordonedAt = Date.now();

  await until("the waiting write to answer", 300_000, async () =>
    write.settled ? true : undefined,
  );
  await waiting;
  const landedAfterUncordon = seconds(uncordonedAt);
  expect(write.outcome).toMatchObject({ name: `Paused ${tag}` });
  expect(Number(await countWorkspaces())).toBe(workspacesBefore + 1);

  await threeInstancesReady(300_000);
  for (const pod of await serverPods()) {
    await until(`/readyz 200 on ${pod.name}`, 120_000, async () =>
      (await readyzIn(pod.name)) === "200" ? true : undefined,
    );
  }
  await expectNoServerRestarted();
  report({
    gate: "no-standby",
    deletedStandbys: standbys,
    writeWaitedSeconds: seconds(writtenAt),
    landedAfterStandbyAllowedBackSeconds: landedAfterUncordon,
    threeInstancesAfterSeconds: seconds(deletedAt),
  });
});
