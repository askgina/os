import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import type { AppContext } from "../../src/context.ts";
import * as schema from "../../src/db/schema.ts";
import { rateLimits } from "../../src/db/schema.ts";
import { finalizeIfDue } from "../../src/lifecycle/finalize.ts";
import { FAILED_AUTH_PER_MINUTE, mountMcp } from "../../src/mcp/gateway.ts";
import { chargeTokens, takeToken, takeTokens } from "../../src/rate-limit.ts";
import { createTestContext, TEST_ORIGIN, type TestContext } from "./context.ts";

const REQUESTS_PER_MINUTE = 120;

let t: TestContext;

const pools: pg.Pool[] = [];

let token: string;

let agentId: string;

/**
 * Another server process on the same database: its own pool and its own MCP gateway, with
 * nothing shared in memory with the test context's.
 */
function replica(config: Partial<Config> = {}) {
  const pool = new pg.Pool({ connectionString: t.ctx.config.databaseUrl, max: 4 });
  pools.push(pool);

  const ctx: AppContext = {
    ...t.ctx,
    config: { ...t.ctx.config, ...config },
    pool,
    db: drizzle(pool, { schema }),
  };

  const app = new Hono();
  mountMcp(app, ctx);

  return { ctx, app };
}

const call = (app: Hono, bearer: string, forwardedFor?: string) => {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${bearer}`,
  });

  if (forwardedFor !== undefined) headers.set("x-forwarded-for", forwardedFor);

  return app.fetch(
    new Request(`${TEST_ORIGIN}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
};

const wrongToken = `osa_${"x".repeat(40)}`;

/**
 * The bucket's clock stands still from now on: its refill counts from `at`, which no take moves
 * back. So a count over many requests is exact however long they take.
 */
async function freeze(bucket: string): Promise<void> {
  await t.ctx.db
    .update(rateLimits)
    .set({ at: sql`now() + interval '1 hour'` })
    .where(eq(rateLimits.bucket, bucket));
}

beforeAll(async () => {
  t = await createTestContext({ label: "rate_limit" });
  const api = t.owner.browser.api;
  const workspace = await api.call("createWorkspace", { body: { name: "Limits" } });

  const created = await api.call("createAgent", {
    params: { workspaceId: workspace.id },
    body: { name: "Busy" },
  });

  token = created.token;
  agentId = created.agent.id;
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await t?.close();
});

describe("limits every replica shares", () => {
  it("one agent's 120 requests a minute are counted across two replicas: the 121st gets 429 from either", async () => {
    const [a, b] = [replica(), replica()];
    expect((await call(a.app, token)).status).toBe(200);
    await freeze(`agent:${agentId}`);

    for (let i = 1; i < REQUESTS_PER_MINUTE; i += 1) {
      const response = await call(i % 2 === 0 ? a.app : b.app, token);
      expect(response.status, `request ${i + 1}`).toBe(200);
    }

    for (const app of [a.app, b.app]) {
      const over = await call(app, token);
      expect(over.status).toBe(429);
      expect(await over.json()).toMatchObject({ error: { code: "rate_limited" } });
    }
  });

  it("failed authentications from one client are counted across two replicas, before any lookup", async () => {
    const [a, b] = [replica(), replica()];
    // The agent's own bucket was emptied above; this test is about the client's.
    await t.ctx.db.delete(rateLimits);
    const client = "192.0.2.44";
    expect((await call(a.app, wrongToken, client)).status).toBe(401);
    await freeze(`auth-fail:${client}`);

    for (let i = 1; i < FAILED_AUTH_PER_MINUTE; i += 1) {
      expect((await call(i % 2 === 0 ? a.app : b.app, wrongToken, client)).status).toBe(401);
    }

    // Even a valid token is refused from that client now, on both replicas.
    expect((await call(a.app, token, client)).status).toBe(429);
    expect((await call(b.app, token, client)).status).toBe(429);
    expect((await call(b.app, token, "192.0.2.45")).status).toBe(200);
  });

  it("charges the address FORWARDED_HOPS entries from the end of X-Forwarded-For", async () => {
    const charged = async (hops: number, forwardedFor: string) => {
      const { app } = replica({ forwardedHops: hops });
      await t.ctx.db.delete(rateLimits).where(sql`${rateLimits.bucket} LIKE 'auth-fail:%'`);
      expect((await call(app, wrongToken, forwardedFor)).status).toBe(401);

      const rows = await t.ctx.db
        .select({ bucket: rateLimits.bucket })
        .from(rateLimits)
        .where(sql`${rateLimits.bucket} LIKE 'auth-fail:%'`);

      return rows.map((row) => row.bucket);
    };

    // Behind a load balancer and the bundled proxy: the balancer appended the client.
    expect(await charged(2, "203.0.113.9, 198.51.100.7, 10.0.0.2")).toEqual([
      "auth-fail:198.51.100.7",
    ]);
    // Behind the bundled proxy alone, as before: the last entry.
    expect(await charged(1, "203.0.113.9, 198.51.100.7, 10.0.0.2")).toEqual(["auth-fail:10.0.0.2"]);
    // Fewer entries than hops: the balancer was bypassed, and the peer is the first entry.
    expect(await charged(2, "10.0.0.3")).toEqual(["auth-fail:10.0.0.3"]);
  });

  it("concurrent takes from many connections never hand out more than the bucket holds", async () => {
    const { ctx } = replica();

    const takes = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        takeToken(i % 2 === 0 ? ctx.db : t.ctx.db, "test:burst", 1, 10),
      ),
    );

    expect(takes.filter(Boolean)).toHaveLength(10);
  });

  it("retirements and deletions are finished at most once a minute across replicas", async () => {
    const [a, b] = [replica(), replica()];
    await t.ctx.db.delete(rateLimits).where(eq(rateLimits.bucket, "sweep:lifecycle-finalize"));
    expect(await finalizeIfDue(a.ctx)).toEqual({ finalized: 0, skipped: 0 });
    expect(await finalizeIfDue(b.ctx)).toBeNull();
    expect(await finalizeIfDue(a.ctx)).toBeNull();
  });
});

