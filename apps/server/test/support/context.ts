import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiClient, createApiClient } from "@askgina/os-api";
import { DataKeyStore, LocalKeyring } from "@askgina/os-keys";
import {
  type ApprovalId,
  type AssertionResponse,
  envelopeChallenge,
  type UserId,
} from "@askgina/os-protocol";
import { createSignerClient } from "@askgina/os-protocol/signer";
import { SoftAuthenticator } from "@askgina/os-protocol/testing";
import { createSigner, createTestVault, type Signer } from "@askgina/os-signer";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import type { ApprovalRow } from "../../src/approvals/kinds.ts";
import { type Config, loadConfig } from "../../src/config.ts";
import type { AppContext, Session } from "../../src/context.ts";
import { migrateDatabase } from "../../src/db/migrate.ts";
import * as schema from "../../src/db/schema.ts";
import { createSealer } from "../../src/db/sealed.ts";
import { registerDirectory } from "../../src/directory/index.ts";
import { createApprovalEngine, engineOf } from "../../src/execution/approvals.ts";
import { createChains } from "../../src/execution/chains.ts";
import { workflowRuntime } from "../../src/execution/workflow-runtime.ts";
import { installErrorHandler } from "../../src/http/route.ts";
import { registerIdentity } from "../../src/identity/index.ts";
import { createSessions } from "../../src/identity/sessions.ts";
import { prepareSetup } from "../../src/identity/setup.ts";
import type { LogFields, Logger } from "../../src/log.ts";

/** Where the test browser pretends to be. Passkeys are bound to its host. */
export const TEST_ORIGIN = "http://localhost:55710";
export const TEST_CHAIN_ID = "eip155:31337";
export const TEST_RPC_URL = process.env.TEST_RPC_URL ?? "http://127.0.0.1:55545";

/** A clock tests move by hand. Shared by the control plane and the in-process signer. */
export interface TestClock {
  now(): number;
  advance(seconds: number): void;
}

/** Everything a test logged, so tests can assert what never reaches a log line. */
export interface RecordingLogger extends Logger {
  lines: string[];
}

function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  const write =
    (level: string) =>
    (message: string, fields: LogFields = {}) => {
      lines.push(JSON.stringify({ level, message, ...fields }));
    };
  return { lines, info: write("info"), warn: write("warn"), error: write("error") };
}

/** A person with a passkey in the shared soft authenticator and a browser with a cookie jar. */
export interface TestPerson {
  userId: UserId;
  displayName: string;
  credentialId: string;
  browser: TestBrowser;
}

/** Calls the app the way a browser on {@link TEST_ORIGIN} would, keeping the session cookie. */
export interface TestBrowser {
  api: ApiClient;
  /** The current `Cookie` header value, or "" when signed out. */
  cookie(): string;
  /** A raw request through the same cookie jar. `origin: null` sends no `Origin` header. */
  fetch(path: string, init?: RequestInit & { origin?: string | null }): Promise<Response>;
}

export interface TestContext {
  ctx: AppContext;
  app: Hono;
  clock: TestClock;
  log: RecordingLogger;
  signer: Signer;
  authenticator: SoftAuthenticator;
  /** The first owner, created through the real setup flow and signed in. */
  owner: TestPerson;
  /** A fresh browser with no cookie. */
  browser(): TestBrowser;
  /** Register a passkey in the soft authenticator for a registration ceremony's options. */
  register(options: Record<string, unknown>): { response: unknown; credentialId: string };
  /** Sign in with an existing passkey of the soft authenticator. */
  signIn(credentialId: string, browser?: TestBrowser): Promise<TestBrowser>;
  /**
   * Approve a request with each person's passkey, as the approval page would, and then do what
   * the workflow does once the request is decided: apply it, or end it as failed.
   */
  approve(approvalId: ApprovalId, people: TestPerson[]): Promise<ApprovalRow>;
  /** Do what the workflow does when a request ends without effect (after a cancel or reject). */
  settle(approvalId: ApprovalId): Promise<ApprovalRow>;
  close(): Promise<void>;
}

export interface TestContextOptions {
  /** Unique per test file; names the database. */
  label: string;
  /** Extra routes on the test app, for example the execution module's. */
  routes?: (app: Hono, ctx: AppContext) => void;
  config?: Partial<Config>;
  /** Runs on the fresh installation, after the setup token exists and before the owner does. */
  beforeOwner?: (setup: { token: string; browser: TestBrowser }) => Promise<void>;
}

function testConfig(databaseUrl: string, overrides: Partial<Config>): Config {
  const dir = mkdtempSync(join(tmpdir(), "os-server-test-"));
  const keyringFile = join(dir, "keyring.json");
  writeFileSync(keyringFile, JSON.stringify(LocalKeyring.generate()));
  const secretFile = join(dir, "signer-secret");
  writeFileSync(secretFile, randomBytes(32).toString("base64"));
  const chainsFile = join(dir, "chains.json");
  writeFileSync(
    chainsFile,
    JSON.stringify([
      { chainId: TEST_CHAIN_ID, name: "Local", rpcUrl: TEST_RPC_URL, nativeSymbol: "ETH" },
    ]),
  );
  return {
    ...loadConfig({
      PUBLIC_ORIGIN: TEST_ORIGIN,
      DATABASE_URL: databaseUrl,
      KEYRING_FILE: keyringFile,
      SIGNER_URL: "http://signer.test",
      SIGNER_HMAC_SECRET_FILE: secretFile,
      CHAINS_FILE: chainsFile,
    }),
    ...overrides,
  };
}

/**
 * A control plane on a private database, with the real signer in process (in-memory SQLite and
 * a test vault), the real approval engine, a hand-moved clock and a signed-in owner. Workflow
 * runs start when requests open, but no step implementations are registered: tests decide and
 * apply requests themselves through `approve` and `settle`. Call `close()` in `afterAll`.
 */
