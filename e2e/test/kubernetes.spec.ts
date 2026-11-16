/**
 * The Kubernetes gate (specs/beyond-one-machine.md), against the kind stack that
 * `e2e/run-k8s.sh` starts from `deploy/k8s/overlays/kind` and publishes with
 * `kubectl port-forward` on the origins the Compose gates use. It checks that both server
 * replicas are ready and alone in their pods, that the isolation probe passes and is not blind,
 * that the signer and its confirmation service are held to their policies, and that a person
 * claims the installation, approves an agent's payment on the signer's confirmation page, and
 * the payment lands once.
 *
 * The tests run in order and share one installation.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PolicyDraft } from "@askgina/os-api";
import { expect, test } from "@playwright/test";
import { formatEther, parseEther } from "viem";
import { z } from "zod";
import { connectAgent } from "../src/agent.ts";
import { chain, chainAdmin } from "../src/chain.ts";
import { Person } from "../src/person.ts";
import { ExecFailure, stack } from "../src/stack.ts";

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);

const ROOT = join(import.meta.dirname, "..", "..");

const OVERLAY = "deploy/k8s/overlays/kind";

const PROBE = "deploy/k8s/isolation-probe.yaml";

const PROBE_LABEL = "app.kubernetes.io/name=isolation-probe";

/** The probe's Jobs, as `deploy/k8s/isolation-probe.yaml` names them. */
const PROBE_JOBS = [
  "isolation-probe-agent",
  "isolation-probe-bystander",
  "isolation-probe-outsider",
] as const;

const CHAIN = "eip155:31337";

const RECIPIENT = "0x00000000000000000000000000000000000a11ce";

const ada = new Person(stack.origin, "Ada");

/** A `${NAME}` placeholder the probe fills from the environment of the pod it runs in. */
const fromEnv = (name: string): string => `$\{${name}}`;

/** Run `kubectl ...` from the repository root and return its stdout. */
async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await run("kubectl", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

  return stdout;
}

