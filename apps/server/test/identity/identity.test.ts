import { ApiError, ApiErrorBody, routes } from "@askgina/os-api";
import type { AssertionResponse } from "@askgina/os-protocol";
import { createTestDatabase } from "@askgina/os-testkit";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main as cli } from "../../src/cli.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import * as schema from "../../src/db/schema.ts";
import { credentials, installation, sessions } from "../../src/db/schema.ts";
import { checkSetupToken, prepareSetup } from "../../src/identity/setup.ts";
import { createTestContext, TEST_ORIGIN, type TestContext } from "../support/context.ts";

let t: TestContext;

beforeAll(async () => {
  t = await createTestContext({ label: "identity" });
});
afterAll(async () => {
  await t?.close();
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ApiError)) throw new Error("expected the API to refuse");
  return error.code;
}

describe("first-run setup", () => {
  it("refuses a wrong token, takes the right one once, and never logs or stores it", async () => {
    let seen: { required: boolean; code: string } | undefined;
    let issued = "";
    const fresh = await createTestContext({
      label: "identity_fresh",
      beforeOwner: async ({ token, browser }) => {
        issued = token;
        const wrong = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
        seen = {
          required: (await browser.api.call("getSession")).setupRequired,
          code: await refusal(
            browser.api.call("startSetup", { body: { setupToken: wrong, displayName: "Mallory" } }),
          ),
        };
      },
    });
    try {
      expect(seen).toEqual({ required: true, code: "forbidden" });
      expect(issued).toHaveLength(32);
      // The owner exists now: the token that made them is refused, and its hash is gone.
      const again = fresh.browser().api.call("startSetup", {
        body: { setupToken: issued, displayName: "Mallory" },
      });
      expect(await refusal(again)).toBe("forbidden");
      expect(await fresh.ctx.db.select().from(installation)).toEqual([]);
      expect(fresh.log.lines.join("\n")).not.toContain(issued);
    } finally {
      await fresh.close();
    }
  });

  it("no boot mints or logs a setup token; of two commands at once, the later token works", async () => {
    const database = await createTestDatabase("identity_boots");
    const pools = [0, 1].map(() => new pg.Pool({ connectionString: database.url, max: 2 }));
    try {
      await migrateDatabase(pools[0] as pg.Pool);
      const lines: string[] = [];
      const log = {
        info: (message: string, fields: object = {}) =>
          lines.push(JSON.stringify({ message, ...fields })),
        warn: () => {},
        error: () => {},
      };
      // Two replicas on one fresh database, each its own process with its own pool.
      const replicas = pools.map((pool) => ({
        db: drizzle(pool, { schema }),
        log,
        config: t.ctx.config,
      }));
      await Promise.all(replicas.map((replica) => prepareSetup(replica)));
      const [first] = replicas;
      if (!first) throw new Error("no replica");
      // Each boot says only that setup waits; nothing is stored until the operator asks.
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).toContain('"setup.token_pending"');
      expect(await first.db.select().from(installation)).toEqual([]);

      // The operator's command, run against both replicas at once: each prints a token on
      // stdout, and exactly one of them, the later, is the installation's token.
      const printed: { ok?: boolean; setupToken?: string }[] = [];
      const exits = await Promise.all(
        replicas.map((replica) => cli(["setup-token"], replica, (line) => printed.push(line))),
      );
      expect(exits).toEqual([0, 0]);
      const tokens = printed.map((line) => line.setupToken ?? "");
      expect(new Set(tokens).size).toBe(2);
      const valid = await Promise.all(tokens.map((token) => checkSetupToken(first, token)));
      expect(valid.filter(Boolean)).toHaveLength(1);

      // A restart keeps the token an operator may be typing, and no line carries either token.
      await prepareSetup(first);
      expect(await Promise.all(tokens.map((token) => checkSetupToken(first, token)))).toEqual(
        valid,
      );
      for (const token of tokens) expect(lines.join("\n")).not.toContain(token);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await database.drop();
    }
  });

  it("the setup-token command refuses once the first owner exists", async () => {
    const printed: object[] = [];
    expect(await cli(["setup-token"], t.ctx, (line) => printed.push(line))).toBe(3);
    expect(printed).toEqual([{ ok: false, code: "setup_done" }]);
    expect(await t.ctx.db.select().from(installation)).toEqual([]);
  });

  it("reports who is signed in", async () => {
    const info = await t.owner.browser.api.call("getSession");
    expect(info.setupRequired).toBe(false);
    expect(info.user?.id).toBe(t.owner.userId);
    const anonymous = await t.browser().api.call("getSession");
    expect(anonymous.user).toBeNull();
  });
});

