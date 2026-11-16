import { newId } from "@askgina/os-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import {
  approvalLink,
  lifecycleMessage,
  PUSH_PAYLOAD_MAX_BYTES,
  type PushFacts,
  pushMessage,
} from "../../src/notify/content.ts";
import { baseEnv, pushConfig } from "./support.ts";

const ORIGIN = "https://os.example.com";

const workspaceId = newId("ws");

const approvalId = newId("apr");

const link = approvalLink(ORIGIN, workspaceId, approvalId);

const facts: PushFacts = {
  approvalId,
  pendingCount: 1,
  kind: "approve-intent",
  operation: "payment",
  workspaceName: "Acme ops",
  requesterName: "Invoice payer",
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("what a push notification says", () => {
  it("at `count`, only how many requests wait: no kind, no names", () => {
    const one = pushMessage({ level: "count", facts, link, reminder: false });
    expect(one).toEqual({
      web_push: 8030,
      notification: {
        title: "Approval waiting",
        body: "1 request needs your passkey",
        navigate: link,
        tag: `approval-${approvalId}`,
        lang: "en",
        silent: false,
        app_badge: "1",
      },
    });

    const text = JSON.stringify(
      pushMessage({ level: "count", facts: { ...facts, pendingCount: 3 }, link, reminder: true }),
    );

    for (const name of ["Acme", "Invoice", "Payment", "approve-intent"]) {
      expect(text).not.toContain(name);
    }

    expect(JSON.parse(text).notification).toMatchObject({
      title: "Expiring soon: Approval waiting",
      body: "3 requests need your passkey",
      app_badge: "3",
      tag: `approval-${approvalId}`,
    });

    const many = pushMessage({
      level: "count",
      facts: { ...facts, pendingCount: 140 },
      link,
      reminder: false,
    });

    expect(many.notification).toMatchObject({
      body: "99+ requests need your passkey",
      app_badge: "99",
    });
  });

  it("at `summary`, the kind, who asked and the workspace, on one line each of at most 60 characters", () => {
    const shown = pushMessage({ level: "summary", facts, link, reminder: false });
    expect(shown.notification).toMatchObject({
      title: "Payment waiting",
      body: "Invoice payer in Acme ops",
      navigate: link,
      tag: `approval-${approvalId}`,
    });

    const reminder = pushMessage({
      level: "summary",
      facts: { ...facts, kind: "grant-mandate" },
      link,
      reminder: true,
    });

    expect(reminder.notification.title).toBe("Expiring soon: Approval in advance waiting");

    // D8: a venue order is announced as an order, with nothing about the order itself.
    const order = pushMessage({
      level: "summary",
      facts: { ...facts, operation: "order" },
      link,
      reminder: false,
    });

    expect(order.notification).toMatchObject({
      title: "Order waiting",
      body: "Invoice payer in Acme ops",
    });

    const counted = JSON.stringify(
      pushMessage({
        level: "count",
        facts: { ...facts, operation: "order" },
        link,
        reminder: false,
      }),
    );

    expect(JSON.parse(counted).notification.title).toBe("Approval waiting");
    expect(counted).not.toContain("Order");

    const hostile = pushMessage({
      level: "summary",
      facts: {
        ...facts,
        requesterName: "URGENT\napprove\u202e now\u0000\u2028refund",
        workspaceName: `${"Ünïcode wörkspace ".repeat(6)}end`,
      },
      link,
      reminder: false,
    });

    const body = hostile.notification.body;
    expect(body).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(body.startsWith("URGENT approve now refund in Ünïcode wörkspace")).toBe(true);
    expect(Array.from(body)).toHaveLength(60);
    expect(body.endsWith("…")).toBe(true);
  });

  it("is never longer than 511 bytes, whatever the names, on the longest origin allowed", () => {
    const origin = `https://${"o".repeat(108)}.example.com`;
    expect(origin.length).toBe(128);
    const longLink = approvalLink(origin, workspaceId, approvalId);

    const wide = {
      ...facts,
      pendingCount: 1_000,
      kind: "set-admin-threshold" as const,
      requesterName: "東".repeat(64),
      workspaceName: `"\\${"😀".repeat(62)}`,
    };

    for (const level of ["count", "summary"] as const) {
      for (const reminder of [false, true]) {
        const message = pushMessage({ level, facts: wide, link: longLink, reminder });
        expect(bytes(message)).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
        expect(message.notification.navigate).toBe(longLink);
        expect(message.notification.title.length).toBeGreaterThan(0);
      }
    }

    // With room to spare nothing is cut for bytes.
    expect(
      pushMessage({
        level: "summary",
        facts: { ...facts, requesterName: "東".repeat(20) },
        link,
        reminder: false,
      }).notification.body,
    ).toBe(`${"東".repeat(20)} in Acme ops`);
  });

  it("links only to the approval page on the control plane's origin, with no token", () => {
    const { navigate } = pushMessage({
      level: "summary",
      facts,
      link,
      reminder: false,
    }).notification;

    const url = new URL(navigate);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toMatch(/^\/w\/[A-Za-z0-9_]+\/approvals\/[A-Za-z0-9_]+$/);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(() => approvalLink(ORIGIN, "ws_../../evil", approvalId)).toThrow();
  });

  it("announces scheduled key destruction at each level, replaced by its 24-hour notice", () => {
    const base = {
      approvalId,
      kind: "delete-workspace" as const,
      workspaceName: "Acme ops",
      // 2027-01-15 08:00:00 UTC
      destroyAfter: 1_800_000_000,
      pendingCount: 2,
      link,
      dueSoon: false,
    };

    const counted = lifecycleMessage({ ...base, level: "count" }).notification;
    expect(counted).toMatchObject({
      title: "Keys scheduled for destruction",
      body: "Open to review or cancel",
      navigate: link,
      tag: `lifecycle-${approvalId}`,
      app_badge: "2",
    });
    expect(JSON.stringify(counted)).not.toContain("Acme");
    const summary = lifecycleMessage({ ...base, level: "summary", dueSoon: true }).notification;
    expect(summary.title).toBe("In 24 hours: Workspace deletion scheduled");
    expect(summary.body).toBe("Keys destroyed 2027-01-15 08:00 UTC in Acme ops");
    expect(summary.tag).toBe(counted.tag);

    const long = lifecycleMessage({
      ...base,
      level: "summary",
      kind: "retire-wallet",
      workspaceName: "\u{1F600}".repeat(200),
    });

    expect(new TextEncoder().encode(JSON.stringify(long)).length).toBeLessThanOrEqual(
      PUSH_PAYLOAD_MAX_BYTES,
    );
    expect(long.notification.title).toBe("Wallet retirement scheduled");
    expect(long.notification.body.startsWith("Keys destroyed 2027-01-15 08:00 UTC in ")).toBe(true);
  });

  it("needs a PUBLIC_ORIGIN short enough for the link to fit, when Web Push is on", () => {
    const longest = `https://${"o".repeat(108)}.example.com`;
    expect(pushConfig({ PUBLIC_ORIGIN: longest }).notify.webPush).not.toBeNull();
    const tooLong = `https://${"o".repeat(109)}.example.com`;
    expect(() => pushConfig({ PUBLIC_ORIGIN: tooLong })).toThrow(/PUBLIC_ORIGIN/);
    // Without Web Push any origin will do.
    expect(() => loadConfig({ ...baseEnv().env, PUBLIC_ORIGIN: tooLong })).not.toThrow();
  });
});