describe("weighted takes and charges", () => {
  /** What the bucket holds as stored, before any refill. */
  const stored = async (bucket: string) => {
    const [row] = await t.ctx.db
      .select({ tokens: rateLimits.tokens })
      .from(rateLimits)
      .where(eq(rateLimits.bucket, bucket));

    return row?.tokens;
  };

  /** The bucket's refill restarts `seconds` ago, from what it holds. */
  const elapsed = async (bucket: string, seconds: number) => {
    await t.ctx.db
      .update(rateLimits)
      .set({ at: sql`now() - make_interval(secs => ${seconds})` })
      .where(eq(rateLimits.bucket, bucket));
  };

  it("takes a cost only when the bucket holds all of it, and otherwise changes nothing", async () => {
    expect(await takeTokens(t.ctx.db, "test:weighted", 60, 60, 41)).toBe(true);
    await freeze("test:weighted");
    expect(await stored("test:weighted")).toBe(19);
    expect(await takeTokens(t.ctx.db, "test:weighted", 60, 60, 20)).toBe(false);
    expect(await stored("test:weighted")).toBe(19);
    expect(await takeTokens(t.ctx.db, "test:weighted", 60, 60, 19)).toBe(true);
    expect(await stored("test:weighted")).toBe(0);
    // A cost above the burst is never taken, and a refused take creates no bucket.
    expect(await takeTokens(t.ctx.db, "test:too-heavy", 60, 10, 11)).toBe(false);
    expect(await stored("test:too-heavy")).toBeUndefined();
  });

  it("a charge may take a bucket below zero, and no take succeeds until the refill paid it back", async () => {
    expect(await takeTokens(t.ctx.db, "test:charged", 60, 60, 60)).toBe(true);
    await freeze("test:charged");
    await chargeTokens(t.ctx.db, "test:charged", 60, 60, 30);
    expect(await stored("test:charged")).toBe(-30);
    expect(await takeTokens(t.ctx.db, "test:charged", 60, 60, 1)).toBe(false);
    // At one token a second, 30 seconds bring it back to zero, 31 to one token.
    await elapsed("test:charged", 30);
    expect(await takeTokens(t.ctx.db, "test:charged", 60, 60, 1)).toBe(false);
    await elapsed("test:charged", 31);
    expect(await takeTokens(t.ctx.db, "test:charged", 60, 60, 1)).toBe(true);
    // A charge to a bucket nobody used yet starts it from the burst.
    await chargeTokens(t.ctx.db, "test:charged-new", 60, 60, 25);
    expect(await stored("test:charged-new")).toBe(35);
  });

  it("a negative charge gives tokens back, never past the burst", async () => {
    expect(await takeTokens(t.ctx.db, "test:refund", 60, 60, 50)).toBe(true);
    await freeze("test:refund");
    expect(await stored("test:refund")).toBe(10);
    await chargeTokens(t.ctx.db, "test:refund", 60, 60, -30);
    expect(await stored("test:refund")).toBe(40);
    expect(await takeTokens(t.ctx.db, "test:refund", 60, 60, 40)).toBe(true);
    expect(await stored("test:refund")).toBe(0);
    await chargeTokens(t.ctx.db, "test:refund", 60, 60, -100);
    expect(await stored("test:refund")).toBe(60);
    // A refund to a bucket nobody used yet leaves it full.
    await chargeTokens(t.ctx.db, "test:refund-new", 60, 60, -5);
    expect(await stored("test:refund-new")).toBe(60);
  });

  it("weighted takes from two database connections at once never overdraw the bucket", async () => {
    const { ctx } = replica();
    await chargeTokens(t.ctx.db, "test:weighted-race", 50, 50, 0);
    await freeze("test:weighted-race");

    const takes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        takeTokens(i % 2 === 0 ? ctx.db : t.ctx.db, "test:weighted-race", 50, 50, 7),
      ),
    );

    // 7 × 7 = 49 of 50.
    expect(takes.filter(Boolean)).toHaveLength(7);
    expect(await stored("test:weighted-race")).toBe(1);
  });
});
