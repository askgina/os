/**
 * The lifecycle gates, against a stack of their own (`e2e/run.sh`): retiring a wallet, an
 * operator's export of its key, deleting a workspace, cancelling a deletion, and what a deleted
 * workspace leaves, down to a database copy from before the deletion after the keyring is
 * rotated; then exporting a workspace's template and record, cloning it, importing a template,
 * and erasing a person. The e2e overlay lets the signer take a destroy time seconds ahead
 * (`SIGNER_MIN_DESTROY_DELAY_SECONDS=0`); the server finishes due retirements and deletions at
 * most once a minute, so a gate that waits for one waits up to a minute and a half. This stack
 * alone has Web Push on (`e2e/compose.lifecycle.yaml`, `E2E_LIFECYCLE=1`), toward a push
 * service that never resolves, so the erasure gate can add a person's device through the API.
 *
 * The tests run in order and share state: the first claims the installation.
 */
import { createECDH, createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentSummary,
  ApiError,
  type AuditEvent,
  type IntentDetail,
  type MandateDraft,
  type PolicyDraft,
  type TransactionInfo,
  type WalletSummary,
  type WorkspaceDetail,
  type WorkspaceTemplate,
} from "@askgina/os-api";
import { type ConfirmationView, canonicalJson } from "@askgina/os-protocol";
import type { SignerDecision } from "@askgina/os-protocol/signer";
import { scanForMarkers } from "@askgina/os-testkit";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { type Hash, parseEther } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { type AgentConnection, connectAgent, type Proposal, ToolRefused } from "../src/agent.ts";
import { chain, chainAdmin, receiptOf, withMiningHeld } from "../src/chain.ts";
import { ConfirmationRefused, Person } from "../src/person.ts";
import {
  compose,
  databaseUrl,
  exec,
  execWithInput,
  setupToken,
  stack,
  waitUntilHealthy,
} from "../src/stack.ts";
import {
  acknowledged,
  expectSignedDelivery,
  webhookDeliveries,
  webhookSecret,
} from "../src/webhook.ts";

test.describe.configure({ mode: "serial" });

const CHAIN = "eip155:31337";

const RECIPIENT = "0x00000000000000000000000000000000000a11ce";

/** The one address the mandates below may pay. */
const PAYEE = "0x000000000000000000000000000000000000b0b0";

const run = Date.now().toString(36);

/** Text the workspace that is deleted for good holds. None of it may be readable afterwards. */
const MEMO_MARKER = `LIFEMEMO${run} pay the archive invoice`;

const PURPOSE_MARKER = `LIFEPURPOSE${run} pay the archive invoices`;

const ARCHIVE_NAME = `Archive ${run}`;

const ARCHIVIST_NAME = `Archivist ${run}`;

/** A workspace that stays: its name and its payment's memo stay readable to it. */
const LEDGER_NAME = `Ledger ${run}`;

const LEDGER_MEMO = `LEDGERMEMO${run} pay the ledger invoice`;

const STUDIO_NAME = `Studio ${run}`;

const COURIER_NAME = `Courier ${run}`;

/** A workspace that is exported, cloned and imported, and that Cyd is erased from. */
const ATELIER_NAME = `Atelier ${run}`;

const CLERK_NAME = `Clerk ${run}`;

const STRONGBOX = "Strongbox";

/** What people and agents typed in the atelier. A record opens it; nothing else may carry it. */
const EXPORT_MEMO = `EXPORTMEMO${run} pay the atelier invoice`;

const EXPORT_PURPOSE = `EXPORTPURPOSE${run} pay the framer`;

const COPY_NAME = `Atelier copy ${run}`;

const COPY_MEMO = `COPYMEMO${run} the copy's first payment`;

const IMPORT_NAME = `Atelier import ${run}`;

const FOREIGN_NAME = `Atelier from elsewhere ${run}`;

const AFTER_ERASURE_NAME = `Atelier after erasure ${run}`;

/** The person who is erased. Her name is a marker: afterwards no table may hold it. */
const CYD_NAME = `Cyd Erasable ${run}`;

/** Her device's push endpoint, under the only push service the lifecycle overlay allows. */
const CYD_PUSH_ENDPOINT = `https://push.example.test/send/${run}-cyd`;

/** An address the atelier's policy does not let anyone pay. */
const STRANGER = "0x000000000000000000000000000000000000dead";

/** A user id this installation never issued, as a template from another one names people. */
const STRANGER_USER = "usr_00000000000000000000000000";

/** The sections of a workspace record, in their order (`apps/server/src/lifecycle/verify-record.ts`). */
const RECORD_SECTIONS = [
  "audit",
  "intent",
  "transaction",
  "policy-revision",
  "mandate",
  "mandate-use",
  "signer-decision",
];

/** Where the operator keeps a record file to check it, inside the server's container. */
const RECORD_FILE = "/tmp/workspace-record.jsonl";

/** Where the signer keeps its state, inside its container (`SIGNER_DATA_DIR`). */
const SIGNER_DATABASE = "/data/signer.sqlite";

const SIGNER_VAULT = "/data/vault";

/** The server's keyring, and where the keyring gate keeps a copy of it from before rotating. */
const KEYRING = "/run/secrets/server/keyring.json";

const KEYRING_COPY = "keyring-before-rotation.json";

/** The copy of the database the keyring gate takes before the deletion, inside `postgres`. */
const DUMP = "/tmp/lifecycle-before-deletion.dump";

const COPY_DATABASE = "lifecycle_before_deletion";

/** The keys of a lifecycle notice's body, sorted as canonical JSON sorts them. */
const LIFECYCLE_EVENT_KEYS = [
  "approvalId",
  "deliveryId",
  "destroyAfter",
  "event",
  "kind",
  "link",
  "v",
  "walletId",
  "workspaceId",
];

const wei = (amount: string) => parseEther(amount).toString();

const nowSeconds = () => Math.floor(Date.now() / 1000);

const ada = new Person(stack.origin, "Ada");

/** A viewer of the studio: no passkey approves anything of hers, and she may cancel. */
const bea = new Person(stack.origin, "Bea");

/** An approver of the atelier, who grants its mandate and then asks to be erased. */
const cyd = new Person(stack.origin, CYD_NAME);

/** A workspace with one agent, its wallet under a policy, funded, and the agent connected. */
interface Space {
  workspace: WorkspaceDetail;
  agentId: AgentSummary["id"];
  token: string;
  wallet: WalletSummary;
  agent: AgentConnection;
}

/** Stays; its wallet is retired, cancelled, made active again, then retired for good. */
let ledger: Space;

/** Its deletion is approved and cancelled. */
let studio: Space;

let reserve: WalletSummary;

let spare: WalletSummary;

let studioMandateId = "";

let deletionId = "";

let studioDestroyAfter = 0;

/** Deleted for good. */
let archive: Space;

let archiveIntentId = "";

let ledgerIntentId = "";

/** Exported, cloned and imported; Cyd approves in it until she is erased. */
let atelier: Space;

let strongbox: WalletSummary;

let atelierTemplate: WorkspaceTemplate;

let atelierMandateId = "";

let atelierPaidIntentId = "";

/** The two atelier payments of the first gate below: one a mandate covered, one Ada approved. */
let atelierIntentIds: string[] = [];

let adaId = "";

let cydId = "";

/** The atelier wallet's key as the signer's operator exports it, and its private key in hex. */
let atelierSecrets: string[] = [];

// --- people, approvals and payments -------------------------------------------------------------

/** A policy for `requester` with room for every payment below, to any recipient. */
function payerPolicy(requester: AgentSummary["id"], maxPerDay = "0.5"): PolicyDraft {
  return {
    chains: [CHAIN],
    requesters: [requester],
    assets: [{ chainId: CHAIN, asset: "native", maxPerTx: wei("0.05"), maxPerDay: wei(maxPerDay) }],
    recipients: { mode: "any" },
    contractCalls: { mode: "deny" },
    fees: { maxPerTxWei: wei("0.01") },
    approvals: { threshold: 1, ttlSeconds: 3600 },
  };
}

/** Let `agent` pay PAYEE up to 0.01 ETH at a time, for a day, with no person asked. */
function mandateDraft(agent: AgentSummary["id"], extra: Partial<MandateDraft> = {}): MandateDraft {
  return {
    agentId: agent,
    assets: [
      {
        chainId: CHAIN,
        asset: "native",
        maxPerAction: wei("0.01"),
        maxPerWindow: wei("0.03"),
        maxTotal: wei("0.05"),
      },
    ],
    windowSeconds: 3600,
    recipients: [PAYEE],
    maxUses: 10,
    maxFeePerActionWei: wei("0.01"),
    notAfter: nowSeconds() + 86_400,
    purpose: "pay the invoices this week",
    ...extra,
  };
}

/** Ask for a new policy and approve it on the signer's confirmation page. */
async function setPolicy(workspaceId: string, walletId: string, draft: PolicyDraft): Promise<void> {
  const request = await ada.api.call("requestPolicy", {
    params: { workspaceId, walletId },
    body: { draft },
  });

  await ada.confirm(request.id);
  expect((await ada.settled(request.id)).status).toBe("executed");
}

/** A workspace named `name` with one agent, its wallet under `policy` and funded. */
async function newSpace(
  name: string,
  agentName: string,
  policy: (requester: AgentSummary["id"]) => PolicyDraft = payerPolicy,
): Promise<Space> {
  const workspace = await ada.api.call("createWorkspace", { body: { name } });

  const created = await ada.api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: agentName },
  });

  await setPolicy(workspace.id, created.wallet.id, policy(created.agent.id));
  await chainAdmin.setBalance({ address: created.wallet.address, value: parseEther("1") });

  return {
    workspace,
    agentId: created.agent.id,
    token: created.token,
    wallet: created.wallet,
    agent: await connectAgent(`${stack.origin}/mcp`, created.token),
  };
}

/**
 * Ada asks for `draft` on `walletId`, and `approver` approves it on the confirmation page, which
 * at the admin threshold of 1 grants it.
 */
async function grantMandate(
  workspaceId: string,
  walletId: string,
  draft: MandateDraft,
  approver: Person = ada,
): Promise<{ mandateId: string; grantId: string }> {
  const grant = await ada.proposeMandate(workspaceId, walletId, draft);
  await approver.confirm(grant.id);
  const granted = await ada.settled(grant.id);
  expect(granted.status).toBe("executed");

  if (granted.subject.kind !== "grant-mandate") throw new Error(`${grant.id} grants no mandate`);

  return { mandateId: granted.subject.mandate.id, grantId: grant.id };
}

/** The atelier's policy: room for every payment below, only to PAYEE and RECIPIENT. */
function atelierPolicy(requester: AgentSummary["id"]): PolicyDraft {
  return {
    ...payerPolicy(requester),
    recipients: { mode: "allowlist", addresses: [PAYEE, RECIPIENT] },
  };
}

/**
 * `person` joins `workspaceId` as an approver, proves on the confirmation page that the passkey
 * is theirs, and Ada approves the change. Returns their user id.
 */
async function joinAsApprover(person: Person, workspaceId: string): Promise<string> {
  const invite = await ada.api.call("createInvite", {
    params: { workspaceId },
    body: { role: "approver" },
  });

  const { user } = await person.join(invite.url);

  if (!user) throw new Error(`${person.name} did not join`);

  const pending = await ada.api.call("listApprovals", {
    params: { workspaceId },
    query: { status: "pending" },
  });

  let change: string | undefined;

  for (const item of pending.items.filter((candidate) => candidate.kind === "add-approver")) {
    const detail = await ada.api.call("getApproval", { params: { approvalId: item.id } });

    if (detail.subject.kind === "add-approver" && detail.subject.user.id === user.id) {
      change = item.id;
    }
  }

  if (!change) throw new Error("joining as an approver opened no approver change");
  await person.provePossession(change);
  await ada.confirm(change);
  expect((await ada.settled(change)).status).toBe("executed");

  return user.id;
}

function getMandate(workspaceId: string, mandateId: string) {
  return ada.api.call("getMandate", { params: { workspaceId, mandateId } });
}

/** The ids of the live mandates `whoami` shows an agent. */
async function agentMandates(agent: AgentConnection): Promise<string[]> {
  const { mandates } = await agent.call("whoami");

  return (mandates as { mandateId: string }[]).map((mandate) => mandate.mandateId);
}

function propose(space: Space, to: string, amount: string, memo: string): Promise<Proposal> {
  return space.agent.proposeTransfer({ chainId: CHAIN, to, amount, memo });
}

