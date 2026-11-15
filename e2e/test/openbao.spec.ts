/**
 * The gates of a control plane whose key-encryption key lives in OpenBao Transit only
 * (`E2E_OPENBAO=1 e2e/run.sh`, CI `stack (openbao)`; specs/beyond-one-machine.md, milestone 3):
 * `KEY_PROVIDER=openbao`, no keyring file, an AppRole limited to deploy/openbao/policy.hcl, and
 * no cached data keys (`e2e/compose.openbao.yaml`). They run in order on a fresh stack and share
 * its installation; `release-gates.spec.ts` then runs on another fresh stack of the same kind.
 */
import { setTimeout as delay } from "node:timers/promises";
import { scanForMarkers } from "@askgina/os-testkit";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { formatEther } from "viem";
import { z } from "zod";
import { chain } from "../src/chain.ts";
import {
  claim,
  intentSettles,
  type PayingAgent,
  payingAgent,
  propose,
} from "../src/installation.ts";
import type { Person } from "../src/person.ts";
import {
  compose,
  databaseUrl,
  docker,
  exec,
  HELPER_IMAGE,
  stack,
  waitUntilHealthy,
} from "../src/stack.ts";

test.describe.configure({ mode: "serial" });

const RECIPIENT = "0x00000000000000000000000000000000000ba0ba";
const run = Date.now().toString(36);
const MEMO_MARKER = `BAOMARK${run} pay the storage invoice`;
const REFUSED_MEMO = `BAOREFUSED${run} proposed while OpenBao is away`;
const WORKSPACE_NAME = `Transit ${run}`;
const KEK_PREFIX = "bao:transit/os-kek@";
/** How long OpenBao stays paused in the outage gate (specs/beyond-one-machine.md). */
const OUTAGE_MS = 20_000;

let ada: Person;
let payer: PayingAgent;
/** The first payment, sealed under the Transit key's first version. */
let paidIntentId: string;

interface BaoAnswer {
  status: number;
  body: unknown;
}

const Login = z.object({
  auth: z.object({ client_token: z.string(), policies: z.array(z.string()) }),
});
const Encrypted = z.object({ data: z.object({ ciphertext: z.string() }) });
const Decrypted = z.object({ data: z.object({ plaintext: z.string() }) });
const KeyInfo = z.object({ data: z.object({ min_decryption_version: z.number() }) });
const InitState = z.object({ rootToken: z.string() });
const Rewrap = z.object({
  event: z.string(),
  activeKek: z.string(),
  rewrapped: z.number(),
  failedCount: z.number(),
});

