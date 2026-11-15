import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MandateDraft } from "@askgina/os-api";
import type { ApprovalId, IntentId, MandateId } from "@askgina/os-protocol";
import type { Client } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { intents, notificationDeliveries } from "../../src/db/schema.ts";
import { deliverDueNotifications } from "../../src/notify/outbox.ts";
import {
  createFixture,
  draftFor,
  type Fixture,
  fund,
  type TestAgent,
  toolJson,
} from "../execution/fixture.ts";
import { TEST_CHAIN_ID, TEST_ORIGIN, type TestPerson } from "../support/context.ts";
import {
  baseEnv,
  expectedSignature,
  markerForms,
  type Received,
  type Receiver,
  startReceiver,
  webhookSecret,
} from "./support.ts";

let f: Fixture;
let bob: TestPerson;
let receiver: Receiver;
const secret = webhookSecret();
const ETH = 10n ** 18n;

beforeAll(async () => {
  receiver = await startReceiver();
  f = await createFixture("notify_webhook");
  bob = await f.addApprover(f.workspaceId, "Bob Approver");
  // From here on the operator has a webhook.
  f.t.ctx.config.notify = { webhook: { url: receiver.url, secret }, webPush: null };
});
afterAll(async () => {
  await f?.close();
  await receiver?.close();
});

const randomAddress = () => `0x${randomBytes(20).toString("hex")}` as `0x${string}`;

async function agentWith(name: string): Promise<{ agent: TestAgent; client: Client }> {
  const agent = await f.newAgent(name);
  await f.setPolicy(f.workspaceId, agent.walletId, draftFor(agent.id));
  await fund(agent.address, 50n * ETH);
  return { agent, client: await f.mcp(agent.token) };
}

async function propose(client: Client, args: Record<string, unknown>) {
  const answer = toolJson(await client.callTool({ name: "propose_transfer", arguments: args }));
  if (typeof answer.intentId !== "string") throw new Error(JSON.stringify(answer));
  const [row] = await f.t.ctx.db
    .select()
    .from(intents)
    .where(eq(intents.id, answer.intentId as IntentId));
  if (!row?.approvalId) throw new Error("an intent without its approval or use");
  return { answer, approvalId: row.approvalId };
}

/** Send what is due and return what the receiver got for `approvalId`. */
async function delivered(approvalId: ApprovalId): Promise<Received[]> {
  await deliverDueNotifications(f.t.ctx);
  return receiver.requests.filter((request) => JSON.parse(request.body).approvalId === approvalId);
}

