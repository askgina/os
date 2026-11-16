import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApiClient,
  type ApprovalDetail,
  createApiClient,
  RegistrationResponse,
  type WebAuthnOptions,
} from "@askgina/os-api";
import { DataKeyStore, LocalKeyring } from "@askgina/os-keys";
import {
  type AddApproverEnvelope,
  type ApprovalId,
  AssertionResponse,
  type Envelope,
  envelopeChallenge,
  type UserId,
} from "@askgina/os-protocol";
import {
  type ConfirmClient,
  createConfirmClient,
  createSignerClient,
  type SubmitPossessionResponse,
} from "@askgina/os-protocol/signer";
import { SoftAuthenticator } from "@askgina/os-protocol/testing";
import { createSigner, createTestVault, type Signer } from "@askgina/os-signer";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import { z } from "zod";
import type { ApprovalEngine, ApprovalRow } from "../../src/approvals/kinds.ts";
import { type Config, loadConfig } from "../../src/config.ts";
import type { AppContext } from "../../src/context.ts";
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
import { prepareSetup, rotateSetupToken } from "../../src/identity/setup.ts";
import type { LogFields, Logger } from "../../src/log.ts";
import { registerNotify } from "../../src/notify/routes.ts";

/** Where the test browser pretends to be. Passkeys are bound to its host. */
export const TEST_ORIGIN = "http://localhost:55710";

/** Where the signer's confirmation page would be: another port on the same host. */
export const TEST_APPROVAL_ORIGIN = "http://localhost:55711";

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

/** The one field of WebAuthn ceremony options the soft authenticator needs. */
const CeremonyChallenge = z.looseObject({ challenge: z.string() });

/** The challenge of ceremony options as `@simplewebauthn/server` generated them. */
export function challengeOf(options: WebAuthnOptions): string {
  return CeremonyChallenge.parse(options).challenge;
}

/** The one approval a change opened, from its response's `approvals`; throws when it opened none. */
export function firstApproval(opened: readonly { id: ApprovalId }[]): ApprovalId {
  const [first] = opened;

  if (first === undefined) throw new Error("the change opened no approval");

  return first.id;
}

/** A JSON object as a test reads it back: a logged line, a webhook body. */
export const JsonObject = z.record(z.string(), z.json());

export type JsonObject = z.infer<typeof JsonObject>;

/** Every line `log` recorded, each decoded from the JSON object the logger wrote. */
export function loggedLines(log: RecordingLogger): JsonObject[] {
  return log.lines.map((line) => JsonObject.parse(JSON.parse(line)));
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
  /** The `approve` service's view of the in-process signer: its confirm routes. */
  confirm: ConfirmClient;
  authenticator: SoftAuthenticator;
  /** The first owner, created through the real setup flow and signed in. */
  owner: TestPerson;
  /** A fresh browser with no cookie. */
  browser(): TestBrowser;
  /** Register a passkey in the soft authenticator for a registration ceremony's options. */
  register(options: WebAuthnOptions): { response: RegistrationResponse; credentialId: string };
  /** Sign in with an existing passkey of the soft authenticator. */
  signIn(credentialId: string, browser?: TestBrowser): Promise<TestBrowser>;
  /**
   * Approve a request as `person` does: follow the approval page's link to the signer's
   * confirmation page, approve there with the passkey (an assertion made at
   * {@link TEST_APPROVAL_ORIGIN}, sent through the `approve` service's route), then come back to
   * the approval page, which collects. Throws the signer's refusal as a `SignerError`.
   */
  approveOnPage(person: TestPerson, approvalId: ApprovalId): Promise<ApprovalDetail>;
  /**
   * Only the confirmation page's part of {@link approveOnPage}: approve `envelope` with
   * `person`'s passkey at the page `link` names, without collecting.
   */
  approveAt(link: string, person: TestPerson, envelope: Envelope): Promise<void>;
  /**
   * The possession step of an approver change, as the person being added does it on the
   * confirmation page at `link`: answer the signer's challenge there with the passkey `envelope`
   * carries. The shared soft authenticator holds every test passkey, so whoever registered it
   * answers. Throws the signer's refusal as a `SignerError`.
   */
  provePossession(link: string, envelope: AddApproverEnvelope): Promise<SubmitPossessionResponse>;
  /**
   * Approve a request on the confirmation page with each person's passkey, collect each approval
   * as the control plane does, and then do what the workflow does once the request is decided:
   * apply it, or end it as failed. For an approver change, the person being added first does
   * the possession step there, as nobody can approve before they have. Throws when the signer
   * refuses an approval or the control plane does not count it.
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
  /** The in-process signer's attempt limits, where a test needs other than its defaults. */
  signer?: { repriceWindowSeconds?: number; maxTxAttempts?: number };
  /** Runs on the fresh installation, after the setup token exists and before the owner does. */
  beforeOwner?: (setup: { token: string; browser: TestBrowser }) => Promise<void>;
}