function approvalIdOf(proposal: Proposal): string {
  return String(proposal.approvalUrl).split("/").at(-1) ?? "";
}

function walletDetail(workspaceId: string, walletId: string) {
  return ada.api.call("getWallet", { params: { workspaceId, walletId } });
}

function requestRetire(workspaceId: string, walletId: string, destroyAfter: number) {
  return ada.api.call("requestRetireWallet", {
    params: { workspaceId, walletId },
    body: { destroyAfter },
  });
}

/** Ask to retire `walletId` and approve it on the confirmation page. */
async function retire(workspaceId: string, walletId: string, destroyAfter: number) {
  const request = await requestRetire(workspaceId, walletId, destroyAfter);
  await ada.confirm(request.id);
  expect((await ada.settled(request.id)).status).toBe("executed");

  return request;
}

/**
 * A payment people would have to approve, which the signer will not let anyone approve: the
 * request shows no confirmation page. Ada rejects it, so nothing waits.
 */
async function expectNoConfirmation(proposal: Proposal): Promise<void> {
  expect(proposal).toMatchObject({ authorizedBy: "person", mandateId: null });
  const approvalId = approvalIdOf(proposal);
  expect(await ada.api.call("getApproval", { params: { approvalId } })).toMatchObject({
    status: "pending",
    confirmUrl: null,
  });
  await ada.reject(approvalId);
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

/** Read the intent until its transaction satisfies `ready`, and return both. */
async function transactionOnceSent(
  intentId: string,
  ready: (transaction: TransactionInfo) => boolean,
  timeoutMs = 60_000,
): Promise<{ intent: IntentDetail; transaction: TransactionInfo }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const intent = await ada.api.call("getIntent", { params: { intentId } });
    const { transaction } = intent;

    if (transaction !== null && ready(transaction)) return { intent, transaction };

    if (Date.now() > deadline) {
      throw new Error(`intent ${intentId} is ${intent.status}, its transaction not ready`);
    }

    await delay(250);
  }
}

/** The code the API refused `attempt` with, and its reason; fails when it was not refused. */
async function apiRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string; detail: string | undefined }> {
  const outcome = await attempt.then(
    () => null,
    (error: unknown) => error,
  );

  if (!(outcome instanceof ApiError)) {
    throw new Error(`expected the API to refuse, got ${String(outcome)}`);
  }

  return { code: outcome.code, detail: outcome.detail };
}

/** The code and reason an agent's tool refused `attempt` with; fails when it was not refused. */
async function toolRefusal(
  attempt: Promise<unknown>,
): Promise<{ code: string | null; detail: string | null }> {
  const outcome = await attempt.then(
    () => null,
    (error: unknown) => error,
  );

  if (!(outcome instanceof ToolRefused)) {
    throw new Error(`expected the tool to refuse, got ${String(outcome)}`);
  }

  return { code: outcome.code, detail: outcome.detail };
}

/** The code the confirmation page refused `attempt` with; fails when it was not refused. */
async function refusalCode(attempt: Promise<unknown>): Promise<string> {
  const outcome = await attempt.then(
    () => null,
    (error: unknown) => error,
  );

  if (!(outcome instanceof ConfirmationRefused)) {
    throw new Error(`expected the confirmation page to refuse, got ${String(outcome)}`);
  }

  return outcome.code;
}

/** Everything a confirmation page shows in its lines, lower-cased. */
function shownText(view: ConfirmationView): string {
  return view.lines
    .map((line) => line.value)
    .join("\n")
    .toLowerCase();
}

/** A workspace's whole signer decision log, read through the API to its end. */
async function signerDecisions(workspaceId: string): Promise<SignerDecision[]> {
  const decisions: SignerDecision[] = [];

  for (let after = 0; ; ) {
    const page = await ada.api.call("listSignerDecisions", {
      params: { workspaceId },
      query: { after: String(after) },
    });

    decisions.push(...page.items);
    const last = page.items.at(-1);

    if (!last || page.items.length < 100) return decisions;
    after = last.seq;
  }
}

/** Every entry of a workspace's audit log, opened, read across pages. */
async function auditEvents(workspaceId: string): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];

  for (let cursor: string | undefined; ; ) {
    const page = await ada.api.call("listAudit", {
      params: { workspaceId },
      query: cursor === undefined ? {} : { cursor },
    });

    events.push(...page.items);

    if (page.nextCursor === null) return events;
    cursor = page.nextCursor;
  }
}

/** Every action in a workspace's audit log, read across pages. */
async function auditActions(workspaceId: string): Promise<string[]> {
  return (await auditEvents(workspaceId)).map((event) => event.action);
}

// --- the stack, as an operator reads it ----------------------------------------------------------