/** A received request whose signature verifies with the secret, and fails with any byte changed. */
function expectSigned(request: Received) {
  const timestamp = String(request.headers["x-os-timestamp"]);
  expect(timestamp).toBe(String(f.t.clock.now()));
  expect(request.headers["x-os-signature"]).toBe(
    expectedSignature(secret, timestamp, request.body),
  );
  const bytes = Buffer.from(request.body, "utf8");
  for (const index of [0, Math.floor(bytes.length / 2), bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[index] = (changed[index] ?? 0) ^ 0x01;
    expect(request.headers["x-os-signature"]).not.toBe(
      expectedSignature(secret, timestamp, changed.toString("utf8")),
    );
  }
  expect(request.headers["x-os-signature"]).not.toBe(
    expectedSignature(webhookSecret(), timestamp, request.body),
  );
}

/** Neither the body nor any header carries a marker, in any of its forms. */
function expectNoMarkers(request: Received, markers: string[]) {
  const text = `${request.body}\n${JSON.stringify(request.headers)}`.toLowerCase();
  for (const marker of markers) {
    for (const form of markerForms(marker)) expect(text).not.toContain(form.toLowerCase());
  }
}

describe("the signed webhook", () => {
  it("announces a payment proposal with exactly eight identifiers, signed, and none of its amount, recipient or memo", async () => {
    const { client } = await agentWith("Payer");
    const recipient = randomAddress();
    const memo = `memo-marker-${randomBytes(6).toString("hex")}`;
    const { approvalId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.031415926",
      memo,
    });
    const requests = await delivered(approvalId);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (!request) throw new Error("nothing was delivered");
    const body = JSON.parse(request.body);
    const [row] = await f.t.ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.approvalId, approvalId));
    const approval = await f.t.owner.browser.api.call("getApproval", { params: { approvalId } });

    // Keys sorted, compact JSON, nothing else.
    expect(Object.keys(body)).toEqual([
      "approvalId",
      "deliveryId",
      "event",
      "expiresAt",
      "kind",
      "link",
      "v",
      "workspaceId",
    ]);
    expect(request.body).toBe(JSON.stringify(body));
    expect(body).toEqual({
      v: 1,
      deliveryId: row?.id,
      event: "approval.opened",
      approvalId,
      workspaceId: f.workspaceId,
      kind: "approve-intent",
      expiresAt: approval.expiresAt,
      link: `${TEST_ORIGIN}/w/${f.workspaceId}/approvals/${approvalId}`,
    });
    expect(request.headers["x-os-delivery"]).toBe(row?.id);
    expect(request.headers["content-type"]).toBe("application/json");
    expectSigned(request);
    expectNoMarkers(request, [
      memo,
      recipient,
      recipient.slice(2),
      "0.031415926",
      "31415926000000000",
      "Payer",
    ]);
  });

  it("announces a mandate's grant like any approval, reports each use as mandate.used, and never announces a use to people", async () => {
    const { agent, client } = await agentWith("Supplier payer");
    const recipient = randomAddress();
    const purpose = `purpose-marker-${randomBytes(6).toString("hex")}`;
    const draft: MandateDraft = {
      agentId: agent.id,
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
      recipients: [recipient],
      maxUses: 5,
      maxFeePerActionWei: "100000000000000000",
      notAfter: f.t.clock.now() + 3 * 86_400,
      purpose,
    };
    const grant = await f.t.owner.browser.api.call("proposeMandate", {
      params: { workspaceId: f.workspaceId, walletId: agent.walletId },
      body: draft,
    });
    const grantRequests = await delivered(grant.id as ApprovalId);
    expect(grantRequests).toHaveLength(1);
    expect(JSON.parse(grantRequests[0]?.body ?? "{}")).toMatchObject({
      event: "approval.opened",
      kind: "grant-mandate",
      link: `${TEST_ORIGIN}/w/${f.workspaceId}/approvals/${grant.id}`,
    });
    const granted = await f.t.approve(grant.id as ApprovalId, [bob]);
    expect(granted.status).toBe("executed");
    const mandateId = granted.subjectId as MandateId;

    const memo = `use-marker-${randomBytes(6).toString("hex")}`;
    const { answer, approvalId: useId } = await propose(client, {
      chainId: TEST_CHAIN_ID,
      to: recipient,
      amount: "0.5",
      memo,
    });
    expect(answer).toMatchObject({ mandateId, approvalUrl: null });
    // The use's only row is the webhook's `mandate.used`: nobody is asked to approve it.
    const rows = await f.t.ctx.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.approvalId, useId));
    expect(rows.map((row) => [row.event, row.target, row.userId])).toEqual([
      ["mandate.used", "webhook", null],
    ]);
    expect(
      await f.t.ctx.db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.approvalId, useId),
            eq(notificationDeliveries.event, "approval.opened"),
          ),
        ),
    ).toEqual([]);

    const useRequests = await delivered(useId);
    expect(useRequests).toHaveLength(1);
    const [request] = useRequests;
    if (!request) throw new Error("the use was not reported");
    const body = JSON.parse(request.body);
    expect(Object.keys(body)).toEqual([
      "approvalId",
      "deliveryId",
      "event",
      "link",
      "mandateId",
      "v",
      "workspaceId",
    ]);
    expect(body).toEqual({
      v: 1,
      deliveryId: rows[0]?.id,
      event: "mandate.used",
      approvalId: useId,
      workspaceId: f.workspaceId,
      mandateId,
      link: `${TEST_ORIGIN}/w/${f.workspaceId}/mandates/${mandateId}`,
    });
    expectSigned(request);
    for (const sent of [request, ...grantRequests]) {
      expectNoMarkers(sent, [memo, purpose, recipient, recipient.slice(2), "500000000000000000"]);
    }
  });
});

describe("webhook settings", () => {
  it("need a secret file of at least 32 characters with a URL, and treat an empty URL as unset", () => {
    const { env, dir } = baseEnv();
    const url = "https://hooks.example.com/os";
    expect(() => loadConfig({ ...env, NOTIFY_WEBHOOK_URL: url })).toThrow(
      /NOTIFY_WEBHOOK_SECRET_FILE/,
    );
    const short = join(dir, "short-secret");
    writeFileSync(short, "too short\n");
    expect(() =>
      loadConfig({ ...env, NOTIFY_WEBHOOK_URL: url, NOTIFY_WEBHOOK_SECRET_FILE: short }),
    ).toThrow(/at least 32/);
    const good = join(dir, "notify-webhook-secret");
    const text = randomBytes(32).toString("base64url");
    writeFileSync(good, `${text}\n`);
    expect(
      loadConfig({ ...env, NOTIFY_WEBHOOK_URL: url, NOTIFY_WEBHOOK_SECRET_FILE: good }).notify
        .webhook,
    ).toEqual({ url, secret: new Uint8Array(Buffer.from(text, "utf8")) });
    // Compose passes unset variables as "".
    expect(
      loadConfig({ ...env, NOTIFY_WEBHOOK_URL: "", NOTIFY_WEBHOOK_SECRET_FILE: "" }).notify.webhook,
    ).toBeNull();
    expect(() =>
      loadConfig({
        ...env,
        NOTIFY_WEBHOOK_URL: "ftp://hooks.example.com/os",
        NOTIFY_WEBHOOK_SECRET_FILE: good,
      }),
    ).toThrow(/NOTIFY_WEBHOOK_URL/);
  });
});