/** One call to OpenBao's HTTP API through the port the overlay publishes. */
async function bao(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<BaoAnswer> {
  const response = await fetch(`${stack.openBaoUrl}/v1/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { "x-vault-token": token }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const answer: unknown = text === "" ? {} : JSON.parse(text);
  return { status: response.status, body: answer };
}

/**
 * The operator's root token, which `openbao-bootstrap` kept in the `openbao-init` volume, read
 * by a throwaway container of the image the stack already has.
 */
async function rootToken(): Promise<string> {
  const output = await docker(
    "run",
    "--rm",
    "-v",
    `${stack.project}_openbao-init:/state:ro`,
    HELPER_IMAGE,
    "cat",
    "/state/init.json",
  );
  return InitState.parse(JSON.parse(output)).rootToken;
}

/** The live data keys by the KEK that wraps them, as `{ kekId: count }`. */
async function liveKeks(): Promise<Record<string, number>> {
  const db = new pg.Client({ connectionString: await databaseUrl() });
  await db.connect();
  try {
    const { rows } = await db.query<{ kek_id: string; n: number }>(
      "SELECT kek_id, count(*)::int AS n FROM os_keys.data_keys WHERE shredded_at IS NULL GROUP BY kek_id ORDER BY kek_id",
    );
    return Object.fromEntries(rows.map((row) => [row.kek_id, row.n]));
  } finally {
    await db.end();
  }
}

/** A JSON line for the record: CI keeps it in the job's log. */
function record(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

test.beforeAll(async () => {
  await waitUntilHealthy();
});

test.afterAll(async () => {
  await payer?.agent.close();
});

test("the server's AppRole can wrap and unwrap under os-kek and do nothing else", async () => {
  const roleId = (await exec("server", "cat", "/run/secrets/server/openbao-role-id")).trim();
  const secretId = (await exec("server", "cat", "/run/secrets/server/openbao-secret-id")).trim();
  const login = await bao("POST", "auth/approle/login", undefined, {
    role_id: roleId,
    secret_id: secretId,
  });
  expect(login.status).toBe(200);
  const { auth } = Login.parse(login.body);
  expect([...auth.policies].sort()).toEqual(["default", "os-server"]);
  const token = auth.client_token;
  try {
    const plaintext = Buffer.alloc(32, 7).toString("base64");
    const encrypted = await bao("POST", "transit/encrypt/os-kek", token, { plaintext });
    expect(encrypted.status).toBe(200);
    const { ciphertext } = Encrypted.parse(encrypted.body).data;
    const decrypted = await bao("POST", "transit/decrypt/os-kek", token, { ciphertext });
    expect(Decrypted.parse(decrypted.body).data.plaintext).toBe(plaintext);
    expect((await bao("GET", "transit/keys/os-kek", token)).status).toBe(200);

    const refused = {
      rotate: await bao("POST", "transit/keys/os-kek/rotate", token),
      configure: await bao("POST", "transit/keys/os-kek/config", token, {
        min_decryption_version: 1,
      }),
      export: await bao("GET", "transit/export/encryption-key/os-kek", token),
      delete: await bao("DELETE", "transit/keys/os-kek", token),
      createKey: await bao("POST", "transit/keys/another", token, { type: "aes256-gcm96" }),
      mounts: await bao("GET", "sys/mounts", token),
    };
    expect(Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.status]))).toEqual({
      rotate: 403,
      configure: 403,
      export: 403,
      delete: 403,
      createKey: 403,
      mounts: 403,
    });
  } finally {
    await bao("POST", "auth/token/revoke-self", token);
  }
});

test("a fresh installation, a workspace and an agent with a funded wallet, on keys from OpenBao", async () => {
  ada = await claim();
  payer = await payingAgent(ada, WORKSPACE_NAME);
});

test("a payment approved on the confirmation page becomes one transaction, and its memo reads back", async () => {
  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: payer.wallet.address });
  const { intentId, approvalId } = await propose(payer.agent, RECIPIENT, "0.01", MEMO_MARKER);
  await ada.confirm(approvalId);
  expect(await intentSettles(ada, intentId, 120_000)).toBe("confirmed");
  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.01");
  expect(await chain.getTransactionCount({ address: payer.wallet.address })).toBe(nonceBefore + 1);
  expect((await ada.api.call("getIntent", { params: { intentId } })).memo).toBe(MEMO_MARKER);
  paidIntentId = intentId;
});

test("every data key is wrapped by OpenBao Transit, and nothing the agent typed is in the database in the clear", async () => {
  const keks = await liveKeks();
  expect(Object.keys(keks)).toEqual([`${KEK_PREFIX}1`]);
  expect(keks[`${KEK_PREFIX}1`]).toBeGreaterThan(0);

  const url = await databaseUrl();
  const scan = await scanForMarkers(url, [MEMO_MARKER, RECIPIENT, RECIPIENT.slice(2)]);
  expect(scan.hits).toEqual([]);
  expect(scan.tables.length).toBeGreaterThan(20);
  // The control: a name a person typed is readable on purpose, so the scanner is not blind.
  const control = await scanForMarkers(url, [WORKSPACE_NAME]);
  expect(control.hits.length).toBeGreaterThan(0);
});

test("with OpenBao paused for 20 seconds new work fails closed, and a payment approved meanwhile completes once it is back", async () => {
  // The outage, up to three minutes for the payment to resume, and a minute for new work.
  test.setTimeout(420_000);
  const { intentId, approvalId } = await propose(
    payer.agent,
    RECIPIENT,
    "0.002",
    "approved while OpenBao is away",
  );
  // The confirmation page is opened before the outage; the signer holds what it shows.
  const link = await ada.confirmationLink(approvalId);
  const view = await ada.readConfirmation(link);

  const collect = () =>
    ada.api.call("collectApproval", { params: { approvalId }, body: {} }).then(
      () => true,
      () => false,
    );
  let pausedAt = 0;
  let refusedAfterMs = 0;
  let unpausedAt = 0;
  let collectedDuringOutage = false;
  try {
    await compose("pause", "openbao");
    pausedAt = Date.now();
    // Approving needs no key of the control plane: the signer records it. The control plane
    // then collects the decision, if it can without a key, and resumes the run, which cannot.
    await ada.approveOnConfirmationPage(link, view);
    collectedDuringOutage = await collect();
    // New work needs a data key and none is cached: the proposal is refused, not stored.
    const refusal = await propose(payer.agent, RECIPIENT, "0.001", REFUSED_MEMO).then(
      () => null,
      (error: unknown) => error,
    );
    refusedAfterMs = Date.now() - pausedAt;
    expect(refusal).toBeInstanceOf(Error);
    // Readiness does not follow the key provider, so sign-in and key-free routes keep working.
    expect((await fetch(`${stack.origin}/readyz`)).status).toBe(200);
    const left = pausedAt + OUTAGE_MS - Date.now();
    if (left > 0) await delay(left);
  } finally {
    await compose("unpause", "openbao");
    unpausedAt = Date.now();
  }

  // Each delay below counts from the unpause. The first attempts may still meet OpenBao
  // electing itself leader again.
  const deadline = Date.now() + 60_000;
  // A collect that failed half way may have recorded the decision already: that is collected.
  const decided = () =>
    ada.api.call("getApproval", { params: { approvalId } }).then(
      (approval) => approval.status !== "pending",
      () => false,
    );
  let collected = collectedDuringOutage;
  while (!collected && Date.now() < deadline) {
    collected = (await collect()) || (await decided());
    if (!collected) await delay(1_000);
  }
  expect(collected).toBe(true);
  const collectedAfterMs = Date.now() - unpausedAt;

  let accepted: { intentId: string; approvalId: string } | null = null;
  while (accepted === null && Date.now() < deadline) {
    accepted = await propose(payer.agent, RECIPIENT, "0.001", "proposed after the outage").catch(
      () => null,
    );
    if (accepted === null) await delay(1_000);
  }
  const newWorkAfterMs = Date.now() - unpausedAt;
  expect(accepted).not.toBeNull();

  expect(await intentSettles(ada, intentId, 180_000)).toBe("confirmed");
  const paymentResumedAfterMs = Date.now() - unpausedAt;
  if (accepted !== null) await ada.reject(accepted.approvalId);

  record({
    gate: "openbao-outage",
    outageSeconds: (unpausedAt - pausedAt) / 1000,
    refusedAfterSeconds: refusedAfterMs / 1000,
    collectedDuringOutage,
    collectedAfterUnpauseSeconds: collectedDuringOutage ? 0 : collectedAfterMs / 1000,
    newWorkAcceptedAfterUnpauseSeconds: newWorkAfterMs / 1000,
    paymentConfirmedAfterUnpauseSeconds: paymentResumedAfterMs / 1000,
  });

  // The refused proposal left nothing behind.
  const { items } = await ada.api.call("listIntents", {
    params: { workspaceId: payer.workspace.id },
    query: {},
  });
  expect(items.some((intent) => intent.memo === REFUSED_MEMO)).toBe(false);
  expect(items.some((intent) => intent.id === intentId)).toBe(true);
});

test("a Transit key rotation, a rewrap and a raised minimum version keep every earlier payment readable", async () => {
  test.setTimeout(420_000);
  const token = await rootToken();
  expect(Object.keys(await liveKeks())).toEqual([`${KEK_PREFIX}1`]);

  expect((await bao("POST", "transit/keys/os-kek/rotate", token)).status).toBeLessThan(300);
  // Every replica wraps new keys under the latest version once it reads it again: at its next
  // refresh, or at once after a restart.
  await compose("stop", "server");
  await compose("up", "-d", "--wait", "--wait-timeout", "300", "server");
  await waitUntilHealthy();

  // The operator's command, in a server container with the server's own settings.
  const output = await exec("server", "node", "packages/keys/src/cli.ts", "rewrap");
  const rewrap = Rewrap.parse(JSON.parse(output.trim().split("\n").at(-1) ?? "{}"));
  expect(rewrap).toMatchObject({
    event: "keys.rewrap",
    activeKek: `${KEK_PREFIX}2`,
    failedCount: 0,
  });
  expect(rewrap.rewrapped).toBeGreaterThan(0);
  expect(Object.keys(await liveKeks())).toEqual([`${KEK_PREFIX}2`]);

  // The first version can no longer decrypt anything: what still reads was rewrapped.
  const config = await bao("POST", "transit/keys/os-kek/config", token, {
    min_decryption_version: 2,
  });
  expect(config.status).toBeLessThan(300);
  const key = await bao("GET", "transit/keys/os-kek", token);
  expect(KeyInfo.parse(key.body).data.min_decryption_version).toBe(2);

  expect((await ada.api.call("getIntent", { params: { intentId: paidIntentId } })).memo).toBe(
    MEMO_MARKER,
  );
  // And new work goes on under the second version.
  const { intentId, approvalId } = await propose(
    payer.agent,
    RECIPIENT,
    "0.001",
    "after the rotation",
  );
  await ada.confirm(approvalId);
  expect(await intentSettles(ada, intentId, 120_000)).toBe("confirmed");
  expect(Object.keys(await liveKeks())).toEqual([`${KEK_PREFIX}2`]);
});
