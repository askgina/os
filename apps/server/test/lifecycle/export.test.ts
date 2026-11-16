import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type MandateDraft } from "@askgina/os-api";
import type { ApprovalId, IntentId, MandateId, PushSubscriptionId } from "@askgina/os-protocol";
import type { Client } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intents, pushSubscriptions, transactions } from "../../src/db/schema.ts";
import { engineOf } from "../../src/execution/approvals.ts";
import { RECENT_SIGN_IN_MAX_AGE_SECONDS } from "../../src/identity/sessions.ts";
import {
  main,
  RECORD_FORMAT,
  RecordEnd,
  RecordHeader,
  RecordLine,
  recordLines,
  verifyRecord,
} from "../../src/lifecycle/verify-record.ts";
import { createFixture, type Fixture, toolJson } from "../execution/fixture.ts";
import { TEST_CHAIN_ID } from "../support/context.ts";

const ETH = 10n ** 18n;

const SUPPLIER = "0x00000000000000000000000000000000000000aa";

const PLUMBER = "0x00000000000000000000000000000000000000bb";

const PUSH_ENDPOINT = "https://push.example.test/send/endpoint-only-the-browser-knows";

let f: Fixture;

let client: Client;

let personPayment: ApprovalId;

let mandatePayment: ApprovalId;

let mandateId: MandateId;

const api = () => f.t.owner.browser.api;

async function propose(args: Record<string, unknown>): Promise<ApprovalId> {
  const answer = toolJson(await client.callTool({ name: "propose_transfer", arguments: args }));

  if (typeof answer.intentId !== "string") throw new Error(JSON.stringify(answer));

  const [row] = await f.t.ctx.db
    .select({ approvalId: intents.approvalId })
    .from(intents)
    .where(eq(intents.id, answer.intentId as IntentId));

  if (!row?.approvalId) throw new Error("an intent without its approval or use");

  return row.approvalId;
}

/** Follow a signed payment to its block, as the workflow does. */
async function followUp(approvalId: ApprovalId): Promise<void> {
  const steps = engineOf(f.t.ctx).steps();

  for (let i = 0; i < 20; i += 1) if ((await steps.followUp(approvalId)).done) return;
  throw new Error("follow-up never finished");
}

async function exportRecord(): Promise<string[]> {
  const { record } = await api().call("exportRecord", { params: { workspaceId: f.workspaceId } });

  return recordLines(record);
}

beforeAll(async () => {
  f = await createFixture("lifecycle_export");
  client = await f.mcp(f.agent.token);

  // A payment people approve.
  personPayment = await propose({
    chainId: TEST_CHAIN_ID,
    to: PLUMBER,
    amount: "0.01",
    memo: "invoice 7 for the plumber",
  });
  expect((await f.t.approve(personPayment, [f.t.owner])).status).toBe("executed");
  await followUp(personPayment);

  // A mandate, and one payment under it.
  const draft: MandateDraft = {
    agentId: f.agent.id,
    assets: [
      {
        chainId: TEST_CHAIN_ID as MandateDraft["assets"][number]["chainId"],
        asset: "native",
        maxPerAction: ETH.toString(),
        maxPerWindow: (2n * ETH).toString(),
        maxTotal: (3n * ETH).toString(),
      },
    ],
    windowSeconds: 86_400,
    recipients: [SUPPLIER],
    maxUses: 5,
    maxFeePerActionWei: "100000000000000000",
    notAfter: f.t.clock.now() + 3 * 86_400,
    purpose: "pay the suppliers this week",
  };

  const opened = await api().call("proposeMandate", {
    params: { workspaceId: f.workspaceId, walletId: f.agent.walletId },
    body: draft,
  });

  const granted = await f.t.approve(opened.id as ApprovalId, [f.t.owner]);
  expect(granted.status).toBe("executed");
  mandateId = granted.subjectId as MandateId;
  mandatePayment = await propose({
    chainId: TEST_CHAIN_ID,
    to: SUPPLIER,
    amount: "0.5",
    memo: "supplier run",
  });
  const steps = engineOf(f.t.ctx).steps();
  expect((await steps.execute(mandatePayment)).ok).toBe(true);
  await followUp(mandatePayment);

  // A browser's push endpoint, which belongs to a person and never to a record.
  await f.t.ctx.db.insert(pushSubscriptions).values({
    id: "psb_01jd0000000000000000000099" as PushSubscriptionId,
    userId: f.t.owner.userId,
    endpoint: PUSH_ENDPOINT,
    p256dh:
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  });
}, 120_000);

afterAll(async () => {
  await f?.close();
});