const Pod = z.object({
  metadata: z.object({
    name: z.string(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  spec: z.object({
    containers: z.array(z.object({ name: z.string() })),
    initContainers: z.array(z.object({ name: z.string() })).optional(),
    ephemeralContainers: z.array(z.object({ name: z.string() })).optional(),
  }),
  status: z.object({
    conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
  }),
});

const Deployment = z.object({
  spec: z.object({ replicas: z.number() }),
  status: z.object({ readyReplicas: z.number().optional() }),
});

const Job = z.object({
  metadata: z.object({ name: z.string(), namespace: z.string() }),
  status: z.object({
    conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
  }),
});

interface ProbeResult {
  outcome: "succeeded" | "failed";
  log: string;
}

/** Run the probe's Jobs afresh and wait for each to succeed or fail; returns them by name. */
async function runProbe(): Promise<Record<string, ProbeResult>> {
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
  const deadline = Date.now() + 240_000;

  for (;;) {
    const jobs = z
      .object({ items: z.array(Job) })
      .parse(
        JSON.parse(
          await kubectl("get", "jobs", "--all-namespaces", "--selector", PROBE_LABEL, "-o", "json"),
        ),
      ).items;

    const finished = jobs.flatMap((job) => {
      const condition = job.status.conditions?.find(
        (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
      );

      if (!condition) return [];

      const outcome: ProbeResult["outcome"] =
        condition.type === "Complete" ? "succeeded" : "failed";

      return [{ job, outcome }];
    });

    if (jobs.length === PROBE_JOBS.length && finished.length === jobs.length) {
      const results: Record<string, ProbeResult> = {};

      for (const { job, outcome } of finished) {
        const log = await kubectl(
          "logs",
          "--namespace",
          job.metadata.namespace,
          `job/${job.metadata.name}`,
        ).catch((cause: unknown) => `no log: ${String(cause)}`);

        results[job.metadata.name] = { outcome, log };
      }

      return results;
    }

    if (Date.now() > deadline) {
      throw new Error(`the isolation probe did not finish:\n${JSON.stringify(jobs, null, 2)}`);
    }

    await delay(1000);
  }
}

function expectAllSucceeded(results: Record<string, ProbeResult>): void {
  expect(Object.keys(results).sort()).toEqual([...PROBE_JOBS].sort());

  for (const [job, result] of Object.entries(results)) {
    expect(result.outcome, `${job}:\n${result.log}`).toBe("succeeded");
  }
}

/**
 * The probe's own script, as Kubernetes read it from the manifest: from the agent Job the probe
 * test above applied (every Job shares one script).
 */
async function probeScript(): Promise<string> {
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

  return script;
}

/** Run the probe's script with `checks` inside a running container; its output either way. */
async function probeInside(
  namespace: string,
  target: string,
  checks: object[],
): Promise<{ ok: boolean; output: string }> {
  const script = await probeScript();

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
    // execFile's error carries the command's stdout: the probe's lines, the evidence.
    const output = ExecFailure.parse(error).stdout;

    return { ok: false, output: `${output}\n${String(error)}` };
  }
}

async function clusterIp(namespace: string, service: string): Promise<string> {
  return (
    await kubectl(
      "get",
      "service",
      "--namespace",
      namespace,
      service,
      "-o",
      "jsonpath={.spec.clusterIP}",
    )
  ).trim();
}

async function intentSettles(intentId: string, timeoutMs = 120_000): Promise<string> {
  const pending = ["proposed", "pending_approval", "approved", "signed", "broadcast"];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { status } = await ada.api.call("getIntent", { params: { intentId } });

    if (!pending.includes(status)) return status;

    if (Date.now() > deadline) throw new Error(`intent ${intentId} is still ${status}`);
    await delay(250);
  }
}

test("two server replicas are ready, each pod with one container that no mesh may join", async () => {
  const deployment = Deployment.parse(
    JSON.parse(await kubectl("get", "deployment", "--namespace", "os", "server", "-o", "json")),
  );

  expect(deployment.spec.replicas).toBe(2);
  expect(deployment.status.readyReplicas).toBe(2);

  const pods = z
    .object({ items: z.array(Pod) })
    .parse(
      JSON.parse(
        await kubectl(
          "get",
          "pods",
          "--namespace",
          "os",
          "--selector",
          "app.kubernetes.io/name=server",
          "-o",
          "json",
        ),
      ),
    ).items;

  expect(pods.map((pod) => pod.metadata.name)).toHaveLength(2);

  for (const pod of pods) {
    const ready = pod.status.conditions?.find((condition) => condition.type === "Ready");
    expect(ready?.status, `${pod.metadata.name} is not Ready`).toBe("True");
    expect(pod.spec.containers.map((container) => container.name)).toEqual(["server"]);
    // A native sidecar is an init container that keeps running.
    expect(pod.spec.initContainers ?? []).toEqual([]);
    expect(pod.spec.ephemeralContainers ?? []).toEqual([]);
    expect(pod.metadata.labels?.["sidecar.istio.io/inject"]).toBe("false");
    expect(pod.metadata.annotations?.["linkerd.io/inject"]).toBe("disabled");
  }
});

test("the isolation probe passes, and fails once a namespace's default-deny policy is gone", async () => {
  expectAllSucceeded(await runProbe());

  // The control: without `default-deny` in `os`, a pod there with no role reaches DNS, the
  // Kubernetes API and the edge, and the probe must say so.
  let broken: Record<string, ProbeResult>;

  try {
    await kubectl("delete", "networkpolicy", "--namespace", "os", "default-deny");
    broken = await runProbe();
  } finally {
    await kubectl("apply", "--kustomize", OVERLAY);
  }

  const bystander = broken["isolation-probe-bystander"];
  expect(bystander?.outcome, bystander?.log).toBe("failed");
  expect(bystander?.log).toContain('"got":"open"');

  expectAllSucceeded(await runProbe());
});

test("the signer reaches nothing, and the confirmation service reaches only the signer", async () => {
  const server = await clusterIp("os", "server");
  const postgres = await clusterIp("os", "postgres");
  const approveEdge = await clusterIp("os-signer", "approve-edge");

  const shared = [
    { name: "no DNS", dns: "kubernetes.default.svc.cluster.local", expect: "blocked" },
    {
      name: "no Kubernetes API",
      tcp: { host: fromEnv("KUBERNETES_SERVICE_HOST"), port: fromEnv("KUBERNETES_SERVICE_PORT") },
      expect: "blocked",
    },
    { name: "no internet", tcp: { host: "1.1.1.1", port: 443 }, expect: "blocked" },
    { name: "not the server", tcp: { host: server, port: 3000 }, expect: "blocked" },
    { name: "not Postgres", tcp: { host: postgres, port: 5432 }, expect: "blocked" },
  ];

  const signer = await probeInside("os-signer", "statefulset/signer", [
    ...shared,
    {
      name: "not the confirmation service",
      tcp: { host: fromEnv("APPROVE_SERVICE_HOST"), port: 8788 },
      expect: "blocked",
    },
  ]);

  expect(signer.ok, signer.output).toBe(true);

  const approve = await probeInside("os-signer", "deployment/approve", [
    ...shared,
    {
      name: "the signer answers",
      http: {
        url: `http://${fromEnv("SIGNER_SERVICE_HOST")}:${fromEnv("SIGNER_SERVICE_PORT")}/healthz`,
      },
      expect: "status 200",
    },
    { name: "not its own edge", tcp: { host: approveEdge, port: 8081 }, expect: "blocked" },
  ]);

  expect(approve.ok, approve.output).toBe(true);
});

test("the control plane answers through the edge, which refuses the delivery routes", async () => {
  expect((await fetch(`${stack.origin}/healthz`)).status).toBe(200);
  expect((await fetch(`${stack.origin}/readyz`)).status).toBe(200);
  expect(
    (await fetch(`${stack.origin}/.well-known/workflow/v1/flow`, { method: "POST" })).status,
  ).toBe(404);
});

test("the installation is claimed with a setup token from the operator's command, never the log", async () => {
  expect((await ada.api.call("getSession")).setupRequired).toBe(true);

  const printed = await kubectl(
    "exec",
    "--namespace",
    "os",
    "deployment/server",
    "--",
    "node",
    "apps/server/src/cli.ts",
    "setup-token",
  );

  const answer = z
    .object({ ok: z.literal(true), setupToken: z.string().min(16) })
    .parse(JSON.parse(printed.trim().split("\n").at(-1) ?? ""));

  const logs = await kubectl(
    "logs",
    "--namespace",
    "os",
    "--selector",
    "app.kubernetes.io/name=server",
    "--tail=-1",
  );

  expect(logs).toContain("setup.token_pending");
  expect(logs).not.toContain(answer.setupToken);

  const session = await ada.setUp(answer.setupToken);
  expect(session.user?.displayName).toBe("Ada");
  expect(session.setupRequired).toBe(false);
});

test("an agent's payment approved on the signer's confirmation page lands once", async () => {
  const workspace = await ada.api.call("createWorkspace", {
    body: { name: `Kubernetes ${Date.now().toString(36)}` },
  });

  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Payer" },
  });

  const draft: PolicyDraft = {
    chains: [CHAIN],
    requesters: [created.agent.id],
    assets: [
      {
        chainId: CHAIN,
        asset: "native",
        maxPerTx: parseEther("0.05").toString(),
        maxPerDay: parseEther("0.08").toString(),
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

  await ada.confirm(request.id);
  expect((await ada.settled(request.id)).status).toBe("executed");
  await chainAdmin.setBalance({ address: created.wallet.address, value: parseEther("1") });

  const agent = await connectAgent(`${stack.origin}/mcp`, created.token);

  try {
    const before = await chain.getBalance({ address: RECIPIENT });
    const nonceBefore = await chain.getTransactionCount({ address: created.wallet.address });

    const proposal = await agent.call("propose_transfer", {
      chainId: CHAIN,
      to: RECIPIENT,
      amount: "0.01",
      memo: "paid through Kubernetes",
    });

    const approvalId = String(proposal.approvalUrl).split("/").at(-1) ?? "";
    const link = await ada.confirmationLink(approvalId);
    expect(link.origin).toBe(stack.approveOrigin);

    await ada.confirm(approvalId);
    expect(await intentSettles(String(proposal.intentId))).toBe("confirmed");
    expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
    expect(await chain.getTransactionCount({ address: created.wallet.address })).toBe(
      nonceBefore + 1,
    );
  } finally {
    await agent.close();
  }
});