/** Rows of `sql` in one of the stack's databases, through the port the overlay publishes. */
async function query(
  sql: string,
  params: unknown[] = [],
  database = "postgres",
): Promise<Record<string, unknown>[]> {
  const url = new URL(await databaseUrl());
  url.pathname = `/${database}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();

  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.end();
  }
}

/** Run `command` in a running service's container with `env` set. */
function inContainer(
  service: string,
  env: Record<string, string>,
  ...command: string[]
): Promise<string> {
  const variables = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);

  return compose("exec", "-T", ...variables, service, ...command);
}

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

/** Rows of `sql` in the signer's SQLite file. Select lengths of blobs, not the blobs. */
async function signerQuery(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  const output = await inContainer(
    "signer",
    { SIGNER_DATABASE, QUERY: sql, PARAMS: JSON.stringify(params) },
    "node",
    "-e",
    SIGNER_QUERY_SCRIPT,
  );

  return JSON.parse(output) as Record<string, unknown>[];
}

/** Searches the bytes of the signer's database file and its WAL for each marker. */
const SIGNER_FILE_SCAN_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const markers = JSON.parse(process.env.MARKERS);",
  "const dir = path.dirname(process.env.SIGNER_DATABASE);",
  "const base = path.basename(process.env.SIGNER_DATABASE);",
  "const hits = [];",
  "for (const name of fs.readdirSync(dir)) {",
  "  if (!name.startsWith(base)) continue;",
  "  const bytes = fs.readFileSync(path.join(dir, name));",
  "  for (const marker of markers) {",
  "    const utf8 = Buffer.from(marker);",
  '    for (const [encoding, needle] of [["utf8", utf8], ["hex", Buffer.from(utf8.toString("hex"))]]) {',
  "      if (bytes.includes(needle)) hits.push({ file: name, marker, encoding });",
  "    }",
  "  }",
  "}",
  "process.stdout.write(JSON.stringify(hits));",
].join("\n");

/** Where each marker is in the signer's database file or its WAL, as stored bytes. */
async function signerFileHits(
  markers: string[],
): Promise<{ file: string; marker: string; encoding: string }[]> {
  const output = await inContainer(
    "signer",
    { SIGNER_DATABASE, MARKERS: JSON.stringify(markers) },
    "node",
    "-e",
    SIGNER_FILE_SCAN_SCRIPT,
  );

  return JSON.parse(output) as { file: string; marker: string; encoding: string }[];
}

/** Counts, per name, the files anywhere in the signer's OWS vault whose content names it. */
const VAULT_SCAN_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const names = JSON.parse(process.env.NAMES);",
  "const counts = Object.fromEntries(names.map((name) => [name, 0]));",
  "const walk = (dir) => {",
  "  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {",
  "    const full = path.join(dir, entry.name);",
  "    if (entry.isDirectory()) walk(full);",
  "    else if (entry.isFile()) {",
  '      const text = fs.readFileSync(full, "latin1");',
  "      for (const name of names) if (text.includes(name)) counts[name] += 1;",
  "    }",
  "  }",
  "};",
  "walk(process.env.VAULT);",
  "process.stdout.write(JSON.stringify(counts));",
].join("\n");

/**
 * How many files of the signer's vault name each wallet. OWS names its files by UUID; each
 * wallet file and each API key file carries the wallet's name, which is its wallet id.
 */
async function vaultFilesNaming(walletIds: string[]): Promise<Record<string, number>> {
  const output = await inContainer(
    "signer",
    { VAULT: SIGNER_VAULT, NAMES: JSON.stringify(walletIds) },
    "node",
    "-e",
    VAULT_SCAN_SCRIPT,
  );

  return JSON.parse(output) as Record<string, number>;
}

/**
 * Opens one intent's sealed payload the way the server does, inside the server's container
 * with its own key store code: unwrap the workspace's data key from `os_keys` with the keyring
 * file given, then open `intents.payload`. Prints whether it opened and whether the plaintext
 * holds the marker, never the plaintext or a key.
 */
const OPEN_SEALED_SCRIPT = [
  'import { readFileSync } from "node:fs";',
  'import { createRequire } from "node:module";',
  'import { DataKeyStore, LocalKeyring, openJson } from "/app/packages/keys/src/index.ts";',
  // `pg` as the key store's own command resolves it in the server's image.
  'const pg = createRequire("/app/packages/keys/src/cli.ts")("pg");',
  "const out = (line) => process.stdout.write(JSON.stringify(line));",
  'const url = new URL("postgres://postgres@postgres:5432/" + process.env.OPEN_DATABASE);',
  'url.password = readFileSync(process.env.DATABASE_PASSWORD_FILE, "utf8").trim();',
  "const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });",
  "try {",
  "  const { rows } = await pool.query(",
  '    "SELECT workspace_id, payload FROM os.intents WHERE id = $1",',
  "    [process.env.OPEN_INTENT],",
  "  );",
  "  const row = rows[0];",
  '  if (!row) out({ outcome: "missing" });',
  "  else {",
  "    try {",
  "      const provider = LocalKeyring.fromFile(process.env.OPEN_KEYRING);",
  "      const store = new DataKeyStore({ pool, provider, cacheTtlMs: 0 });",
  '      const key = await store.get("workspace", row.workspace_id);',
  '      const value = openJson(key, row.payload, "intents.payload:" + process.env.OPEN_INTENT);',
  "      const containsMarker = JSON.stringify(value).includes(process.env.OPEN_MARKER);",
  '      out({ outcome: "opened", containsMarker });',
  "    } catch (error) {",
  '      out({ outcome: "refused", error: error.name, message: error.message });',
  "    }",
  "  }",
  "} finally {",
  "  await pool.end();",
  "}",
].join("\n");

interface OpenAttempt {
  outcome: "opened" | "refused" | "missing";
  containsMarker?: boolean;
  error?: string;
  message?: string;
}

/** Try to open an intent's sealed payload in `database` with the keyring file `keyring`. */
async function openSealedIntent(input: {
  database: string;
  keyring: string;
  intentId: string;
  marker: string;
}): Promise<OpenAttempt> {
  const output = await inContainer(
    "server",
    {
      OPEN_DATABASE: input.database,
      OPEN_KEYRING: input.keyring,
      OPEN_INTENT: input.intentId,
      OPEN_MARKER: input.marker,
    },
    "node",
    "--input-type=module",
    "-e",
    OPEN_SEALED_SCRIPT,
  );

  return JSON.parse(output) as OpenAttempt;
}

/** The server's structured log lines whose `event` is `event`. */
async function serverEvents(event: string): Promise<Record<string, unknown>[]> {
  const logs = await compose("logs", "--no-color", "server");

  return logs.split("\n").flatMap((line) => {
    const start = line.indexOf("{");

    if (start < 0) return [];

    try {
      const parsed = JSON.parse(line.slice(start)) as Record<string, unknown>;

      return parsed.event === event ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/** Why the server's finalize step skipped the deletion of `workspaceId` so far, oldest first. */
async function deletionSkips(workspaceId: string): Promise<string[]> {
  return (await serverEvents("lifecycle.finalize_skipped"))
    .filter((line) => line.workspaceId === workspaceId && line.walletId === null)
    .map((line) => String(line.code));
}

/** Wait until the server left a tombstone of `workspaceId`: its deletion finished. */
async function waitForDeleted(workspaceId: string, timeoutMs = 200_000): Promise<void> {
  await expect
    .poll(
      async () =>
        (await query("SELECT lifecycle FROM os.workspaces WHERE id = $1", [workspaceId]))[0]
          ?.lifecycle,
      { timeout: timeoutMs, intervals: [1_000] },
    )
    .toBe("deleted");
}

/** Run one of the signer's operator commands on its host, as the deploy guide does. */
async function signerAdmin(...args: string[]): Promise<Record<string, unknown>> {
  const output = await exec("signer", "node", "src/admin.ts", ...args);

  return JSON.parse(output.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
}

/** The code one of the signer's operator commands refused with; fails when it did not. */
async function signerAdminRefusal(...args: string[]): Promise<string> {
  const output = await exec("signer", "node", "src/admin.ts", ...args).then(
    () => null,
    (error: { stdout?: string }) => error.stdout ?? "",
  );

  if (output === null) throw new Error(`expected admin.ts ${args[0]} to refuse`);
  const line = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as { code?: string };

  return line.code ?? "unreadable";
}

/** The last JSON line a command printed. */
function lastLine(output: string): Record<string, unknown> {
  return JSON.parse(output.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
}

/**
 * The exit code and last JSON line of an operator's command run with {@link execWithInput};
 * fails with what Docker and the command printed when there is no such line.
 */
function operatorAnswer(ran: { exitCode: number; output: string; diagnostics: string }): {
  exitCode: number;
  result: Record<string, unknown>;
} {
  try {
    return { exitCode: ran.exitCode, result: lastLine(ran.output) };
  } catch {
    throw new Error(`exit ${ran.exitCode}, no JSON answer: ${ran.output}${ran.diagnostics}`);
  }
}

/** Writes its stdin to the file named as its argument. */
const WRITE_STDIN_SCRIPT =
  'process.stdin.pipe(require("node:fs").createWriteStream(process.argv[1]));';

/**
 * Check a record the way the deploy guide does: as a file, with
 * `node apps/server/src/lifecycle/verify-record.ts <file>`, here in the server's container,
 * which runs the same source as a checkout of the repository.
 */
async function verifyRecordFile(
  record: string,
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const written = await execWithInput(
    "server",
    record,
    "node",
    "-e",
    WRITE_STDIN_SCRIPT,
    RECORD_FILE,
  );

  if (written.exitCode !== 0) throw new Error(`writing the record failed: ${written.diagnostics}`);

  return operatorAnswer(
    await execWithInput(
      "server",
      "",
      "node",
      "apps/server/src/lifecycle/verify-record.ts",
      RECORD_FILE,
    ),
  );
}

/** The operator erases a person, as the deploy guide gives it, on the server's host. */
async function eraseByOperator(
  userId: string,
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  return operatorAnswer(
    await execWithInput(
      "server",
      "",
      "node",
      "apps/server/src/identity/erase-cli.ts",
      "--user",
      userId,
    ),
  );
}

/** A record's lines as the file holds them, one JSON document each, without the final newline. */
function recordLines(record: string): string[] {
  const lines = record.split("\n");

  if (lines.at(-1) === "") lines.pop();

  return lines;
}

/** A record's lines, parsed. */
function parseRecord(record: string): Record<string, unknown>[] {
  return recordLines(record).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The lines of one section of a parsed record. */
function sectionOf(lines: Record<string, unknown>[], type: string): Record<string, unknown>[] {
  return lines.filter((line) => line.type === type);
}

/**
 * Make every session of `userId` look signed in ten minutes earlier than it was: a session left
 * signed in on a shared machine, past the five minutes a record export or an erasure allows.
 */
async function signedInLongAgo(userId: string): Promise<void> {
  await query(
    "UPDATE os.sessions SET created_at = created_at - interval '10 minutes' WHERE user_id = $1",
    [userId],
  );
}

/** How many rows of each kind that belong to a person the control plane holds. */
async function personRows(userId: string): Promise<Record<string, unknown>> {
  const [row] = await query(
    `SELECT
       (SELECT count(*) FROM os.sessions WHERE user_id = $1)::int AS sessions,
       (SELECT count(*) FROM os.credentials WHERE user_id = $1)::int AS passkeys,
       (SELECT count(*) FROM os.ceremonies WHERE user_id = $1)::int AS ceremonies,
       (SELECT count(*) FROM os.push_subscriptions WHERE user_id = $1)::int AS devices,
       (SELECT count(*) FROM os.notification_preferences WHERE user_id = $1)::int AS settings,
       (SELECT count(*) FROM os.approver_credentials WHERE user_id = $1)::int AS approving,
       (SELECT count(*) FROM os.memberships WHERE user_id = $1)::int AS memberships,
       (SELECT count(*) FROM os.notification_deliveries WHERE user_id = $1)::int AS deliveries,
       (SELECT count(*) FROM os.notification_deliveries WHERE user_id = $1 AND state = 'pending')::int AS pending`,
    [userId],
  );

  if (!row) throw new Error(`no counts for ${userId}`);

  return row;
}

/** What of a workspace a clone of it must leave as it was. */
function standing(detail: WorkspaceDetail) {
  return {
    name: detail.name,
    adminThreshold: detail.adminThreshold,
    notificationDetail: detail.notificationDetail,
    paused: detail.paused,
    lifecycle: detail.lifecycle,
    members: detail.members.map((member) => [member.user.id, member.role, member.approver]),
    agents: detail.agents.map((agent) => [
      agent.id,
      agent.status,
      agent.walletId,
      agent.tokenPrefix,
    ]),
    wallets: detail.wallets.map((wallet) => [
      wallet.id,
      wallet.address,
      wallet.policyHash,
      wallet.lifecycle.state,
    ]),
  };
}

test.beforeAll(async () => {
  await waitUntilHealthy();
});

// --- retiring a wallet ----------------------------------------------------------------------------

test("a fresh installation is claimed, and its signer takes a destroy time seconds ahead", async () => {
  expect((await ada.api.call("getSession")).setupRequired).toBe(true);
  await ada.setUp(await setupToken());
  ledger = await newSpace(LEDGER_NAME, "Bookkeeper");
  const workspaceId = ledger.workspace.id;

  // Advisory, read by the control plane: the wallet holds the coin the gate gave it, and this
  // stack's signer sets no minimum delay (the e2e overlay; seven days by default).
  const preflight = await ada.api.call("getDeletionPreflight", { params: { workspaceId } });
  expect(preflight).toMatchObject({
    workspaceId,
    source: "control-plane",
    minDestroyDelaySeconds: 0,
  });
  expect(preflight.wallets.map((entry) => entry.wallet.id)).toEqual([ledger.wallet.id]);
  expect(preflight.blockers).toContain("nonzero_balance");

  // A workspace is deleted only once nothing signs: it must be paused first.
  expect(
    await apiRefusal(
      ada.api.call("requestDeleteWorkspace", {
        params: { workspaceId },
        body: { destroyAfter: nowSeconds() + 60 },
      }),
    ),
  ).toEqual({ code: "conflict", detail: "not_paused" });
});

test("retiring a wallet stops its signing and ends its mandate at once; cancelling keeps the key, and the wallet signs again only under a new policy", async () => {
  const { workspace, wallet } = ledger;
  const workspaceId = workspace.id;
  const mandate = await grantMandate(workspaceId, wallet.id, mandateDraft(ledger.agentId));
  const covered = await propose(ledger, PAYEE, "0.001", "covered before the retirement");
  expect(covered).toMatchObject({ authorizedBy: "mandate", mandateId: mandate.mandateId });
  expect(await intentSettles(covered.intentId)).toBe("confirmed");

  // A payment that waits for a person, with its confirmation page open.
  const waiting = await propose(ledger, RECIPIENT, "0.002", "waits at the retirement");
  expect(waiting).toMatchObject({ authorizedBy: "person", status: "pending_approval" });
  const waitingLink = await ada.confirmationLink(approvalIdOf(waiting));
  const waitingView = await ada.readConfirmation(waitingLink);
  expect(waitingView.state).toBe("open");

  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });
  const destroyAfter = nowSeconds() + 3600;
  const request = await requestRetire(workspaceId, wallet.id, destroyAfter);
  expect(request).toMatchObject({ kind: "retire-wallet", status: "pending", threshold: 1 });
  expect(request.title).toContain("destroy its key");
  expect(await apiRefusal(requestRetire(workspaceId, wallet.id, destroyAfter))).toEqual({
    code: "conflict",
    detail: "already_requested",
  });
  const detail = await ada.api.call("getApproval", { params: { approvalId: request.id } });

  if (detail.envelope.type !== "retire-wallet") throw new Error("not a retirement");
  expect(detail.envelope.wallet.walletId).toBe(wallet.id);
  expect(detail.envelope.wallet.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  expect(detail.envelope.destroyAfter).toBe(destroyAfter);

  // The confirmation page names the wallet as the signer holds it, warns that what is left in
  // it is lost and that the signer cannot see balances, and shows the destroy time.
  const link = await ada.confirmationLink(request.id);
  expect(link.origin).toBe(stack.approveOrigin);
  const view = await ada.readConfirmation(link);
  expect(view).toMatchObject({ approvalId: request.id, kind: "retire-wallet", state: "open" });
  expect(view.title).toContain("Retire a wallet");
  expect(view.envelope).toEqual(detail.envelope);
  expect(view.warnings).toEqual(expect.arrayContaining(["keys_destroyed", "balances_unchecked"]));
  expect(shownText(view)).toContain(wallet.id.toLowerCase());
  expect(shownText(view)).toContain(wallet.address.toLowerCase());
  expect(await ada.approveOnConfirmationPage(link, view)).toMatchObject({
    collected: 1,
    required: 1,
  });
  await ada.api.call("collectApproval", { params: { approvalId: request.id }, body: {} });
  expect((await ada.settled(request.id)).status).toBe("executed");

  // From the approval on: retiring, its mandate ended, the waiting payment closed.
  expect((await walletDetail(workspaceId, wallet.id)).lifecycle).toEqual({
    state: "retiring",
    destroyAfter,
  });
  expect(await getMandate(workspaceId, mandate.mandateId)).toMatchObject({
    status: "revoked",
    endedReason: "revoked",
  });
  expect(await agentMandates(ledger.agent)).toEqual([]);
  expect(
    (await ada.api.call("getApproval", { params: { approvalId: approvalIdOf(waiting) } })).status,
  ).toBe("cancelled");
  expect(await refusalCode(ada.approveOnConfirmationPage(waitingLink, waitingView))).toBe(
    "confirmation_closed",
  );
  // What the mandate covered before now waits for a person, and the signer opens no page for it.
  await expectNoConfirmation(await propose(ledger, PAYEE, "0.001", "after the retirement"));
  const decisions = await signerDecisions(workspaceId);
  expect(decisions).toContainEqual(
    expect.objectContaining({
      action: "retire-wallet",
      approvalId: request.id,
      outcome: "allowed",
    }),
  );
  expect(decisions).toContainEqual(
    expect.objectContaining({ action: "revoke-mandate-on-retire", outcome: "allowed" }),
  );

  // Cancelling needs no passkey: it only keeps the key. The wallet is held, and still signs
  // nothing.
  const held = await ada.api.call("cancelRetireWallet", {
    params: { workspaceId, walletId: wallet.id },
    body: {},
  });

  expect(held.lifecycle).toEqual({ state: "held", destroyAfter: null });
  expect(await signerDecisions(workspaceId)).toContainEqual(
    expect.objectContaining({ action: "cancel-retire-wallet", outcome: "allowed" }),
  );
  await expectNoConfirmation(await propose(ledger, RECIPIENT, "0.001", "while held"));
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore);

  // A new policy, approved with a passkey, makes it sign again; the mandate stays ended.
  await setPolicy(workspaceId, wallet.id, payerPolicy(ledger.agentId, "0.6"));
  expect((await walletDetail(workspaceId, wallet.id)).lifecycle).toEqual({
    state: "active",
    destroyAfter: null,
  });
  expect(await getMandate(workspaceId, mandate.mandateId)).toMatchObject({ status: "revoked" });
  const paid = await propose(ledger, RECIPIENT, "0.003", LEDGER_MEMO);
  await ada.confirm(approvalIdOf(paid));
  expect(await intentSettles(paid.intentId)).toBe("confirmed");
  ledgerIntentId = paid.intentId;
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);
  expect(await auditActions(workspaceId)).toEqual(
    expect.arrayContaining(["wallet.retiring", "wallet.retirement_cancelled"]),
  );
});

test("an operator exports a wallet's key on the signer host, to a new file only that user can read, and the signer logs it", async () => {
  const { workspace, wallet } = ledger;
  const out = `/tmp/export-${wallet.id}.txt`;
  const args = ["export-wallet", "--workspace", workspace.id, "--wallet", wallet.id, "--out", out];

  try {
    const exported = await signerAdmin(...args);
    expect(exported).toMatchObject({
      ok: true,
      action: "export-wallet-by-operator",
      workspaceId: workspace.id,
      walletId: wallet.id,
      out,
    });
    expect(String(exported.address).toLowerCase()).toBe(wallet.address.toLowerCase());
    const mnemonic = (await exec("signer", "cat", out)).trim();
    expect(mnemonicToAccount(mnemonic).address.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect((await exec("signer", "stat", "-c", "%a", out)).trim()).toBe("600");
    // Never over an existing file, and never into a log.
    expect(await signerAdminRefusal(...args)).toBe("out_exists");
    expect(await compose("logs", "--no-color", "signer")).not.toContain(mnemonic);
    expect(await signerDecisions(workspace.id)).toContainEqual(
      expect.objectContaining({
        action: "export-wallet-by-operator",
        approvalId: null,
        outcome: "allowed",
      }),
    );
  } finally {
    await exec("signer", "rm", "-f", out);
  }
});

test("a retired wallet's key is destroyed at its time: the vault holds nothing of it, its signed transactions are emptied, and nothing can sign with or export it again", async () => {
  test.setTimeout(300_000);
  const { workspace, wallet } = ledger;
  const workspaceId = workspace.id;
  // The control: the vault names the wallet while its key exists.
  expect((await vaultFilesNaming([wallet.id]))[wallet.id]).toBeGreaterThan(0);
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });

  const destroyAfter = nowSeconds() + 5;
  await retire(workspaceId, wallet.id, destroyAfter);
  await expect
    .poll(async () => (await walletDetail(workspaceId, wallet.id)).lifecycle, {
      timeout: 180_000,
      intervals: [1_000],
    })
    .toEqual({ state: "destroyed", destroyAfter });

  // The key is gone from the vault, and the signer kept no copy of what it signed.
  expect(await vaultFilesNaming([wallet.id])).toEqual({ [wallet.id]: 0 });
  expect(
    await signerQuery(
      "SELECT state, length(sealed_credential) AS sealed, destroyed_at IS NOT NULL AS destroyed FROM wallets WHERE wallet_id = ?",
      wallet.id,
    ),
  ).toEqual([{ state: "destroyed", sealed: 0, destroyed: 1 }]);

  const [signed] = await signerQuery(
    "SELECT count(*) AS signatures, coalesce(sum(length(signed_transaction)), 0) AS bytes FROM signatures WHERE wallet_id = ?",
    wallet.id,
  );

  expect(Number(signed?.signatures)).toBeGreaterThanOrEqual(2);
  expect(signed?.bytes).toBe(0);
  expect(await signerDecisions(workspaceId)).toContainEqual(
    expect.objectContaining({ action: "destroy-wallet", outcome: "allowed" }),
  );
  expect(await auditActions(workspaceId)).toContain("wallet.destroyed");
  expect((await ada.api.call("verifyAudit", { params: { workspaceId } })).ok).toBe(true);
  expect(await signerAdmin("verify-log", "--workspace", workspaceId)).toMatchObject({ ok: true });

  // Nothing brings it back: no export, no second retirement, no page to approve a payment on.
  expect(
    await signerAdminRefusal(
      "export-wallet",
      "--workspace",
      workspaceId,
      "--wallet",
      wallet.id,
      "--out",
      `/tmp/export-after-destroy-${wallet.id}.txt`,
    ),
  ).toBe("wallet_retired");
  expect(await apiRefusal(requestRetire(workspaceId, wallet.id, nowSeconds() + 60))).toEqual({
    code: "conflict",
    detail: "wallet_retired",
  });
  await expectNoConfirmation(await propose(ledger, RECIPIENT, "0.001", "after the destruction"));
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore);
});

// --- deleting a workspace, and cancelling ---------------------------------------------------------

test("approving a deletion pauses the workspace, retires every wallet and ends every mandate at once, and stops its agents and its changes", async () => {
  studio = await newSpace(STUDIO_NAME, COURIER_NAME);
  const workspaceId = studio.workspace.id;
  studioMandateId = (
    await grantMandate(workspaceId, studio.wallet.id, mandateDraft(studio.agentId))
  ).mandateId;
  // A treasury whose retirement was cancelled (held), and a wallet already retiring on its own.
  reserve = await ada.api.call("createTreasury", {
    params: { workspaceId },
    body: { label: "Reserve" },
  });
  await retire(workspaceId, reserve.id, nowSeconds() + 3600);
  expect(
    (
      await ada.api.call("cancelRetireWallet", {
        params: { workspaceId, walletId: reserve.id },
        body: {},
      })
    ).lifecycle.state,
  ).toBe("held");
  spare = (await ada.api.call("createAgent", { params: { workspaceId }, body: { name: "Spare" } }))
    .wallet;
  await retire(workspaceId, spare.id, nowSeconds() + 7200);

  // A viewer, who approves nothing.
  const invite = await ada.api.call("createInvite", {
    params: { workspaceId },
    body: { role: "viewer" },
  });

  await bea.join(invite.url);

  await ada.api.call("pauseWorkspace", { params: { workspaceId }, body: {} });
  const ids = [studio.wallet.id, reserve.id, spare.id].sort();
  const preflight = await ada.api.call("getDeletionPreflight", { params: { workspaceId } });
  expect(preflight.wallets.map((entry) => entry.wallet.id).sort()).toEqual(ids);
  expect(preflight.blockers).toContain("nonzero_balance");

  studioDestroyAfter = nowSeconds() + 3600;

  const request = await ada.api.call("requestDeleteWorkspace", {
    params: { workspaceId },
    body: { destroyAfter: studioDestroyAfter },
  });

  deletionId = request.id;
  expect(request).toMatchObject({ kind: "delete-workspace", status: "pending", threshold: 1 });
  expect(request.title).toContain("Delete this workspace");
  const detail = await ada.api.call("getApproval", { params: { approvalId: request.id } });

  if (detail.envelope.type !== "delete-workspace") throw new Error("not a deletion");
  // Every wallet whose key the signer holds, the retiring one included, in id order.
  expect(detail.envelope.wallets.map((listed) => listed.walletId)).toEqual(ids);
  expect(detail.envelope.destroyAfter).toBe(studioDestroyAfter);

  const link = await ada.confirmationLink(request.id);
  const view = await ada.readConfirmation(link);
  expect(view).toMatchObject({ approvalId: request.id, kind: "delete-workspace", state: "open" });
  expect(view.title).toContain("Delete this workspace");
  expect(view.envelope).toEqual(detail.envelope);
  expect(view.warnings).toEqual(expect.arrayContaining(["keys_destroyed", "balances_unchecked"]));

  for (const wallet of [studio.wallet, reserve, spare]) {
    expect(shownText(view)).toContain(wallet.id.toLowerCase());
    expect(shownText(view)).toContain(wallet.address.toLowerCase());
  }

  await ada.approveOnConfirmationPage(link, view);
  await ada.api.call("collectApproval", { params: { approvalId: request.id }, body: {} });
  expect((await ada.settled(request.id)).status).toBe("executed");

  expect(await ada.api.call("getWorkspace", { params: { workspaceId } })).toMatchObject({
    paused: true,
    lifecycle: { state: "deleting", destroyAfter: studioDestroyAfter, deletedAt: null },
  });

  for (const id of ids) {
    expect((await walletDetail(workspaceId, id)).lifecycle).toEqual({
      state: "retiring",
      destroyAfter: studioDestroyAfter,
    });
  }

  expect(await getMandate(workspaceId, studioMandateId)).toMatchObject({
    status: "revoked",
    endedReason: "revoked",
  });
  const decisions = await signerDecisions(workspaceId);
  expect(decisions).toContainEqual(
    expect.objectContaining({
      action: "delete-workspace",
      approvalId: request.id,
      outcome: "allowed",
    }),
  );
  expect(decisions).toContainEqual(
    expect.objectContaining({ action: "revoke-mandate-on-delete", outcome: "allowed" }),
  );
  expect(await auditActions(workspaceId)).toContain("workspace.deleting");

  // Its agents are turned away, and only pausing, cancelling and reading still work.
  await expect(studio.agent.call("whoami")).rejects.toThrow();
  await expect(connectAgent(`${stack.origin}/mcp`, studio.token)).rejects.toThrow();
  const deleting = { code: "conflict", detail: "workspace_deleting" };
  expect(
    await apiRefusal(
      ada.api.call("createAgent", { params: { workspaceId }, body: { name: "Latecomer" } }),
    ),
  ).toEqual(deleting);
  expect(
    await apiRefusal(ada.api.call("requestResume", { params: { workspaceId }, body: {} })),
  ).toEqual(deleting);
  expect(
    await apiRefusal(
      ada.api.call("cancelRetireWallet", {
        params: { workspaceId, walletId: spare.id },
        body: {},
      }),
    ),
  ).toEqual(deleting);
});

test("a scheduled deletion is announced to the webhook, signed, with no sealed content, and no reminder is due for a delay under a day", async () => {
  const secret = await webhookSecret();
  const workspaceId = studio.workspace.id;

  const requests = await acknowledged(
    (body) => body.event === "lifecycle.scheduled" && body.approvalId === deletionId,
  );

  expect(requests).toHaveLength(1);
  const [request] = requests;

  if (!request) throw new Error("expected one delivery");
  const deliveryId = request.headers["x-os-delivery"];
  const hidden = [STUDIO_NAME, COURIER_NAME, "Reserve"];

  for (const wallet of [studio.wallet, reserve, spare]) {
    hidden.push(wallet.address, wallet.address.slice(2));
  }

  expect(expectSignedDelivery(secret, request, LIFECYCLE_EVENT_KEYS, hidden)).toEqual({
    v: 1,
    deliveryId,
    event: "lifecycle.scheduled",
    approvalId: deletionId,
    workspaceId,
    kind: "delete-workspace",
    // A deletion destroys every wallet's key; a retirement names its one wallet.
    walletId: null,
    destroyAfter: studioDestroyAfter,
    link: `${stack.origin}/w/${workspaceId}/approvals/${deletionId}`,
  });
  await expect
    .poll(() => webhookDeliveries(deletionId, "lifecycle.scheduled"), { timeout: 60_000 })
    .toEqual([{ id: deliveryId, state: "sent", attempts: 0 }]);
  // The reminder goes 24 hours before the destroy time; an hour ahead, that moment is past.
  expect(await webhookDeliveries(deletionId, "lifecycle.due_soon")).toEqual([]);
});

test("any member cancels a deletion during its delay: the keys are kept, each wallet goes back to where it stood and a retiring one is held, the mandates stay ended, and the workspace stays paused until people resume it", async () => {
  const workspaceId = studio.workspace.id;

  const cancelled = await bea.api.call("cancelDeleteWorkspace", {
    params: { workspaceId },
    body: {},
  });

  expect(cancelled).toMatchObject({
    paused: true,
    lifecycle: { state: "active", destroyAfter: null, deletedAt: null },
  });
  // Active stays active, held stays held, and the one that was retiring on its own is held:
  // nothing signs again without people approving it.
  expect((await walletDetail(workspaceId, studio.wallet.id)).lifecycle).toEqual({
    state: "active",
    destroyAfter: null,
  });

  for (const id of [reserve.id, spare.id]) {
    expect((await walletDetail(workspaceId, id)).lifecycle).toEqual({
      state: "held",
      destroyAfter: null,
    });
  }

  const kept = await vaultFilesNaming([studio.wallet.id, reserve.id, spare.id]);

  for (const count of Object.values(kept)) expect(count).toBeGreaterThan(0);
  expect(await getMandate(workspaceId, studioMandateId)).toMatchObject({ status: "revoked" });
  expect(await signerDecisions(workspaceId)).toContainEqual(
    expect.objectContaining({ action: "cancel-delete-workspace", outcome: "allowed" }),
  );
  expect(await auditActions(workspaceId)).toContain("workspace.deletion_cancelled");
  expect(
    await apiRefusal(bea.api.call("cancelDeleteWorkspace", { params: { workspaceId }, body: {} })),
  ).toEqual({ code: "conflict", detail: "active" });

  // Resuming needs the passkey, as always; then the kept key signs.
  const resume = await ada.api.call("requestResume", { params: { workspaceId }, body: {} });
  await ada.confirm(resume.id);
  expect((await ada.settled(resume.id)).status).toBe("executed");
  studio.agent = await connectAgent(`${stack.origin}/mcp`, studio.token);
  const nonceBefore = await chain.getTransactionCount({ address: studio.wallet.address });
  const paid = await propose(studio, RECIPIENT, "0.002", "after the cancelled deletion");
  expect(paid.authorizedBy).toBe("person");
  await ada.confirm(approvalIdOf(paid));
  expect(await intentSettles(paid.intentId)).toBe("confirmed");
  expect(await chain.getTransactionCount({ address: studio.wallet.address })).toBe(nonceBefore + 1);
});

// --- deleting a workspace for good ----------------------------------------------------------------

test("a deletion waits while a transaction of the workspace could still be mined, and a cancel of it can still be approved on the confirmation page", async () => {
  test.setTimeout(480_000);
  archive = await newSpace(ARCHIVE_NAME, ARCHIVIST_NAME);
  const workspaceId = archive.workspace.id;
  const { wallet } = archive;

  const mandate = await grantMandate(
    workspaceId,
    wallet.id,
    mandateDraft(archive.agentId, { purpose: PURPOSE_MARKER }),
  );

  const covered = await propose(archive, PAYEE, "0.001", "covered, in the archive");
  expect(covered).toMatchObject({ authorizedBy: "mandate", mandateId: mandate.mandateId });
  expect(await intentSettles(covered.intentId)).toBe("confirmed");

  const before = await chain.getBalance({ address: RECIPIENT });
  const nonceBefore = await chain.getTransactionCount({ address: wallet.address });
  let cancelHash = "";
  await withMiningHeld(async (mining) => {
    const proposal = await propose(archive, RECIPIENT, "0.002", MEMO_MARKER);
    archiveIntentId = proposal.intentId;
    await ada.confirm(approvalIdOf(proposal));
    await transactionOnceSent(proposal.intentId, (tx) => tx.status === "broadcast");

    // The controls for the next gates, while the workspace is whole: the signer's file holds
    // the memo and the purpose people and agents typed, its vault holds the key, the
    // workspace's name is readable, and its workflow runs have live keys.
    const markers = (await signerFileHits([MEMO_MARKER, PURPOSE_MARKER])).map((hit) => hit.marker);
    expect(markers).toEqual(expect.arrayContaining([MEMO_MARKER, PURPOSE_MARKER]));
    expect((await vaultFilesNaming([wallet.id]))[wallet.id]).toBeGreaterThan(0);
    const named = await scanForMarkers(await databaseUrl(), [ARCHIVE_NAME, ARCHIVIST_NAME]);
    expect(named.hits.map((hit) => hit.marker)).toEqual(
      expect.arrayContaining([ARCHIVE_NAME, ARCHIVIST_NAME]),
    );

    const [runKeys] = await query(
      "SELECT count(*) FILTER (WHERE wrapped_key IS NOT NULL)::int AS live FROM os_keys.data_keys WHERE scope = 'run' AND tenant_id = $1",
      [workspaceId],
    );

    expect(Number(runKeys?.live)).toBeGreaterThan(0);

    await ada.api.call("pauseWorkspace", { params: { workspaceId }, body: {} });
    // The operator's backup, taken before the deletion, for the keyring gate.
    await exec(
      "postgres",
      "pg_dump",
      "--username=postgres",
      "--dbname=postgres",
      "--format=custom",
      `--file=${DUMP}`,
    );

    const destroyAfter = nowSeconds() + 5;

    const deletion = await ada.api.call("requestDeleteWorkspace", {
      params: { workspaceId },
      body: { destroyAfter },
    });

    await ada.confirm(deletion.id);
    expect((await ada.settled(deletion.id)).status).toBe("executed");
    const preflight = await ada.api.call("getDeletionPreflight", { params: { workspaceId } });
    expect(preflight.blockers).toContain("unmined_transactions");

    // Past its time, the server's finalize step skips it: the payment could still be mined.
    await expect
      .poll(() => deletionSkips(workspaceId), { timeout: 180_000, intervals: [2_000] })
      .toContain("unmined_transactions");
    expect((await ada.api.call("getWorkspace", { params: { workspaceId } })).lifecycle.state).toBe(
      "deleting",
    );
    expect((await vaultFilesNaming([wallet.id]))[wallet.id]).toBeGreaterThan(0);

    // A cancel of the payment is the one request the signer still opens a page for while a
    // deletion waits. Approved there, it is signed at the payment's nonce.
    const cancel = await ada.api.call("requestCancel", {
      params: { intentId: proposal.intentId },
      body: {},
    });

    expect(cancel).toMatchObject({ kind: "cancel-transaction", status: "pending" });
    const link = await ada.confirmationLink(cancel.id);
    const view = await ada.readConfirmation(link);
    expect(view).toMatchObject({
      approvalId: cancel.id,
      kind: "cancel-transaction",
      state: "open",
    });
    await ada.approveOnConfirmationPage(link, view);
    await ada.api.call("collectApproval", { params: { approvalId: cancel.id }, body: {} });
    expect((await ada.settled(cancel.id)).status).toBe("executed");

    const { transaction } = await transactionOnceSent(
      proposal.intentId,
      (tx) => tx.attempts.length === 2,
    );

    const cancelling = transaction.attempts[1];

    if (!cancelling) throw new Error("no cancel attempt");
    expect(cancelling).toMatchObject({ kind: "cancel", cancelApprovalId: cancel.id });
    cancelHash = cancelling.hash;
    await mining.resume();
  });

  // The cancel is mined in the payment's place; then the deletion finishes.
  await expect
    .poll(async () => (await receiptOf(cancelHash as Hash))?.status, { timeout: 60_000 })
    .toBe("success");
  await waitForDeleted(workspaceId);
  expect(await chain.getBalance({ address: RECIPIENT })).toBe(before);
  expect(await chain.getTransactionCount({ address: wallet.address })).toBe(nonceBefore + 1);
});

test("a deleted workspace signs nothing and nothing it stored can be opened: its keys, its sealed data and its runs' data are gone, and only a tombstone is left", async () => {
  const workspaceId = archive.workspace.id;
  const { wallet } = archive;

  // To its former members it no longer exists; its agent's token opens nothing.
  expect(await apiRefusal(ada.api.call("getWorkspace", { params: { workspaceId } }))).toMatchObject(
    { code: "not_found" },
  );
  const listed = await ada.api.call("listWorkspaces");
  expect(listed.items.map((item) => item.id)).not.toContain(workspaceId);
  await expect(connectAgent(`${stack.origin}/mcp`, archive.token)).rejects.toThrow();

  // The control plane's tombstone: ids, statuses and times, no names, no members.
  expect(
    await query(
      "SELECT name, lifecycle, paused, deleted_at IS NOT NULL AS deleted FROM os.workspaces WHERE id = $1",
      [workspaceId],
    ),
  ).toEqual([{ name: "Deleted workspace", lifecycle: "deleted", paused: true, deleted: true }]);
  expect(
    await query("SELECT lifecycle, label FROM os.wallets WHERE workspace_id = $1", [workspaceId]),
  ).toEqual([{ lifecycle: "destroyed", label: "" }]);
  expect(
    await query("SELECT name, status FROM os.agents WHERE workspace_id = $1", [workspaceId]),
  ).toEqual([{ name: "Removed agent", status: "disabled" }]);
  expect(
    await query("SELECT count(*)::int AS members FROM os.memberships WHERE workspace_id = $1", [
      workspaceId,
    ]),
  ).toEqual([{ members: 0 }]);
  expect(
    await query(
      "SELECT action FROM os.audit_events WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1",
      [workspaceId],
    ),
  ).toEqual([{ action: "workspace.deleted" }]);
  expect(
    await query(
      "SELECT count(*)::int AS pending FROM os.notification_deliveries WHERE workspace_id = $1 AND state = 'pending'",
      [workspaceId],
    ),
  ).toEqual([{ pending: 0 }]);

  // Its data keys are shredded: the workspace's, and every one of its workflow runs'.
  expect(
    await query(
      "SELECT wrapped_key IS NULL AS unwrappable, shredded_at IS NOT NULL AS shredded FROM os_keys.data_keys WHERE scope = 'workspace' AND key_id = $1",
      [workspaceId],
    ),
  ).toEqual([{ unwrappable: true, shredded: true }]);

  const [runKeys] = await query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE wrapped_key IS NULL AND shredded_at IS NOT NULL)::int AS shredded FROM os_keys.data_keys WHERE scope = 'run' AND tenant_id = $1",
    [workspaceId],
  );

  expect(Number(runKeys?.total)).toBeGreaterThan(0);
  expect(runKeys?.shredded).toBe(runKeys?.total);
  // Its sealed payment no longer opens with the live keyring; another workspace's still does.
  expect(
    await openSealedIntent({
      database: "postgres",
      keyring: KEYRING,
      intentId: archiveIntentId,
      marker: MEMO_MARKER,
    }),
  ).toMatchObject({ outcome: "refused", error: "DataKeyUnavailableError" });
  expect(
    await openSealedIntent({
      database: "postgres",
      keyring: KEYRING,
      intentId: ledgerIntentId,
      marker: LEDGER_MEMO,
    }),
  ).toEqual({ outcome: "opened", containsMarker: true });
  // The operator's command finds nothing left to shred.
  expect(
    lastLine(
      await exec("server", "node", "packages/keys/src/cli.ts", "shred-tenant", "run", workspaceId),
    ),
  ).toEqual({ event: "keys.shred_tenant", scope: "run", tenantId: workspaceId, shredded: 0 });

  // Nothing anyone typed in it is readable in the database; names a person typed elsewhere are.
  const url = await databaseUrl();

  const scan = await scanForMarkers(url, [
    MEMO_MARKER,
    PURPOSE_MARKER,
    ARCHIVE_NAME,
    ARCHIVIST_NAME,
  ]);

  expect(scan.hits).toEqual([]);
  expect((await scanForMarkers(url, [LEDGER_NAME])).hits.length).toBeGreaterThan(0);

  // The signer: the key is gone from the vault, the wallet destroyed, what it signed emptied,
  // the mandate's text blanked, no confirmation or approver left, and the log ends with the
  // deletion and still verifies.
  expect(await vaultFilesNaming([wallet.id])).toEqual({ [wallet.id]: 0 });
  expect(
    await signerQuery("SELECT state, paused FROM workspaces WHERE workspace_id = ?", workspaceId),
  ).toEqual([{ state: "deleted", paused: 1 }]);
  expect(
    await signerQuery(
      "SELECT state, length(sealed_credential) AS sealed, destroyed_at IS NOT NULL AS destroyed FROM wallets WHERE workspace_id = ?",
      workspaceId,
    ),
  ).toEqual([{ state: "destroyed", sealed: 0, destroyed: 1 }]);
  expect(
    await signerQuery(
      "SELECT coalesce(sum(length(signed_transaction)), 0) AS bytes FROM signatures WHERE wallet_id = ?",
      wallet.id,
    ),
  ).toEqual([{ bytes: 0 }]);

  const [attempts] = await signerQuery(
    "SELECT count(*) AS attempts, coalesce(sum(length(signed_transaction)), 0) AS bytes FROM signature_attempts WHERE approval_id IN (SELECT approval_id FROM signatures WHERE wallet_id = ?)",
    wallet.id,
  );

  expect(Number(attempts?.attempts)).toBeGreaterThan(0);
  expect(attempts?.bytes).toBe(0);
  expect(
    await signerQuery(
      "SELECT revoked_reason AS reason, length(mandate) AS text FROM mandates WHERE workspace_id = ?",
      workspaceId,
    ),
  ).toEqual([{ reason: "requested", text: 0 }]);
  expect(
    await signerQuery(
      "SELECT (SELECT count(*) FROM confirmations WHERE workspace_id = ?) AS confirmations, (SELECT count(*) FROM approvers WHERE workspace_id = ?) AS approvers",
      workspaceId,
      workspaceId,
    ),
  ).toEqual([{ confirmations: 0, approvers: 0 }]);

  const actions = (
    await signerQuery(
      "SELECT action FROM decisions WHERE workspace_id = ? ORDER BY seq",
      workspaceId,
    )
  ).map((row) => row.action);

  expect(actions).toEqual(
    expect.arrayContaining(["revoke-mandate-on-delete", "cancel-transaction", "destroy-wallet"]),
  );
  expect(actions.at(-1)).toBe("delete-workspace");
  expect(await signerAdmin("verify-log", "--workspace", workspaceId)).toMatchObject({ ok: true });
  expect(await signerFileHits([MEMO_MARKER, PURPOSE_MARKER])).toEqual([]);
  expect(
    await signerAdminRefusal(
      "export-wallet",
      "--workspace",
      workspaceId,
      "--wallet",
      wallet.id,
      "--out",
      `/tmp/export-deleted-${wallet.id}.txt`,
    ),
  ).toMatch(/^(workspace_deleted|wallet_retired)$/);
});

test("after a deletion and a keyring rotation, a database copy from before the deletion cannot be opened with the current keyring, and opens with a keyring copy from before the rotation", async () => {
  test.setTimeout(300_000);
  const workspaceId = archive.workspace.id;
  const copy = { database: COPY_DATABASE, intentId: archiveIntentId, marker: MEMO_MARKER };

  try {
    // The operator's backup, restored into a scratch database beside the live one.
    await exec("postgres", "createdb", "--username=postgres", COPY_DATABASE);

    const restoring = await exec(
      "postgres",
      "pg_restore",
      "--username=postgres",
      `--dbname=${COPY_DATABASE}`,
      "--no-owner",
      DUMP,
    ).then(
      () => "",
      (error: { stderr?: string }) => error.stderr ?? "pg_restore failed",
    );

    expect(
      await query(
        "SELECT wrapped_key IS NOT NULL AS wrapped FROM os_keys.data_keys WHERE scope = 'workspace' AND key_id = $1",
        [workspaceId],
        COPY_DATABASE,
      ),
      restoring,
    ).toEqual([{ wrapped: true }]);

    // Until the keyring is rotated, the copy still opens: the erasure window of the deploy
    // guide.
    expect(await openSealedIntent({ ...copy, keyring: KEYRING })).toEqual({
      outcome: "opened",
      containsMarker: true,
    });

    // A keyring backup from before the rotation, kept where a backup of `server-secrets` is.
    await compose(
      "run",
      "--rm",
      "init",
      "cp",
      "-p",
      "/secrets/server/keyring.json",
      `/secrets/server/${KEYRING_COPY}`,
    );

    // The rotation, exactly as the deploy guide gives it.
    const added = lastLine(
      await compose("run", "--rm", "init", "node", "/init/rotate-keyring.mjs", "add"),
    );

    expect(added).toMatchObject({ event: "keyring.added" });
    await compose("restart", "server");
    await waitUntilHealthy();
    const rewrapped = lastLine(await exec("server", "node", "packages/keys/src/cli.ts", "rewrap"));
    expect(rewrapped).toMatchObject({
      event: "keys.rewrap",
      activeKek: added.active,
      failedCount: 0,
    });

    const pruned = lastLine(
      await compose(
        "run",
        "--rm",
        "init",
        "node",
        "/init/rotate-keyring.mjs",
        "prune",
        "--confirm-rewrapped",
      ),
    );

    expect(pruned).toMatchObject({ event: "keyring.pruned", active: added.active });
    expect((pruned.removed as string[]).length).toBeGreaterThan(0);
    await compose("restart", "server");
    await waitUntilHealthy();

    // The copy no longer opens with the keyring in use; it does with the old keyring.
    const refused = await openSealedIntent({ ...copy, keyring: KEYRING });
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused.message).toContain("unknown KEK");
    expect(
      await openSealedIntent({ ...copy, keyring: `/run/secrets/server/${KEYRING_COPY}` }),
    ).toEqual({ outcome: "opened", containsMarker: true });

    // The live workspaces were rewrapped and still open, and the stack still serves them.
    expect(
      await openSealedIntent({
        database: "postgres",
        keyring: KEYRING,
        intentId: ledgerIntentId,
        marker: LEDGER_MEMO,
      }),
    ).toEqual({ outcome: "opened", containsMarker: true });
    expect((await ada.api.call("getIntent", { params: { intentId: ledgerIntentId } })).status).toBe(
      "confirmed",
    );
  } finally {
    await compose("run", "--rm", "init", "rm", "-f", `/secrets/server/${KEYRING_COPY}`);
    await exec("postgres", "dropdb", "--username=postgres", "--if-exists", COPY_DATABASE);
    await exec("postgres", "rm", "-f", DUMP);
  }
});

// --- exporting, cloning and importing a workspace -------------------------------------------------

test("an owner's template of a workspace carries its settings, wallets, policies, members and roles, and no key, address, token, mandate or history; the operator's export of its wallet's key derives the wallet's address", async () => {
  test.setTimeout(300_000);
  adaId = (await ada.api.call("getSession")).user?.id ?? "";
  atelier = await newSpace(ATELIER_NAME, CLERK_NAME, atelierPolicy);
  const workspaceId = atelier.workspace.id;
  const { wallet } = atelier;
  cydId = await joinAsApprover(cyd, workspaceId);

  // Cyd's device and settings, everything personal that erasing her removes later.
  const device = await cyd.api.call("addPushSubscription", {
    body: {
      endpoint: CYD_PUSH_ENDPOINT,
      keys: {
        p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
      label: "Cyd's phone",
    },
  });

  expect((await cyd.api.call("listPushSubscriptions")).items.map((item) => item.id)).toEqual([
    device.id,
  ]);
  await cyd.api.call("setNotificationPreferences", {
    body: {
      workspaces: [{ workspaceId, webPush: true, reminders: true }],
      quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Berlin" },
    },
  });

  // Cyd's passkey grants the mandate; it covers one payment, and Ada approves another.
  atelierMandateId = (
    await grantMandate(
      workspaceId,
      wallet.id,
      mandateDraft(atelier.agentId, { purpose: EXPORT_PURPOSE }),
      cyd,
    )
  ).mandateId;
  expect(
    (await getMandate(workspaceId, atelierMandateId)).grantedBy.map((person) => person.displayName),
  ).toEqual([CYD_NAME]);
  const covered = await propose(atelier, PAYEE, "0.001", "covered, in the atelier");
  expect(covered).toMatchObject({ authorizedBy: "mandate", mandateId: atelierMandateId });
  expect(await intentSettles(covered.intentId)).toBe("confirmed");
  const paid = await propose(atelier, RECIPIENT, "0.002", EXPORT_MEMO);
  expect(paid.authorizedBy).toBe("person");
  await ada.confirm(approvalIdOf(paid));
  expect(await intentSettles(paid.intentId)).toBe("confirmed");
  atelierPaidIntentId = paid.intentId;
  atelierIntentIds = [covered.intentId, paid.intentId];

  // A treasury, a notification level other than the default, and an admin threshold of 2.
  strongbox = await ada.api.call("createTreasury", {
    params: { workspaceId },
    body: { label: STRONGBOX },
  });
  await ada.api.call("setNotificationDetail", {
    params: { workspaceId },
    body: { detail: "summary" },
  });

  const raise = await ada.api.call("requestAdminThreshold", {
    params: { workspaceId },
    body: { adminThreshold: 2 },
  });

  await ada.confirm(raise.id);
  expect((await ada.settled(raise.id)).status).toBe("executed");
  expect((await ada.api.call("getWorkspace", { params: { workspaceId } })).adminThreshold).toBe(2);

  // The signer's operator exports the wallet's key on its host: it derives the wallet's address.
  const out = `/tmp/export-${wallet.id}.txt`;

  try {
    expect(
      await signerAdmin(
        "export-wallet",
        "--workspace",
        workspaceId,
        "--wallet",
        wallet.id,
        "--out",
        out,
      ),
    ).toMatchObject({ ok: true, action: "export-wallet-by-operator", walletId: wallet.id });
    const mnemonic = (await exec("signer", "cat", out)).trim();
    const account = mnemonicToAccount(mnemonic);
    expect(account.address.toLowerCase()).toBe(wallet.address.toLowerCase());
    const privateKey = account.getHdKey().privateKey;

    if (!privateKey) throw new Error("the exported key derives no private key");
    atelierSecrets = [mnemonic, Buffer.from(privateKey).toString("hex")];
  } finally {
    await exec("signer", "rm", "-f", out);
  }

  // The template: settings, wallets by ref, the policy with its requester as a ref, members.
  atelierTemplate = await ada.api.call("exportTemplate", { params: { workspaceId } });
  const { policy } = await walletDetail(workspaceId, wallet.id);

  if (!policy) throw new Error("the atelier's wallet has no policy");
  expect(atelierTemplate).toEqual({
    format: "askgina.os/workspace-template/v1",
    name: ATELIER_NAME,
    adminThreshold: 2,
    notificationDetail: "summary",
    wallets: [
      {
        ref: "w1",
        kind: "agent",
        label: wallet.label,
        agent: { name: CLERK_NAME },
        policy: {
          chains: [CHAIN],
          requesters: ["w1"],
          assets: policy.assets,
          recipients: { mode: "allowlist", addresses: [PAYEE, RECIPIENT] },
          contractCalls: { mode: "deny" },
          fees: policy.fees,
          approvals: { threshold: 1, ttlSeconds: 3600 },
        },
      },
      { ref: "w2", kind: "treasury", label: STRONGBOX, agent: null, policy: null },
    ],
    members: [
      { userId: adaId, role: "owner" },
      { userId: cydId, role: "approver" },
    ].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
  });
  // Nothing in it is a key, an address, a token, an id of this workspace or what anyone typed.
  const text = JSON.stringify(atelierTemplate).toLowerCase();

  for (const value of [
    atelier.token,
    ...atelierSecrets,
    workspaceId,
    wallet.id,
    wallet.address.slice(2),
    strongbox.id,
    strongbox.address.slice(2),
    atelier.agentId,
    atelierMandateId,
    covered.intentId,
    paid.intentId,
    EXPORT_MEMO,
    EXPORT_PURPOSE,
  ]) {
    expect(text).not.toContain(value.toLowerCase());
  }
});

test("an owner signed in with a passkey in the last five minutes exports the record: it verifies offline, opens the workspace's history, carries no secret, and the verifier refuses it with one byte changed, its last line cut or two lines swapped", async () => {
  const workspaceId = atelier.workspace.id;
  // A request that waits, so its confirmation link exists while the record is written.
  const waiting = await propose(atelier, RECIPIENT, "0.001", "waits while the record is exported");
  expect(waiting.authorizedBy).toBe("person");
  const link = await ada.confirmationLink(approvalIdOf(waiting));

  // Owners only, and only with a recent passkey sign-in: a session left open is not enough.
  expect((await apiRefusal(cyd.api.call("exportRecord", { params: { workspaceId } }))).code).toBe(
    "forbidden",
  );
  await signedInLongAgo(adaId);
  expect(await apiRefusal(ada.api.call("exportRecord", { params: { workspaceId } }))).toEqual({
    code: "forbidden",
    detail: "sign_in_again",
  });
  await ada.signIn();
  const { record } = await ada.api.call("exportRecord", { params: { workspaceId } });
  const decisions = await signerDecisions(workspaceId);

  // A header, every section, an end line that counts them; the heads are the newest entries.
  const lines = parseRecord(record);
  const header = lines[0];
  const end = lines.at(-1);
  expect(header).toMatchObject({ format: "askgina.os/workspace-record/v1", workspaceId });
  expect(end).toMatchObject({ type: "end" });
  expect(end?.counts).toEqual(
    Object.fromEntries(
      RECORD_SECTIONS.map((section) => [section, sectionOf(lines, section).length]),
    ),
  );
  const audit = sectionOf(lines, "audit");
  expect(audit.map((line) => line.action)).toContain("workspace.exported");
  expect(header?.auditHead).toEqual({ seq: audit.at(-1)?.seq, hash: audit.at(-1)?.hash });
  expect(sectionOf(lines, "signer-decision")).toHaveLength(decisions.length);
  expect(header?.signerDecisionHead).toEqual({
    seq: decisions.at(-1)?.seq,
    hash: decisions.at(-1)?.hash,
  });
  expect(
    sectionOf(lines, "intent")
      .map((line) => String(line.id))
      .sort(),
  ).toEqual([...atelierIntentIds, waiting.intentId].sort());
  expect(sectionOf(lines, "transaction")).toHaveLength(2);
  expect(sectionOf(lines, "policy-revision")).toHaveLength(1);
  expect(sectionOf(lines, "mandate")).toEqual([
    expect.objectContaining({ mandateId: atelierMandateId }),
  ]);
  expect(sectionOf(lines, "mandate-use")).toHaveLength(1);
  // What people and agents typed is opened, the memo and the mandate's purpose.
  expect(record).toContain(EXPORT_MEMO);
  expect(record).toContain(EXPORT_PURPOSE);

  // No secret: no token, key, session, confirmation link, device, signature or sealed value.
  const intent = await ada.api.call("getIntent", { params: { intentId: atelierPaidIntentId } });

  if (!intent.transaction) throw new Error("the atelier's payment has no transaction");
  const signed = await chain.getTransaction({ hash: intent.transaction.hash as Hash });

  const sessions = await query("SELECT id_hash FROM os.sessions WHERE user_id = ANY($1)", [
    [adaId, cydId],
  ]);

  const [sealed] = await query(
    "SELECT encode(payload, 'hex') AS hex, encode(payload, 'base64') AS base64 FROM os.intents WHERE id = $1",
    [atelierPaidIntentId],
  );

  const lower = record.toLowerCase();

  for (const secret of [
    atelier.token,
    ...atelierSecrets,
    link.token,
    CYD_PUSH_ENDPOINT,
    signed.r.slice(2),
    signed.s.slice(2),
    ...sessions.map((row) => String(row.id_hash)),
    String(sealed?.hex).slice(64, 128),
    String(sealed?.base64).replace(/\n/g, "").slice(40, 88),
  ]) {
    expect(lower).not.toContain(secret.toLowerCase());
  }

  // The verifier the deploy guide gives accepts it, and refuses every change to it.
  expect(await verifyRecordFile(record)).toEqual({
    exitCode: 0,
    result: { ok: true, brokenAt: null },
  });
  const raw = recordLines(record);
  const file = (text: string[]) => `${text.join("\n")}\n`;
  const exported = raw.findIndex((line) => line.includes('"action":"workspace.exported"'));
  expect(exported).toBeGreaterThan(0);
  const changed = [...raw];
  changed[exported] = (raw[exported] ?? "").replace("workspace-record/v1", "workspace-record/v2");
  expect(changed[exported]).not.toBe(raw[exported]);
  expect(await verifyRecordFile(file(changed))).toEqual({
    exitCode: 2,
    result: { ok: false, brokenAt: exported + 1 },
  });
  expect(await verifyRecordFile(file(raw.slice(0, -1)))).toEqual({
    exitCode: 2,
    result: { ok: false, brokenAt: raw.length },
  });
  const swapped = [raw[0] ?? "", raw[2] ?? "", raw[1] ?? "", ...raw.slice(3)];
  expect(await verifyRecordFile(file(swapped))).toEqual({
    exitCode: 2,
    result: { ok: false, brokenAt: 2 },
  });
  await ada.reject(approvalIdOf(waiting));
  expect(await intentSettles(waiting.intentId)).toBe("rejected");
});

test("cloning a workspace makes a new one from its configuration: new wallets at new addresses, a new agent token, its policy only once people approve it, and nothing of the source's history or authority; the source is untouched and its agent's token reaches nothing of the clone", async () => {
  test.setTimeout(300_000);
  const sourceId = atelier.workspace.id;
  const source = await ada.api.call("getWorkspace", { params: { workspaceId: sourceId } });
  const sourceAudit = await auditActions(sourceId);
  const { policy } = await walletDetail(sourceId, atelier.wallet.id);

  if (!policy) throw new Error("the atelier's wallet has no policy");

  const clone = await ada.api.call("cloneWorkspace", {
    params: { workspaceId: sourceId },
    body: { name: COPY_NAME, includeAgents: true, includeMembers: true },
  });

  const copy = clone.workspace;
  const copyId = copy.id;
  expect(copyId).not.toBe(sourceId);
  // The person cloning is its only member and approver, at an admin threshold of 1; the source's
  // threshold comes back as a reminder only.
  expect(copy).toMatchObject({
    name: COPY_NAME,
    role: "owner",
    paused: false,
    adminThreshold: 1,
    notificationDetail: "summary",
    lifecycle: { state: "active", destroyAfter: null, deletedAt: null },
  });
  expect(copy.members.map((member) => [member.user.id, member.role, member.approver])).toEqual([
    [adaId, "owner", "active"],
  ]);
  expect(clone.templateAdminThreshold).toBe(2);
  // Each wallet again, with a new key: a new id and an address that never sent anything.
  expect(copy.wallets.map((wallet) => [wallet.kind, wallet.label]).sort()).toEqual(
    source.wallets.map((wallet) => [wallet.kind, wallet.label]).sort(),
  );

  for (const wallet of copy.wallets) {
    expect(source.wallets.map((known) => known.id)).not.toContain(wallet.id);
    expect(source.wallets.map((known) => known.address)).not.toContain(wallet.address);
    expect(wallet.policy).toBeNull();
    expect(await chain.getTransactionCount({ address: wallet.address })).toBe(0);
  }

  // The agent again, with a new token shown once.
  expect(clone.agents).toHaveLength(1);
  const [made] = clone.agents;

  if (!made) throw new Error("the clone made no agent");
  expect(made.agentId).not.toBe(atelier.agentId);
  expect(made.token).not.toBe(atelier.token);
  expect(copy.agents).toEqual([
    expect.objectContaining({
      id: made.agentId,
      name: CLERK_NAME,
      status: "active",
      walletId: made.walletId,
    }),
  ]);
  const copyWallet = copy.wallets.find((wallet) => wallet.id === made.walletId);

  if (!copyWallet) throw new Error("the clone's agent has no wallet in it");
  // An invite for the member this installation knows, with her role, for Ada to pass on.
  expect(clone.invites).toEqual([
    {
      userId: cydId,
      displayName: CYD_NAME,
      role: "approver",
      url: expect.any(String),
      expiresAt: expect.any(Number),
    },
  ]);

  // Nothing of the source's history or authority: one policy request, no intent, no mandate.
  const [proposal] = clone.approvals;
  expect(clone.approvals).toEqual([
    expect.objectContaining({ kind: "set-policy", status: "pending", threshold: 1 }),
  ]);

  if (!proposal) throw new Error("the clone opened no policy request");
  const detail = await ada.api.call("getApproval", { params: { approvalId: proposal.id } });

  if (detail.envelope.type !== "set-policy") throw new Error("not a policy request");
  expect(detail.envelope).toMatchObject({ walletId: made.walletId, previousPolicyHash: null });

  const listed = await ada.api.call("listApprovals", {
    params: { workspaceId: copyId },
    query: { status: "all" },
  });

  expect(listed.items.map((item) => item.id)).toEqual([proposal.id]);
  expect((await ada.api.call("listIntents", { params: { workspaceId: copyId } })).items).toEqual(
    [],
  );
  expect((await ada.api.call("listMandates", { params: { workspaceId: copyId } })).items).toEqual(
    [],
  );

  // Until people approve, the signer holds no policy for the new wallet: its agent proposes nothing.
  const copyAgent = await connectAgent(`${stack.origin}/mcp`, made.token);
  expect(await copyAgent.call("whoami")).toMatchObject({
    agent: { id: made.agentId, name: CLERK_NAME },
    workspaceId: copyId,
    wallets: [expect.objectContaining({ walletId: made.walletId, policy: null })],
    mandates: [],
  });
  expect(
    await toolRefusal(
      copyAgent.proposeTransfer({ chainId: CHAIN, to: PAYEE, amount: "0.001", memo: "too early" }),
    ),
  ).toEqual({ code: "policy_denied", detail: "policy_missing" });

  // The source's agent token reaches nothing of the clone, and the clone's nothing of the source.
  expect((await atelier.agent.call("whoami")).workspaceId).toBe(sourceId);
  expect(
    await toolRefusal(atelier.agent.call("get_balances", { walletId: made.walletId })),
  ).toMatchObject({ code: "not_found" });
  expect(
    await toolRefusal(
      atelier.agent.proposeTransfer({
        chainId: CHAIN,
        to: PAYEE,
        amount: "0.001",
        memo: "from the copy's wallet",
        walletId: made.walletId,
      }),
    ),
  ).toMatchObject({ code: "not_found" });
  expect(
    await toolRefusal(copyAgent.call("get_balances", { walletId: atelier.wallet.id })),
  ).toMatchObject({ code: "not_found" });

  // Approved on the confirmation page, the policy is the source's, for the new agent and wallet.
  await ada.confirm(proposal.id);
  expect((await ada.settled(proposal.id)).status).toBe("executed");
  expect((await walletDetail(copyId, made.walletId)).policy).toEqual({
    ...policy,
    workspaceId: copyId,
    walletId: made.walletId,
    requesters: [made.agentId],
  });
  // It pays an address on the copied list and nothing off it; the source's mandate is not copied.
  await chainAdmin.setBalance({ address: copyWallet.address, value: parseEther("1") });
  expect(
    await toolRefusal(
      copyAgent.proposeTransfer({
        chainId: CHAIN,
        to: STRANGER,
        amount: "0.001",
        memo: "off the list",
      }),
    ),
  ).toEqual({ code: "policy_denied", detail: "recipient_not_allowed" });

  const paid = await copyAgent.proposeTransfer({
    chainId: CHAIN,
    to: PAYEE,
    amount: "0.002",
    memo: COPY_MEMO,
  });

  expect(paid).toMatchObject({ authorizedBy: "person", mandateId: null });
  await ada.confirm(approvalIdOf(paid));
  expect(await intentSettles(paid.intentId)).toBe("confirmed");
  expect(await chain.getTransactionCount({ address: copyWallet.address })).toBe(1);
  await copyAgent.close();

  // The source is as it was: settings, people, agent, wallets, policy, mandate, log.
  expect(
    standing(await ada.api.call("getWorkspace", { params: { workspaceId: sourceId } })),
  ).toEqual(standing(source));
  expect(await auditActions(sourceId)).toEqual(sourceAudit);
  expect(await getMandate(sourceId, atelierMandateId)).toMatchObject({ status: "active" });

  // The clone's record holds its own history from the clone on, and nothing of the source's.
  await ada.signIn();
  const { record } = await ada.api.call("exportRecord", { params: { workspaceId: copyId } });
  const lines = parseRecord(record);
  const cloned = sectionOf(lines, "audit").find((line) => line.action === "workspace.cloned");
  expect(cloned?.detail).toEqual({
    source: { workspaceId: sourceId },
    notificationDetail: "summary",
    templateAdminThreshold: 2,
    includeAgents: true,
    includeMembers: true,
  });
  expect(sectionOf(lines, "intent").map((line) => line.id)).toEqual([paid.intentId]);
  expect(sectionOf(lines, "mandate")).toEqual([]);
  expect(sectionOf(lines, "mandate-use")).toEqual([]);
  expect(record).toContain(COPY_MEMO);

  for (const value of [
    EXPORT_MEMO,
    EXPORT_PURPOSE,
    atelier.wallet.id,
    atelier.wallet.address.slice(2),
    atelier.agentId,
    atelierMandateId,
    ...atelierIntentIds,
  ]) {
    expect(record.toLowerCase()).not.toContain(value.toLowerCase());
  }
});

test("a template imported on this installation reproduces the workspace's configuration once people approve its policy, invites only people known here, and a template this installation cannot honour is refused with nothing created", async () => {
  test.setTimeout(300_000);

  const workspaces = async () =>
    (await ada.api.call("listWorkspaces")).items.map((item) => item.id).sort();

  const before = await workspaces();

  const importing = (template: WorkspaceTemplate, name: string) =>
    ada.api.call("importTemplate", {
      body: { template, name, includeAgents: true, includeMembers: true },
    });

  // Refused before anything is created: a chain not configured here, a field the format does
  // not have, and a requester that is not an agent's wallet.
  const otherChain: WorkspaceTemplate = {
    ...atelierTemplate,
    wallets: atelierTemplate.wallets.map((wallet) =>
      wallet.policy === null
        ? wallet
        : {
            ...wallet,
            policy: {
              ...wallet.policy,
              chains: ["eip155:1"],
              assets: wallet.policy.assets.map((limit) => ({ ...limit, chainId: "eip155:1" })),
            },
          },
    ),
  };

  const withKeys = {
    ...atelierTemplate,
    keys: { [atelier.wallet.id]: "a key a template never carries" },
  } as unknown as WorkspaceTemplate;

  const treasuryRequester: WorkspaceTemplate = {
    ...atelierTemplate,
    wallets: atelierTemplate.wallets.map((wallet) =>
      wallet.policy === null
        ? wallet
        : { ...wallet, policy: { ...wallet.policy, requesters: ["w2"] } },
    ),
  };

  for (const template of [otherChain, withKeys, treasuryRequester]) {
    expect((await apiRefusal(importing(template, FOREIGN_NAME))).code).toBe("invalid_request");
  }

  expect(await workspaces()).toEqual(before);

  // From another installation: the people it names are unknown here, so nobody is invited.
  const foreign = await ada.api.call("importTemplate", {
    body: {
      template: { ...atelierTemplate, members: [{ userId: STRANGER_USER, role: "approver" }] },
      name: FOREIGN_NAME,
      includeAgents: false,
      includeMembers: true,
    },
  });

  expect(foreign).toMatchObject({ invites: [], agents: [], approvals: [] });
  expect(foreign.workspace.wallets.map((wallet) => [wallet.kind, wallet.label])).toEqual([
    ["treasury", STRONGBOX],
  ]);

  // The template as exported: the same wallets, agent, policy request, and an invite for Cyd.
  const imported = await importing(atelierTemplate, IMPORT_NAME);
  const importedId = imported.workspace.id;
  expect(imported.templateAdminThreshold).toBe(2);
  expect(imported.invites.map((invite) => [invite.userId, invite.role])).toEqual([
    [cydId, "approver"],
  ]);
  expect(imported.agents).toHaveLength(1);
  const [proposal] = imported.approvals;
  expect(imported.approvals).toEqual([
    expect.objectContaining({ kind: "set-policy", status: "pending" }),
  ]);

  if (!proposal) throw new Error("the import opened no policy request");

  const source = await ada.api.call("getWorkspace", {
    params: { workspaceId: atelier.workspace.id },
  });

  expect(imported.workspace.wallets).toHaveLength(source.wallets.length);

  for (const wallet of imported.workspace.wallets) {
    expect(source.wallets.map((known) => known.address)).not.toContain(wallet.address);
  }

  await ada.confirm(proposal.id);
  expect((await ada.settled(proposal.id)).status).toBe("executed");
  // Exported again, it is the template it came from, but for its name, its people and its admin
  // threshold, which start with the person importing it.
  expect(await ada.api.call("exportTemplate", { params: { workspaceId: importedId } })).toEqual({
    ...atelierTemplate,
    name: IMPORT_NAME,
    adminThreshold: 1,
    members: [{ userId: adaId, role: "owner" }],
  });

  // Its log names the template by its digest.
  const cloned = (await auditEvents(importedId)).find(
    (event) => event.action === "workspace.cloned",
  );

  expect(cloned?.detail).toMatchObject({
    source: {
      templateDigest: createHash("sha256").update(canonicalJson(atelierTemplate)).digest("hex"),
    },
  });
});

// --- erasing a person -----------------------------------------------------------------------------

test("erasing a person: refused while a threshold needs their passkey, then a request to stop accepting it, then erased: no passkey, session, device, setting, membership or name left, no sign-in and no approval of a waiting request, and every log still verifies with their id kept", async () => {
  test.setTimeout(420_000);
  const workspaceId = atelier.workspace.id;
  // A payment that waits for a person, whose confirmation page Cyd has open.
  const waiting = await propose(atelier, RECIPIENT, "0.001", "waits while Cyd is erased");
  expect(waiting).toMatchObject({ authorizedBy: "person", status: "pending_approval" });
  const waitingLink = await cyd.confirmationLink(approvalIdOf(waiting));
  const waitingView = await cyd.readConfirmation(waitingLink);
  expect(waitingView.state).toBe("open");

  // The control: what of her the control plane holds, her name and her device included.
  expect(await personRows(cydId)).toMatchObject({
    passkeys: 1,
    devices: 1,
    settings: 1,
    approving: 1,
    memberships: 1,
  });
  expect(Number((await personRows(cydId)).deliveries)).toBeGreaterThan(0);
  expect(
    await query(
      "SELECT display_name, quiet_hours IS NOT NULL AS quiet FROM os.users WHERE id = $1",
      [cydId],
    ),
  ).toEqual([{ display_name: CYD_NAME, quiet: true }]);
  const url = await databaseUrl();
  const named = await scanForMarkers(url, [CYD_NAME, CYD_PUSH_ENDPOINT]);
  expect(named.hits.map((hit) => hit.marker)).toEqual(
    expect.arrayContaining([CYD_NAME, CYD_PUSH_ENDPOINT]),
  );

  // A session signed in long ago may not erase.
  await signedInLongAgo(cydId);
  expect(await apiRefusal(cyd.api.call("eraseMe", { body: {} }))).toEqual({
    code: "forbidden",
    detail: "sign_in_again",
  });
  // The admin threshold of 2 needs her passkey: refused, in the app and by the operator.
  await cyd.signIn();
  expect(await apiRefusal(cyd.api.call("eraseMe", { body: {} }))).toEqual({
    code: "conflict",
    detail: "last_approver",
  });
  expect(await eraseByOperator(cydId)).toMatchObject({
    exitCode: 2,
    result: { ok: false, code: "conflict", detail: "last_approver" },
  });
  expect(await personRows(cydId)).toMatchObject({
    passkeys: 1,
    devices: 1,
    settings: 1,
    approving: 1,
    memberships: 1,
  });

  // People lower it, both approving; the operator's command then names where she still approves.
  const lower = await ada.api.call("requestAdminThreshold", {
    params: { workspaceId },
    body: { adminThreshold: 1 },
  });

  expect(lower).toMatchObject({ kind: "set-admin-threshold", threshold: 2 });
  await ada.confirm(lower.id);
  await cyd.confirm(lower.id);
  expect((await ada.settled(lower.id)).status).toBe("executed");
  expect(await eraseByOperator(cydId)).toEqual({
    exitCode: 3,
    result: { ok: false, code: "still_approving", workspaces: [workspaceId] },
  });

  // The first call opens a request to stop accepting her passkey; asking again shows the same.
  await cyd.signIn();
  const first = await cyd.api.call("eraseMe", { body: {} });
  expect(first.status).toBe("waiting");
  expect(first.approvals.map((item) => [item.workspaceId, item.kind, item.threshold])).toEqual([
    [workspaceId, "remove-approver", 1],
  ]);
  const again = await cyd.api.call("eraseMe", { body: {} });
  expect(again).toMatchObject({ status: "waiting" });
  expect(again.approvals.map((item) => item.id)).toEqual(first.approvals.map((item) => item.id));
  expect((await cyd.api.call("getSession")).user?.id).toBe(cydId);

  // Approved on the confirmation page, the signer drops her passkey and ends the mandate it gave.
  const [removal] = first.approvals;

  if (!removal) throw new Error("erasing opened no removal");
  await ada.confirm(removal.id);
  expect((await ada.settled(removal.id)).status).toBe("executed");
  expect(await getMandate(workspaceId, atelierMandateId)).toMatchObject({
    status: "revoked",
    endedReason: "grantor_removed",
  });
  const decisions = await signerDecisions(workspaceId);
  expect(decisions).toContainEqual(
    expect.objectContaining({
      action: "remove-approver",
      approvalId: removal.id,
      outcome: "allowed",
    }),
  );
  expect(decisions).toContainEqual(
    expect.objectContaining({ action: "revoke-mandate-on-grantor-removal", outcome: "allowed" }),
  );
  expect(
    await signerQuery(
      "SELECT count(*) AS approving FROM approvers WHERE workspace_id = ? AND user_id = ?",
      workspaceId,
      cydId,
    ),
  ).toEqual([{ approving: 0 }]);

  // The second call erases her and signs her out; her passkey signs in nowhere.
  await cyd.signIn();
  expect(await cyd.api.call("eraseMe", { body: {} })).toEqual({ status: "erased", approvals: [] });
  expect(cyd.signedIn).toBe(false);
  expect((await cyd.api.call("getSession")).user).toBeNull();
  expect(await apiRefusal(cyd.signIn())).toMatchObject({ code: "unauthenticated" });
  // The page she kept open takes nothing from her passkey; Ada's still approves it.
  expect(await refusalCode(cyd.approveOnConfirmationPage(waitingLink, waitingView))).toBe(
    "approver_unknown",
  );
  await ada.confirm(approvalIdOf(waiting));
  expect(await intentSettles(waiting.intentId)).toBe("confirmed");

  // Nothing of her is left but her id: no passkey, session, device, setting, membership, pending
  // notification or name, anywhere in the database.
  expect(await personRows(cydId)).toMatchObject({
    sessions: 0,
    passkeys: 0,
    ceremonies: 0,
    devices: 0,
    settings: 0,
    approving: 0,
    memberships: 0,
    pending: 0,
  });
  expect(
    await query(
      "SELECT display_name, quiet_hours, erased_at IS NOT NULL AS erased FROM os.users WHERE id = $1",
      [cydId],
    ),
  ).toEqual([{ display_name: "Erased person", quiet_hours: null, erased: true }]);
  expect((await scanForMarkers(url, [CYD_NAME, CYD_PUSH_ENDPOINT])).hits).toEqual([]);
  expect(
    (await ada.api.call("getWorkspace", { params: { workspaceId } })).members.map(
      (member) => member.user.id,
    ),
  ).not.toContain(cydId);

  // Every log keeps her id and still verifies: the audit log, under the erased name, and the
  // signer's log, which keeps her as the mandate's grantor.
  const events = await auditEvents(workspaceId);
  const byCyd = events.filter((event) => event.actor.id === cydId);
  expect(byCyd.length).toBeGreaterThan(0);
  expect(new Set(byCyd.map((event) => event.actor.name))).toEqual(new Set(["Erased person"]));
  expect(events.filter((event) => event.action === "member.erased")).toEqual([
    expect.objectContaining({
      actor: expect.objectContaining({ type: "user", id: cydId }),
      subject: { type: "user", id: cydId },
    }),
  ]);
  expect(await ada.api.call("verifyAudit", { params: { workspaceId } })).toMatchObject({
    ok: true,
    brokenAt: null,
  });
  expect(await signerAdmin("verify-log", "--workspace", workspaceId)).toMatchObject({ ok: true });
  expect(
    await signerQuery(
      "SELECT user_id FROM mandate_grantors WHERE mandate_id = ?",
      atelierMandateId,
    ),
  ).toEqual([{ user_id: cydId }]);

  // A record exported now verifies, keeps her id and never names her.
  await ada.signIn();
  const { record } = await ada.api.call("exportRecord", { params: { workspaceId } });
  expect(await verifyRecordFile(record)).toEqual({
    exitCode: 0,
    result: { ok: true, brokenAt: null },
  });
  expect(record).toContain(cydId);
  expect(record).not.toContain(CYD_NAME);
  expect(record).not.toContain(CYD_PUSH_ENDPOINT);

  // The template exported while she was a member no longer invites her.
  const afterwards = await ada.api.call("importTemplate", {
    body: {
      template: atelierTemplate,
      name: AFTER_ERASURE_NAME,
      includeAgents: false,
      includeMembers: true,
    },
  });

  expect(afterwards.invites).toEqual([]);

  // Erasing her again changes nothing.
  expect(await eraseByOperator(cydId)).toEqual({
    exitCode: 0,
    result: { ok: true, userId: cydId, alreadyErased: true },
  });
  expect(
    (await auditActions(workspaceId)).filter((action) => action === "member.erased"),
  ).toHaveLength(1);
});

test("the operator erases a person whose passkeys approve nowhere, as the system and once, and changes nothing for the only owner of a workspace", async () => {
  const workspaceId = studio.workspace.id;

  const member = (await ada.api.call("getWorkspace", { params: { workspaceId } })).members.find(
    (candidate) => candidate.user.displayName === bea.name,
  );

  if (!member) throw new Error("Bea is not a member of the studio");
  const beaId = member.user.id;
  expect(member.role).toBe("viewer");
  expect((await bea.api.call("getSession")).user?.id).toBe(beaId);

  expect(await eraseByOperator(beaId)).toEqual({
    exitCode: 0,
    result: { ok: true, userId: beaId, alreadyErased: false },
  });
  expect(await eraseByOperator(beaId)).toEqual({
    exitCode: 0,
    result: { ok: true, userId: beaId, alreadyErased: true },
  });
  expect((await bea.api.call("getSession")).user).toBeNull();
  expect(await apiRefusal(bea.signIn())).toMatchObject({ code: "unauthenticated" });
  expect(await personRows(beaId)).toMatchObject({
    sessions: 0,
    passkeys: 0,
    memberships: 0,
    pending: 0,
  });
  expect(
    (await auditEvents(workspaceId)).filter((event) => event.action === "member.erased"),
  ).toEqual([
    expect.objectContaining({
      actor: expect.objectContaining({ type: "system", id: null }),
      subject: { type: "user", id: beaId },
    }),
  ]);
  expect(await ada.api.call("verifyAudit", { params: { workspaceId } })).toMatchObject({
    ok: true,
  });
  expect(
    (await ada.api.call("getWorkspace", { params: { workspaceId } })).members.map(
      (candidate) => candidate.user.id,
    ),
  ).not.toContain(beaId);

  // Ada is the only owner of her workspaces: the command refuses and nothing of hers changes.
  expect(await eraseByOperator(adaId)).toMatchObject({
    exitCode: 2,
    result: { ok: false, code: "conflict", detail: "last_owner" },
  });
  expect((await ada.api.call("getSession")).user?.id).toBe(adaId);
  expect(await personRows(adaId)).toMatchObject({ passkeys: 1 });
});