describe("sessions", () => {
  it("stores only the SHA-256 of the cookie, which is httpOnly and SameSite=Strict", async () => {
    const browser = t.browser();
    const { ceremonyId, options } = await browser.api.call("startLogin", { body: {} });
    const response = t.authenticator.authenticate({
      credentialId: t.owner.credentialId,
      challenge: options.challenge as string,
      origin: TEST_ORIGIN,
    });
    const raw = await browser.fetch(routes.finishLogin.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ceremonyId, response }),
    });
    const cookie = raw.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const value = browser.cookie().split("=")[1] ?? "";
    const rows = await t.ctx.db.select({ idHash: sessions.idHash }).from(sessions);
    expect(rows.some((row) => row.idHash === value)).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("signing out revokes the session, and the old cookie stops working", async () => {
    const browser = await t.signIn(t.owner.credentialId);
    const stolen = browser.cookie();
    await browser.api.call("logout", { body: {} });
    expect((await browser.api.call("getSession")).user).toBeNull();
    const replay = await t
      .browser()
      .fetch(routes.listPasskeys.path, { headers: { cookie: stolen } });
    expect(replay.status).toBe(401);
  });

  it("expires after the configured lifetime", async () => {
    const browser = await t.signIn(t.owner.credentialId);
    await browser.api.call("listPasskeys");
    t.clock.advance(t.ctx.config.sessionTtlSeconds + 1);
    expect(await refusal(browser.api.call("listPasskeys"))).toBe("unauthenticated");
    // The owner's harness session is just as expired; sign it in again for later tests.
    await t.signIn(t.owner.credentialId, t.owner.browser);
  });

  it("a sign-in ceremony is single use and expires after five minutes", async () => {
    const browser = t.browser();
    const first = await browser.api.call("startLogin", { body: {} });
    const response = t.authenticator.authenticate({
      credentialId: t.owner.credentialId,
      challenge: first.options.challenge as string,
      origin: TEST_ORIGIN,
    }) as AssertionResponse;
    await browser.api.call("finishLogin", { body: { ceremonyId: first.ceremonyId, response } });
    expect(
      await refusal(
        t.browser().api.call("finishLogin", { body: { ceremonyId: first.ceremonyId, response } }),
      ),
    ).toBe("not_found");

    const late = await browser.api.call("startLogin", { body: {} });
    t.clock.advance(301);
    const lateResponse = t.authenticator.authenticate({
      credentialId: t.owner.credentialId,
      challenge: late.options.challenge as string,
      origin: TEST_ORIGIN,
    }) as AssertionResponse;
    expect(
      await refusal(
        browser.api.call("finishLogin", {
          body: { ceremonyId: late.ceremonyId, response: lateResponse },
        }),
      ),
    ).toBe("not_found");
  });

  it("refuses an assertion signed for another origin", async () => {
    const browser = t.browser();
    const start = await browser.api.call("startLogin", { body: {} });
    const response = t.authenticator.authenticate({
      credentialId: t.owner.credentialId,
      challenge: start.options.challenge as string,
      origin: "https://evil.example",
    }) as AssertionResponse;
    expect(
      await refusal(
        browser.api.call("finishLogin", { body: { ceremonyId: start.ceremonyId, response } }),
      ),
    ).toBe("unauthenticated");
  });
});

