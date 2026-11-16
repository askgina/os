import { ApiError } from "@askgina/os-api";
import type { WorkspaceId } from "@askgina/os-protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { agents } from "../../src/db/schema.ts";
import { sha256Hex } from "../../src/identity/secrets.ts";
import { createTestContext, type TestContext, type TestPerson } from "../support/context.ts";

let t: TestContext;

let workspaceId: WorkspaceId;

beforeAll(async () => {
  t = await createTestContext({ label: "pairing" });
  const created = await t.owner.browser.api.call("createWorkspace", { body: { name: "Ops" } });
  workspaceId = created.id;
});

afterAll(async () => {
  await t?.close();
});

const Started = z.strictObject({
  pairingId: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  pollSecret: z.string(),
  expiresAt: z.number(),
  interval: z.number(),
});

type Started = z.infer<typeof Started>;

/** What a poll answers; `approved` carries the token and where it works. */
const Polled = z.union([
  z.strictObject({ status: z.enum(["pending", "denied", "expired", "claimed"]) }),
  z.strictObject({
    status: z.literal("approved"),
    token: z.string(),
    mcpUrl: z.string(),
    workspaceId: z.string(),
    agentId: z.string(),
    walletId: z.string(),
    walletAddress: z.string().nullable(),
  }),
  z.strictObject({ error: z.strictObject({ code: z.string(), message: z.string() }) }),
]);

interface AgentRequest {
  path: "/agent-pairing" | "/agent-pairing/poll";
  body: { clientName: string } | { pairingId: string; pollSecret: string };
  origin?: string;
}

/** A request as an agent sends it: no cookie, and no `Origin` unless `origin` names one. */
async function agentRequest({ path, body, origin }: AgentRequest): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });

  if (origin !== undefined) headers.set("origin", origin);

  return t.app.fetch(
    new Request(`${t.ctx.config.publicOrigin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function start(clientName = "Hermes"): Promise<Started> {
  const response = await agentRequest({ path: "/agent-pairing", body: { clientName } });

  expect(response.status).toBe(201);

  return Started.parse(await response.json());
}

async function poll(pairing: Pick<Started, "pairingId" | "pollSecret">) {
  const response = await agentRequest({
    path: "/agent-pairing/poll",
    body: { pairingId: pairing.pairingId, pollSecret: pairing.pollSecret },
  });

  return { status: response.status, body: Polled.parse(await response.json()) };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof ApiError) return caught.code;
  }

  throw new Error("expected the API to refuse");
}

function approve(person: TestPerson, pairingId: string, name = "Hermes") {
  return person.browser.api.call("approvePairing", {
    params: { pairingId },
    body: { workspaceId, name },
  });
}

/** A new person who joins the workspace through an invite for `role`. */
async function join(role: "approver" | "viewer", name: string): Promise<TestPerson> {
  const { url } = await t.owner.browser.api.call("createInvite", {
    params: { workspaceId },
    body: { role },
  });

  const token = url.split("/join/")[1] ?? "";
  const browser = t.browser();

  const begun = await browser.api.call("startInviteRegistration", {
    params: { token },
    body: { displayName: name },
  });

  const passkey = t.register(begun.options);

  const session = await browser.api.call("finishInviteRegistration", {
    params: { token },
    body: { ceremonyId: begun.ceremonyId, response: passkey.response },
  });

  if (!session.user) throw new Error("joining did not sign in");

  return {
    userId: session.user.id,
    displayName: name,
    credentialId: passkey.credentialId,
    browser,
  };
}

describe("agent pairing", () => {
  it("connects an agent: matching code, allowed by an owner, token delivered exactly once", async () => {
    const pairing = await start();
    expect(pairing.userCode).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(pairing.verificationUrl).toBe(`${t.ctx.config.publicOrigin}/pair/${pairing.pairingId}`);
    expect(pairing.interval).toBe(2);
    expect((await poll(pairing)).body).toEqual({ status: "pending" });

    const seen = await t.owner.browser.api.call("getPairing", {
      params: { pairingId: pairing.pairingId },
    });

    expect(seen).toMatchObject({
      clientName: "Hermes",
      userCode: pairing.userCode,
      status: "pending",
    });

    const approved = await approve(t.owner, pairing.pairingId);
    const first = await poll(pairing);
    expect(first.body).toMatchObject({
      status: "approved",
      mcpUrl: `${t.ctx.config.publicOrigin}/mcp`,
      workspaceId,
      agentId: approved.agentId,
      walletId: approved.walletId,
    });

    // The delivered token is the agent's only working one, and nothing keeps it in clear.
    if (!("token" in first.body))
      throw new Error("the first poll after allowing carries the token");

    const { token } = first.body;
    const [row] = await t.ctx.db.select().from(agents).where(eq(agents.id, approved.agentId));
    expect(row?.tokenHash).toBe(sha256Hex(token));
    const dump = await t.ctx.pool.query("SELECT * FROM os.agent_pairings");
    expect(JSON.stringify(dump.rows)).not.toContain(token.slice(31));
    expect(t.log.lines.join("\n")).not.toContain(token.slice(31));

    expect((await poll(pairing)).body).toEqual({ status: "claimed" });

    // The new agent's wallet has no policy: it can sign nothing until an owner sets one.
    const atSigner = await t.ctx.signer.getWallet(approved.walletId);
    expect(atSigner.policy).toBeNull();
  });

  it("answers an unknown pairing and a wrong secret alike", async () => {
    const pairing = await start();

    expect((await poll({ ...pairing, pollSecret: "wrong" })).status).toBe(404);
    expect(
      (await poll({ pairingId: "pai_01kunknown0000000000000000", pollSecret: "x" })).status,
    ).toBe(404);
  });

  it("gives the token to one of two polls that arrive together", async () => {
    const pairing = await start();
    await approve(t.owner, pairing.pairingId);
    const results = await Promise.all([poll(pairing), poll(pairing), poll(pairing)]);

    const statuses = results.map((result) => ("status" in result.body ? result.body.status : null));

    expect(statuses.filter((status) => status === "approved")).toHaveLength(1);
    expect(statuses.filter((status) => status === "claimed")).toHaveLength(2);
  });

  it("only an owner of the workspace can allow it", async () => {
    const viewer = await join("viewer", "Vera");
    const pairing = await start();

    expect(await refusal(approve(viewer, pairing.pairingId))).toBe("forbidden");
    expect((await poll(pairing)).body).toEqual({ status: "pending" });
  });

  it("a denied pairing cannot be allowed, and the agent hears it was denied", async () => {
    const pairing = await start();
    await t.owner.browser.api.call("denyPairing", {
      params: { pairingId: pairing.pairingId },
      body: {},
    });

    expect(await refusal(approve(t.owner, pairing.pairingId))).toBe("conflict");
    expect((await poll(pairing)).body).toEqual({ status: "denied" });
  });

  it("expires when nobody answers in ten minutes", async () => {
    const pairing = await start();
    t.clock.advance(601);

    expect(await refusal(approve(t.owner, pairing.pairingId))).toBe("conflict");
    expect((await poll(pairing)).body).toEqual({ status: "expired" });
  });

  it("refuses requests from another site's page", async () => {
    const response = await agentRequest({
      path: "/agent-pairing",
      body: { clientName: "Evil" },
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
  });
});