function testConfig(databaseUrl: string, overrides: Partial<Config>) {
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

  const config: Config = {
    ...loadConfig({
      PUBLIC_ORIGIN: TEST_ORIGIN,
      APPROVE_ORIGIN: TEST_APPROVAL_ORIGIN,
      DATABASE_URL: databaseUrl,
      SIGNER_URL: "http://signer.test",
      SIGNER_HMAC_SECRET_FILE: secretFile,
      CHAINS_FILE: chainsFile,
    }),
    ...overrides,
  };

  return { config, keyringFile };
}

/**
 * A control plane on a private database, with the real signer in process (in-memory SQLite and
 * a test vault), the real approval engine, a hand-moved clock and a signed-in owner. Workflow
 * runs start when requests open, but no step implementations are registered: tests decide and
 * apply requests themselves through `approve` and `settle`. Call `close()` in `afterAll`.
 */
export async function createTestContext(options: TestContextOptions): Promise<TestContext> {
  const database: TestDatabase = await createTestDatabase(options.label);
  const { config, keyringFile } = testConfig(database.url, options.config ?? {});
  let time = 1_800_000_000;

  const clock: TestClock = {
    now: () => time,
    advance: (seconds) => {
      time += seconds;
    },
  };

  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
  await migrateDatabase(pool);
  const keys = new DataKeyStore({ pool, provider: LocalKeyring.fromFile(keyringFile) });
  await keys.ensureMigrated();
  const confirmSecret = new Uint8Array(randomBytes(32));

  const signer = createSigner({
    sqlitePath: ":memory:",
    vault: createTestVault(),
    rpId: config.relyingParty.id,
    requestSecret: config.signerSecret,
    confirmSecret,
    approvalOrigin: config.approveOrigin,
    returnOrigin: TEST_ORIGIN,
    // The signer reads the control plane's chains file and keeps only these fields.
    chains: config.chains.map(({ chainId, name, nativeSymbol }) => ({
      chainId,
      name,
      nativeSymbol,
    })),
    assets: [],
    tokenKey: randomBytes(32),
    maxIntentTtlSeconds: 86_400,
    maxAdminTtlSeconds: 86_400,
    ...options.signer,
    now: clock.now,
  });

  const db = drizzle(pool, { schema });
  const log = recordingLogger();

  let approvalEngine: ApprovalEngine | null = null;

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
    // The engine keeps this object and reads `approvals` lazily; it is created right below.
    get approvals(): ApprovalEngine {
      if (approvalEngine === null) throw new Error("the approval engine is not created yet");

      return approvalEngine;
    },
    log,
    now: clock.now,
  };

  approvalEngine = createApprovalEngine(ctx);

  const app = new Hono();
  installErrorHandler(app, ctx);
  registerIdentity(app, ctx);
  registerDirectory(app, ctx);
  registerNotify(app, ctx);
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

  const register = (options: WebAuthnOptions) => {
    const { response } = authenticator.register({
      rpId: config.relyingParty.id,
      challenge: challengeOf(options),
      origin: TEST_ORIGIN,
    });

    return { response: RegistrationResponse.parse(response), credentialId: response.id };
  };

  const signIn = async (credentialId: string, existing?: TestBrowser) => {
    const target = existing ?? browser();
    const { ceremonyId, options } = await target.api.call("startLogin", { body: {} });

    const response = AssertionResponse.parse(
      authenticator.authenticate({
        credentialId,
        challenge: challengeOf(options),
        origin: TEST_ORIGIN,
      }),
    );

    await target.api.call("finishLogin", { body: { ceremonyId, response } });

    return target;
  };

  // The first owner, through the same setup flow an operator uses.
  await prepareSetup(ctx);
  const token = await rotateSetupToken(ctx);

  if (token === null) throw new Error("a fresh database must need setup");
  await options.beforeOwner?.({ token, browser: browser() });
  const ownerBrowser = browser();

  const setup = await ownerBrowser.api.call("startSetup", {
    body: { setupToken: token, displayName: "Olivia Owner" },
  });

  const ownerPasskey = register(setup.options);

  const session = await ownerBrowser.api.call("finishSetup", {
    body: { ceremonyId: setup.ceremonyId, response: ownerPasskey.response },
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

  const confirm = createConfirmClient({
    baseUrl: config.signerUrl,
    secret: confirmSecret,
    fetch: async (input, init) => signer.app.fetch(new Request(input, init)),
    now: clock.now,
  });

  /** The confirmation page a link opens: its origin, and the token from the fragment. */
  const pageAt = (link: string) => {
    const url = new URL(link);

    if (url.origin !== config.approveOrigin)
      throw new Error(`${link} is not the confirmation page`);

    return { origin: url.origin, token: url.hash.slice(1) };
  };

  /** What the confirmation page at `link` sends after `person` approved `envelope` there. */
  const approveAt = async (link: string, person: TestPerson, envelope: Envelope) => {
    const page = pageAt(link);

    const response = AssertionResponse.parse(
      authenticator.authenticate({
        credentialId: person.credentialId,
        challenge: Buffer.from(envelopeChallenge(envelope)).toString("base64url"),
        origin: page.origin,
      }),
    );

    await confirm.submitConfirmation(envelope.approvalId, page.token, response);
  };

  const provePossession = async (link: string, envelope: AddApproverEnvelope) => {
    const page = pageAt(link);
    const options = await confirm.getPossession(envelope.approvalId, page.token);

    const response = AssertionResponse.parse(
      authenticator.authenticate({
        credentialId: envelope.credentialId,
        challenge: options.challenge,
        origin: page.origin,
      }),
    );

    return confirm.submitPossession(envelope.approvalId, page.token, response);
  };

  return {
    ctx,
    app,
    clock,
    log,
    signer,
    confirm,
    approveAt,
    provePossession,
    authenticator,
    owner,
    browser,
    register,
    signIn,
    async approveOnPage(person, approvalId) {
      const shown = await person.browser.api.call("getApproval", { params: { approvalId } });

      if (shown.confirmUrl === null) throw new Error(`${approvalId} shows no confirmation page`);
      await approveAt(shown.confirmUrl, person, shown.envelope);

      return person.browser.api.call("collectApproval", { params: { approvalId }, body: {} });
    },
    async approve(approvalId, people) {
      const opened = await engine.request(approvalId);

      if (opened.status === "pending" && opened.envelope.type === "add-approver") {
        const link = await engine.ensureConfirmation(opened);

        if (link === null) throw new Error(`${approvalId} has no confirmation page`);
        const view = await confirm.getConfirmation(approvalId, pageAt(link).token);

        if (view.warnings.includes("possession_unproven")) {
          await provePossession(link, opened.envelope);
        }
      }

      for (const person of people) {
        const row = await engine.request(approvalId);

        if (row.status !== "pending") break;
        const link = await engine.ensureConfirmation(row);

        if (link === null) throw new Error(`${approvalId} has no confirmation page`);
        await approveAt(link, person, row.envelope);
        await engine.collect(await engine.request(approvalId));

        const [counted] = await ctx.db
          .select({ userId: schema.approvalAssertions.userId })
          .from(schema.approvalAssertions)
          .where(
            and(
              eq(schema.approvalAssertions.approvalId, approvalId),
              eq(schema.approvalAssertions.userId, person.userId),
            ),
          );

        if (!counted) throw new Error(`${person.displayName}'s approval was not counted`);
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