export async function createTestContext(options: TestContextOptions): Promise<TestContext> {
  const database: TestDatabase = await createTestDatabase(options.label);
  const config = testConfig(database.url, options.config ?? {});
  let time = 1_800_000_000;
  const clock: TestClock = {
    now: () => time,
    advance: (seconds) => {
      time += seconds;
    },
  };
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
  await migrateDatabase(pool);
  const keys = new DataKeyStore({ pool, provider: LocalKeyring.fromFile(config.keyringFile) });
  await keys.ensureMigrated();
  const signer = createSigner({
    sqlitePath: ":memory:",
    vault: createTestVault(),
    relyingParty: { id: config.relyingParty.id, origins: config.relyingParty.origins },
    requestSecret: config.signerSecret,
    tokenKey: randomBytes(32),
    maxIntentTtlSeconds: 86_400,
    maxAdminTtlSeconds: 86_400,
    now: clock.now,
  });
  const db = drizzle(pool, { schema });
  const log = recordingLogger();
  const ctx: AppContext = {
    config,
    pool,
    db,
    keys,
    sealer: createSealer(keys),
    signer: createSignerClient({
      baseUrl: config.signerUrl,
      secret: config.signerSecret,
      fetch: async (input, init) => signer.app.fetch(new Request(input, init)),
      now: clock.now,
    }),
    sessions: createSessions({ db, config, now: clock.now }),
    chains: createChains(config),
    approvals: undefined as unknown as AppContext["approvals"],
    log,
    now: clock.now,
  };
  ctx.approvals = createApprovalEngine(ctx);

  const app = new Hono();
  installErrorHandler(app, ctx);
  registerIdentity(app, ctx);
  registerDirectory(app, ctx);
  options.routes?.(app, ctx);

  const authenticator = new SoftAuthenticator();

  const browser = (): TestBrowser => {
    const jar = new Map<string, string>();
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const send = async (url: string, init: RequestInit & { origin?: string | null } = {}) => {
      const headers = new Headers(init.headers);
      const origin = init.origin === undefined ? TEST_ORIGIN : init.origin;
      if (origin !== null) headers.set("origin", origin);
      if (jar.size > 0) headers.set("cookie", cookie());
      const response = await app.fetch(
        new Request(new URL(url, TEST_ORIGIN), { ...init, headers }),
      );
      for (const line of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = line.split(";");
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        const expired = attributes.some((attribute) => attribute.trim() === "Max-Age=0");
        if (expired || value === "") jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    return {
      api: createApiClient({ fetch: (input, init) => send(String(input), init ?? {}) }),
      cookie,
      fetch: send,
    };
  };

  const register = (options: Record<string, unknown>) => {
    const { response } = authenticator.register({
      rpId: config.relyingParty.id,
      challenge: options.challenge as string,
      origin: TEST_ORIGIN,
    });
    return { response, credentialId: response.id };
  };

  const signIn = async (credentialId: string, existing?: TestBrowser) => {
    const target = existing ?? browser();
    const { ceremonyId, options } = await target.api.call("startLogin", { body: {} });
    const response = authenticator.authenticate({
      credentialId,
      challenge: options.challenge as string,
      origin: TEST_ORIGIN,
    });
    await target.api.call("finishLogin", {
      body: { ceremonyId, response: response as AssertionResponse },
    });
    return target;
  };

  // The first owner, through the same setup flow an operator uses.
  const token = await prepareSetup(ctx);
  if (token === null) throw new Error("a fresh database must need setup");
  await options.beforeOwner?.({ token, browser: browser() });
  const ownerBrowser = browser();
  const setup = await ownerBrowser.api.call("startSetup", {
    body: { setupToken: token, displayName: "Olivia Owner" },
  });
  const ownerPasskey = register(setup.options);
  const session = await ownerBrowser.api.call("finishSetup", {
    body: { ceremonyId: setup.ceremonyId, response: ownerPasskey.response as never },
  });
  if (session.user === null) throw new Error("setup did not sign the owner in");
  const owner: TestPerson = {
    userId: session.user.id,
    displayName: session.user.displayName,
    credentialId: ownerPasskey.credentialId,
    browser: ownerBrowser,
  };

  const engine = engineOf(ctx);
  const settle = async (approvalId: ApprovalId) => {
    const row = await engine.row(approvalId);
    await engine.steps().abandon(approvalId, row.status);
    return engine.row(approvalId);
  };

  return {
    ctx,
    app,
    clock,
    log,
    signer,
    authenticator,
    owner,
    browser,
    register,
    signIn,
    async approve(approvalId, people) {
      for (const person of people) {
        const row = await engine.row(approvalId);
        if (row.status !== "pending") break;
        const session: Session = {
          user: { id: person.userId, displayName: person.displayName },
          credentialId: person.credentialId,
          idHash: "test",
        };
        const response = authenticator.authenticate({
          credentialId: person.credentialId,
          challenge: Buffer.from(envelopeChallenge(row.envelope)).toString("base64url"),
          origin: TEST_ORIGIN,
        });
        await engine.approve(row, session, response as AssertionResponse);
      }
      const steps = engine.steps();
      if ((await engine.row(approvalId)).status === "approved") {
        const result = await steps.execute(approvalId);
        if (!result.ok) await steps.fail(approvalId, result.code);
      }
      return engine.row(approvalId);
    },
    settle,
    async close() {
      // Opening a request starts its workflow run, which creates and starts the World's queue
      // workers on this pool; they must stop before the pool can end.
      await workflowRuntime(ctx).world.close?.();
      signer.close();
      await pool.end();
      await database.drop();
    },
  };
}