describe("exporting a workspace's record", () => {
  it("verifies offline and carries the audit log, intents, transactions, policies, mandates and their uses", async () => {
    const lines = await exportRecord();
    expect(verifyRecord(lines)).toEqual({ ok: true, brokenAt: null });

    const header = RecordHeader.parse(JSON.parse(lines[0] ?? ""));
    expect(header).toMatchObject({ format: RECORD_FORMAT, workspaceId: f.workspaceId });
    const body = lines.slice(1, -1).map((line) => RecordLine.parse(JSON.parse(line)));
    const end = RecordEnd.parse(JSON.parse(lines.at(-1) ?? ""));
    expect(end.counts).toMatchObject({
      intent: 2,
      transaction: 2,
      "policy-revision": 1,
      mandate: 1,
      "mandate-use": 1,
    });
    expect(end.counts["signer-decision"]).toBeGreaterThan(0);

    // The export records itself, and the record's head is that entry.
    const audit = body.filter((line) => line.type === "audit");
    expect(audit.at(-1)).toMatchObject({ action: "workspace.exported", seq: header.auditHead.seq });
    // Opened: what was sealed is readable in the record.
    const intent = body.find((line) => line.type === "intent" && line.approvalId === personPayment);
    expect(JSON.stringify(intent)).toContain("invoice 7 for the plumber");
    const mandate = body.find((line) => line.type === "mandate");
    expect(mandate).toMatchObject({
      mandateId,
      mandate: { purpose: "pay the suppliers this week" },
      mirror: { status: "active" },
      signer: { status: "active", usage: { uses: 1 } },
    });
    expect(body.find((line) => line.type === "mandate-use")).toMatchObject({
      approvalId: mandatePayment,
      mandateId,
    });
    expect(
      body.filter((line) => line.type === "transaction").map((line) => line.approvalId),
    ).toEqual([personPayment, mandatePayment].sort());
  });

  it("fails verification when one byte of an audit detail changes, the last line goes, or two lines swap", async () => {
    const lines = await exportRecord();
    const index = lines.findIndex((line) => line.includes('"action":"agent.created"'));
    expect(index).toBeGreaterThan(0);
    const edited = [...lines];
    edited[index] = (lines[index] ?? "").replace('"name":"Trader"', '"name":"Tradeq"');
    expect(edited[index]).not.toBe(lines[index]);
    expect(verifyRecord(edited)).toEqual({ ok: false, brokenAt: index + 1 });

    const cut = lines.slice(0, -1);
    expect(verifyRecord(cut)).toEqual({ ok: false, brokenAt: lines.length });

    // The newest audit entry gone: the chain still links, but the header's head is missing.
    const lastAudit = lines.findLastIndex((line) => line.includes('"type":"audit"'));
    const withoutHead = lines.filter((_, at) => at !== lastAudit);
    expect(verifyRecord(withoutHead).ok).toBe(false);

    const intentAt = lines.findIndex((line) => line.includes('"type":"intent"'));
    expect(lines[intentAt + 1]).toContain('"type":"intent"');
    const swapped = [...lines];
    swapped[intentAt] = lines[intentAt + 1] ?? "";
    swapped[intentAt + 1] = lines[intentAt] ?? "";
    expect(verifyRecord(swapped)).toEqual({ ok: false, brokenAt: intentAt + 2 });

    const decisionAt = lines.findIndex((line) => line.includes('"type":"signer-decision"'));
    const swappedDecisions = [...lines];
    swappedDecisions[decisionAt] = lines[decisionAt + 1] ?? "";
    swappedDecisions[decisionAt + 1] = lines[decisionAt] ?? "";
    expect(verifyRecord(swappedDecisions).ok).toBe(false);

    // The command line agrees: 0 when valid, 2 when not.
    const dir = mkdtempSync(join(tmpdir(), "os-record-"));
    writeFileSync(join(dir, "good.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(join(dir, "bad.jsonl"), `${edited.join("\n")}\n`);
    expect(main([join(dir, "good.jsonl")])).toBe(0);
    expect(main([join(dir, "bad.jsonl")])).toBe(2);
  });

  it("holds no agent token, session, sealed value, confirmation link, push endpoint or signed transaction", async () => {
    const pending = await propose({
      chainId: TEST_CHAIN_ID,
      to: PLUMBER,
      amount: "0.02",
      memo: "still waiting",
    });

    const { confirmUrl } = await api().call("getApproval", { params: { approvalId: pending } });
    const record = (await exportRecord()).join("\n");

    expect(record).not.toContain(f.agent.token);
    expect(record).not.toContain("osa_");
    const cookie = f.t.owner.browser.cookie();
    const sessionValue = cookie.slice(cookie.indexOf("=") + 1).split(";")[0] ?? "";
    expect(sessionValue.length).toBeGreaterThan(16);
    expect(record).not.toContain(sessionValue);
    expect(confirmUrl).not.toBeNull();
    // `/a/<approval id>#<token>`: the id is history, the token opens the page.
    const confirmToken = new URL(confirmUrl ?? "").hash.slice(1);
    expect(confirmToken.length).toBeGreaterThan(16);
    expect(record).not.toContain(confirmToken);
    expect(record).not.toContain(PUSH_ENDPOINT);
    expect(record).not.toContain('"type":"Buffer"');

    const [row] = await f.t.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.approvalId, personPayment));

    if (!row) throw new Error("no transaction");

    const raw = (await f.t.ctx.sealer.open(
      f.workspaceId,
      `transactions.raw:${row.approvalId}`,
      row.raw,
    )) as string;

    expect(raw.startsWith("0x")).toBe(true);
    expect(record).not.toContain(raw.slice(2));
    expect(record).not.toContain(row.raw.toString("base64"));
    expect(record).not.toContain(row.raw.toString("hex"));
  });

  it("needs an owner whose passkey signed in within the last five minutes", async () => {
    f.t.clock.advance(RECENT_SIGN_IN_MAX_AGE_SECONDS + 1);

    const refused = await api()
      .call("exportRecord", { params: { workspaceId: f.workspaceId } })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: "forbidden", detail: "sign_in_again" });

    await f.t.signIn(f.t.owner.credentialId, f.t.owner.browser);
    expect(verifyRecord(await exportRecord()).ok).toBe(true);

    const viewer = await f.addApprover(f.workspaceId, "Vera Approver");

    const notOwner = await viewer.browser.api
      .call("exportRecord", { params: { workspaceId: f.workspaceId } })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(notOwner).toMatchObject({ code: "forbidden" });
  });
});