describe("passkeys", () => {
  it("adds a passkey, and removing it stops its sign-in at once", async () => {
    const api = t.owner.browser.api;
    const start = await api.call("startAddPasskey", { body: {} });
    const added = t.register(start.options);
    const result = await api.call("finishAddPasskey", {
      body: { ceremonyId: start.ceremonyId, response: added.response as never, label: "Laptop" },
    });
    expect(result.passkey.label).toBe("Laptop");
    // The owner approves nowhere yet, so nothing needs approving.
    expect(result.approvals).toEqual([]);

    const second = await t.signIn(added.credentialId);
    await second.api.call("listPasskeys");
    await api.call("removePasskey", { params: { credentialId: added.credentialId } });
    expect(await refusal(second.api.call("listPasskeys"))).toBe("unauthenticated");
    expect(await refusal(t.signIn(added.credentialId))).toBe("unauthenticated");
    const [row] = await t.ctx.db
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, added.credentialId));
    expect(row?.revokedAt).not.toBeNull();
  });

  it("refuses to remove someone's last passkey", async () => {
    const code = await refusal(
      t.owner.browser.api.call("removePasskey", {
        params: { credentialId: t.owner.credentialId },
      }),
    );
    expect(code).toBe("conflict");
  });

  it("will not remove the only active approver passkey, and ends a removed approver passkey's sign-in only once the signer drops it", async () => {
    const api = t.owner.browser.api;
    const workspace = await api.call("createWorkspace", { body: { name: "Keys" } });
    const start = await api.call("startAddPasskey", { body: {} });
    const phone = t.register(start.options);
    const added = await api.call("finishAddPasskey", {
      body: { ceremonyId: start.ceremonyId, response: phone.response as never, label: "Phone" },
    });
    expect(added.approvals).toHaveLength(1);

    // The new passkey only waits to approve: removing the old one now would leave nobody able
    // to approve anything in this workspace, the new passkey included.
    expect(
      await refusal(api.call("removePasskey", { params: { credentialId: t.owner.credentialId } })),
    ).toBe("conflict");

    expect((await t.approve(added.approvals[0]?.id as never, [t.owner])).status).toBe("executed");
    const removal = await api.call("removePasskey", {
      params: { credentialId: t.owner.credentialId },
    });
    expect(removal.approvals).toHaveLength(1);
    // The signer still accepts it, so it still signs in: it may be needed to approve.
    await t.signIn(t.owner.credentialId);

    const viaPhone = { ...t.owner, credentialId: phone.credentialId };
    expect((await t.approve(removal.approvals[0]?.id as never, [viaPhone])).status).toBe(
      "executed",
    );
    expect(await refusal(t.signIn(t.owner.credentialId))).toBe("unauthenticated");
    const atSigner = await t.ctx.signer.getWorkspace(workspace.id);
    expect(atSigner.approvers.map((a) => a.credentialId)).toEqual([phone.credentialId]);
    // Later tests use the owner's browser; its session ended with the old passkey.
    await t.signIn(phone.credentialId, t.owner.browser);
  });
});

describe("origin check", () => {
  // Approvals, intents, sweeps, mandates and the lifecycle are the execution module's and are not
  // on this test app; the execution and lifecycle tests check them.
  const elsewhere = new Set([
    "collectApproval",
    "reject",
    "requestSweep",
    "proposeMandate",
    "revokeMandate",
    "speedUp",
    "requestCancel",
    "requestSweepCancel",
    "cancelOrder",
    "requestDeleteWorkspace",
    "cancelDeleteWorkspace",
    "cloneWorkspace",
    "importTemplate",
    "requestRetireWallet",
    "cancelRetireWallet",
  ]);
  const writes = Object.entries(routes).filter(
    ([name, route]) => route.method !== "GET" && !elsewhere.has(name),
  );

  it.each(writes)("%s refuses a write without a same-site Origin", async (_name, route) => {
    const path = route.path.replace(/:[A-Za-z]+/g, "x");
    const init = {
      method: route.method,
      headers: { "content-type": "application/json" },
      ...(route.method === "DELETE" ? {} : { body: "{}" }),
    };
    const missing = await t.owner.browser.fetch(path, { ...init, origin: null });
    const foreign = await t.owner.browser.fetch(path, { ...init, origin: "https://evil.example" });
    for (const response of [missing, foreign]) {
      expect(response.status).toBe(403);
      expect(ApiErrorBody.parse(await response.json()).error.code).toBe("forbidden");
    }
  });
});
