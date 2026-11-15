import {
  AssertionResponse,
  type ConfirmationSubject,
  type Envelope,
  envelopeChallenge,
  type Intent,
  newId,
  policyHash,
  type Sweep,
  sweepHash,
  type WalletPolicy,
} from "@askgina/os-protocol";
import { createConfirmClient, createSignerClient } from "@askgina/os-protocol/signer";
import { b64url } from "@askgina/os-protocol/testing";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ORIGIN,
  approveIntent,
  authorize,
  CHAIN,
  ETH,
  header,
  intentFor,
  newPerson,
  ORIGIN,
  type Person,
  RECIPIENT,
  refused,
  setUpWorld,
  startSigner,
  type TestSigner,
  txParams,
  type World,
} from "./harness.ts";

/** What a browser sends after `person` approved `envelope` with their passkey on a page at `origin`. */
function assertAt(
  person: Person,
  envelope: Envelope,
  origin: string,
  overrides: { crossOrigin?: boolean } = {},
): AssertionResponse {
  return AssertionResponse.parse(
    person.authenticator.authenticate({
      credentialId: person.credential.credentialId,
      challenge: b64url(envelopeChallenge(envelope)),
      origin,
      ...overrides,
    }),
  );
}

const tokenOf = (path: string) => path.slice(path.indexOf("#") + 1);

/** A payment's envelope, with no assertions yet, and the subject the control plane sends. */
function paymentRequest(world: World, intent: Intent = intentFor(world)) {
  const { envelope } = approveIntent(world, intent, { people: [] });
  return { envelope, subject: { kind: "approve-intent", intent } as ConfirmationSubject, intent };
}

/** Open the confirmation for `envelope` and return its token. */
async function open(t: TestSigner, envelope: Envelope, subject: ConfirmationSubject) {
  const { path } = await t.client.openConfirmation(envelope.approvalId, { envelope, subject });
  expect(path.startsWith(`/a/${envelope.approvalId}#`)).toBe(true);
  return tokenOf(path);
}

async function payment(world: World, t: TestSigner, intent?: Intent) {
  const request = paymentRequest(world, intent);
  const token = await open(t, request.envelope, request.subject);
  return { ...request, token };
}

describe("opening a confirmation", () => {
  it("opening a confirmation for a mismatched intent is refused", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const { envelope, intent } = paymentRequest(world);
    const subject = (other: Intent): ConfirmationSubject => ({
      kind: "approve-intent",
      intent: other,
    });

    // Another amount: the hash differs from the envelope's.
    await refused(
      t.client.openConfirmation(envelope.approvalId, {
        envelope,
        subject: subject({
          ...intent,
          operation: { type: "evm.transfer", to: RECIPIENT, valueWei: String(2n * ETH) },
        }),
      }),
      "intent_mismatch",
    );
    // Another recipient, with only the memo kept.
    await refused(
      t.client.openConfirmation(envelope.approvalId, {
        envelope,
        subject: subject({
          ...intent,
          operation: { type: "evm.transfer", to: `0x${"ee".repeat(20)}`, valueWei: String(ETH) },
        }),
      }),
      "intent_mismatch",
    );
    // The intent of another wallet, or no intent at all.
    await refused(
      t.client.openConfirmation(envelope.approvalId, {
        envelope,
        subject: subject({ ...intent, walletId: newId("wal") }),
      }),
      "envelope_mismatch",
    );
    await refused(
      t.client.openConfirmation(envelope.approvalId, {
        envelope,
        subject: { kind: "envelope-only" },
      }),
      "envelope_mismatch",
    );
    // An envelope opened under another approval's id.
    await refused(
      t.client.openConfirmation(newId("apr"), { envelope, subject: subject(intent) }),
      "envelope_mismatch",
    );
    // Nothing was stored for it.
    await refused(t.client.listConfirmationAssertions(envelope.approvalId), "not_found");
  });

  it("opening again issues a new token and the old link finds nothing; another envelope is a conflict", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const { envelope, subject, token: first } = await payment(world, t);
    const second = await open(t, envelope, subject);
    expect(second).not.toBe(first);
    await refused(t.confirm.getConfirmation(envelope.approvalId, first), "not_found");
    expect((await t.confirm.getConfirmation(envelope.approvalId, second)).state).toBe("open");

    // A token for another approval, or no token, finds nothing either.
    const other = await payment(world, t);
    await refused(t.confirm.getConfirmation(envelope.approvalId, other.token), "not_found");
    await refused(t.confirm.getConfirmation(envelope.approvalId, ""), "not_found");
    await refused(
      t.confirm.submitConfirmation(
        envelope.approvalId,
        first,
        assertAt(world.people[0] as Person, envelope, APPROVAL_ORIGIN),
      ),
      "not_found",
    );

    const replaced = paymentRequest(world, intentFor(world, undefined, "another note"));
    await refused(
      t.client.openConfirmation(envelope.approvalId, {
        envelope: { ...replaced.envelope, approvalId: envelope.approvalId },
        subject: replaced.subject,
      }),
      "conflict",
    );
  });

  it("is not opened for an approval revoked, used, expired, fenced or under another policy", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);

    const revoked = paymentRequest(world);
    await t.client.revokeApproval(revoked.envelope.approvalId, world.workspaceId);
    await refused(open(t, revoked.envelope, revoked.subject), "approval_revoked");

    const intent = intentFor(world);
    const signed = approveIntent(world, intent);
    await t.client.sign({ intent, authorization: signed, transaction: txParams() });
    await refused(
      open(t, signed.envelope, { kind: "approve-intent", intent }),
      "confirmation_closed",
    );

    const elsewhere = await setUpWorld(t);
    const changed = paymentRequest(elsewhere);
    await replacePolicy(elsewhere, { recipients: { mode: "allowlist", addresses: [RECIPIENT] } });
    await refused(open(t, changed.envelope, changed.subject), "policy_changed");

    const stale = paymentRequest(world);
    t.clock.value = stale.envelope.expiresAt;
    await refused(open(t, stale.envelope, stale.subject), "envelope_expired");

    const fenced = paymentRequest(world);
    t.clock.value += 1;
    t.signer.fence();
    await refused(open(t, fenced.envelope, fenced.subject), "envelope_fenced");
  });
});

/** Approve and apply a new revision of the wallet's policy through the old path. */
async function replacePolicy(world: World, changes: Partial<WalletPolicy>): Promise<WalletPolicy> {
  const policy: WalletPolicy = {
    ...world.policy,
    ...changes,
    revision: world.policy.revision + 1,
    previousHash: policyHash(world.policy),
  };
  await world.t.client.setPolicy(world.walletId, {
    policy,
    authorization: authorize(
      {
        ...header(world.t.clock, newId("apr"), world.workspaceId),
        type: "set-policy",
        walletId: world.walletId,
        policyHash: policyHash(policy),
        previousPolicyHash: policyHash(world.policy),
      },
      world.people,
    ),
  });
  return policy;
}

describe("the view", () => {
  it("the confirmation page shows the payment exactly as in the intent the signer holds", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [alice] = world.people as [Person];
    // Half an ether already signed today counts against the 1.5 ether daily cap.
    const earlier = intentFor(world, {
      type: "evm.transfer",
      to: RECIPIENT,
      valueWei: String(ETH / 2n),
    });
    await t.client.sign({
      intent: earlier,
      authorization: approveIntent(world, earlier),
      transaction: txParams(),
    });

    const { envelope, token } = await payment(world, t);
    // The client parses the view with its schema, which ties it to its own envelope and subject.
    const view = await t.confirm.getConfirmation(envelope.approvalId, token);
    const line = (label: string) =>
      view.lines.find((candidate) => candidate.label === label)?.value;

    expect(view.state).toBe("open");
    expect(view.kind).toBe("approve-intent");
    expect(view.envelope).toEqual(envelope);
    expect(view.title).toBe("Send 1 ETH");
    expect(line("Amount")).toBe("1 ETH");
    expect(line("To")).toBe(RECIPIENT);
    expect(line("Network")).toBe(`Local chain (${CHAIN})`);
    expect(line("Wallet address")).toBe(world.address);
    expect(line("Wallet name, not checked")).toBe("agent wallet");
    expect(line("Spent in the last 24 hours")).toBe("0.5 ETH of 1.5 ETH");
    expect(line("Agent's note, not checked")).toBe("pay the invoice");
    expect(view.warnings).toEqual([]);
    expect(view.approvals).toEqual({ collected: 0, required: 1 });
    expect(view.webauthn).toEqual({
      rpId: "localhost",
      challenge: b64url(envelopeChallenge(envelope)),
      allowCredentials: [alice.credential.credentialId],
      userVerification: "required",
      timeoutMs: 120_000,
    });
    expect(view.returnUrl).toBe(
      `${ORIGIN}/w/${world.workspaceId}/approvals/${envelope.approvalId}`,
    );
  });

  it("every kind of envelope opens and is shown with the approvals its kind needs", async () => {
    const t = startSigner();
    // Payments need one approval, everything else two.
    const world = await setUpWorld(t, { people: 3, adminThreshold: 2, policyThreshold: 1 });
    const [alice] = world.people as [Person];
    const treasury = await t.client.createWallet({
      workspaceId: world.workspaceId,
      walletId: newId("wal"),
      kind: "treasury",
      label: "treasury",
    });
    const nextPolicy: WalletPolicy = {
      ...world.policy,
      revision: 2,
      previousHash: policyHash(world.policy),
      recipients: { mode: "allowlist", addresses: [RECIPIENT] },
    };
    const sweep: Sweep = {
      v: 1,
      workspaceId: world.workspaceId,
      walletId: world.walletId,
      chainId: CHAIN,
      asset: "native",
      amount: String(3n * ETH),
      to: treasury.address,
      maxFeeWei: String(10n ** 15n),
    };
    const newcomer = newPerson();
    const base = () => header(t.clock, newId("apr"), world.workspaceId);
    const pay = paymentRequest(world);
    const cases: {
      envelope: Envelope;
      subject: ConfirmationSubject;
      title: string;
      required: number;
    }[] = [
      { ...pay, title: "Send 1 ETH", required: 1 },
      {
        envelope: {
          ...base(),
          type: "set-policy",
          walletId: world.walletId,
          policyHash: policyHash(nextPolicy),
          previousPolicyHash: policyHash(world.policy),
        },
        subject: { kind: "set-policy", policy: nextPolicy },
        title: "Change a wallet's policy",
        required: 2,
      },
      {
        envelope: {
          ...base(),
          type: "sweep-wallet",
          walletId: world.walletId,
          chainId: CHAIN,
          sweepHash: sweepHash(sweep),
        },
        subject: { kind: "sweep-wallet", sweep },
        title: "Move 3 ETH out of the wallet",
        required: 2,
      },
      {
        envelope: { ...base(), type: "add-approver", ...newcomer.credential },
        subject: { kind: "envelope-only" },
        title: "Add an approver",
        required: 2,
      },
      {
        envelope: {
          ...base(),
          type: "remove-approver",
          userId: alice.userId,
          credentialId: alice.credential.credentialId,
        },
        subject: { kind: "envelope-only" },
        title: "Remove an approver",
        required: 2,
      },
      {
        envelope: { ...base(), type: "set-admin-threshold", adminThreshold: 3 },
        subject: { kind: "envelope-only" },
        title: "Change the approvals needed for workspace changes",
        required: 2,
      },
      {
        envelope: { ...base(), type: "resume-workspace" },
        subject: { kind: "envelope-only" },
        title: "Resume the workspace",
        required: 2,
      },
    ];
    for (const { envelope, subject, title, required } of cases) {
      const token = await open(t, envelope, subject);
      const view = await t.confirm.getConfirmation(envelope.approvalId, token);
      expect([view.kind, view.title, view.approvals]).toEqual([
        envelope.type,
        title,
        { collected: 0, required },
      ]);
      expect(view.subject).toEqual(subject);
      if (envelope.type === "sweep-wallet") {
        // The destination is checked against the signer's own list of treasuries.
        expect(view.lines.find((line) => line.label === "Destination")?.value).toBe(
          "a treasury wallet of this workspace",
        );
        expect(view.warnings).toEqual([]);
      }
    }
  });
});

describe("submitting an assertion", () => {
  it("an assertion made at the approval origin is stored", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [alice] = world.people as [Person];
    const { envelope, intent, token } = await payment(world, t);

    expect(
      await t.confirm.submitConfirmation(
        envelope.approvalId,
        token,
        assertAt(alice, envelope, APPROVAL_ORIGIN),
      ),
    ).toEqual({
      collected: 1,
      required: 1,
      returnUrl: `${ORIGIN}/w/${world.workspaceId}/approvals/${envelope.approvalId}`,
    });
    const view = await t.confirm.getConfirmation(envelope.approvalId, token);
    expect(view.state).toBe("complete");
    expect(view.approvals).toEqual({ collected: 1, required: 1 });
    expect(view.webauthn.allowCredentials).toEqual([]);

    // The control plane gets it back with the signer's record of who made it, and the signer
    // signs with it.
    const { assertions } = await t.client.listConfirmationAssertions(envelope.approvalId);
    expect(assertions.map((assertion) => [assertion.userId, assertion.credentialId])).toEqual([
      [alice.userId, alice.credential.credentialId],
    ]);
    const signed = await t.client.sign({
      intent,
      authorization: { envelope, assertions },
      transaction: txParams(),
    });
    expect(signed.approvalId).toBe(envelope.approvalId);
    expect((await t.confirm.getConfirmation(envelope.approvalId, token)).state).toBe("used");
  });

  it("an assertion made at another origin is refused with assertion_invalid", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [alice] = world.people as [Person];
    const { envelope, token } = await payment(world, t);
    const submit = (response: AssertionResponse) =>
      t.confirm.submitConfirmation(envelope.approvalId, token, response);

    // The control plane's page, which the signer still accepts for signing until the cutover.
    await refused(submit(assertAt(alice, envelope, ORIGIN)), "assertion_invalid");
    // Another host under the RP ID, and the approval host over the other scheme.
    await refused(
      submit(assertAt(alice, envelope, "http://evil.localhost:8081")),
      "assertion_invalid",
    );
    await refused(submit(assertAt(alice, envelope, "https://localhost:8081")), "assertion_invalid");
    // The approval origin, but inside a frame of another page.
    await refused(
      submit(assertAt(alice, envelope, APPROVAL_ORIGIN, { crossOrigin: true })),
      "assertion_invalid",
    );
    // The approval origin, over another envelope's digest.
    const other = paymentRequest(world);
    await refused(submit(assertAt(alice, other.envelope, APPROVAL_ORIGIN)), "assertion_invalid");

    expect((await t.client.listConfirmationAssertions(envelope.approvalId)).assertions).toEqual([]);
    expect((await t.confirm.getConfirmation(envelope.approvalId, token)).state).toBe("open");
  });

  it("an assertion from a passkey that is not an approver is refused with approver_unknown", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const elsewhere = await setUpWorld(t);
    const { envelope, token } = await payment(world, t);

    for (const person of [newPerson(), elsewhere.people[0] as Person]) {
      await refused(
        t.confirm.submitConfirmation(
          envelope.approvalId,
          token,
          assertAt(person, envelope, APPROVAL_ORIGIN),
        ),
        "approver_unknown",
      );
    }
    expect((await t.client.listConfirmationAssertions(envelope.approvalId)).assertions).toEqual([]);
  });

  it("a revoked, signed or expired approval refuses new assertions with confirmation_closed", async () => {
    const t = startSigner();
    const world = await setUpWorld(t, { people: 2 });
    const [alice, bob] = world.people as [Person, Person];

    const revoked = await payment(world, t);
    await t.client.revokeApproval(revoked.envelope.approvalId, world.workspaceId);

    // Signed through the control plane's page while the confirmation was open.
    const signed = await payment(world, t);
    await t.client.sign({
      intent: signed.intent,
      authorization: authorize(signed.envelope, [alice]),
      transaction: txParams(),
    });

    const expired = await payment(world, t);
    t.clock.value = expired.envelope.expiresAt;

    for (const [request, state] of [
      [revoked, "revoked"],
      [signed, "used"],
      [expired, "expired"],
    ] as const) {
      await refused(
        t.confirm.submitConfirmation(
          request.envelope.approvalId,
          request.token,
          assertAt(bob, request.envelope, APPROVAL_ORIGIN),
        ),
        "confirmation_closed",
      );
      expect(
        (await t.confirm.getConfirmation(request.envelope.approvalId, request.token)).state,
      ).toBe(state);
    }
  });

  it("a request the signer can no longer act on is superseded and takes no assertions", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const other = await setUpWorld(t);
    const superseded = async (request: { envelope: Envelope; token: string }, person: Person) => {
      expect(
        (await t.confirm.getConfirmation(request.envelope.approvalId, request.token)).state,
      ).toBe("superseded");
      await refused(
        t.confirm.submitConfirmation(
          request.envelope.approvalId,
          request.token,
          assertAt(person, request.envelope, APPROVAL_ORIGIN),
        ),
        "confirmation_closed",
      );
    };

    // Proposed under a policy that has since been replaced.
    const underOldPolicy = await payment(world, t);
    await replacePolicy(world, { recipients: { mode: "allowlist", addresses: [RECIPIENT] } });
    await superseded(underOldPolicy, world.people[0] as Person);

    // Issued before the signer was restored.
    const beforeFence = await payment(other, t);
    t.clock.value += 1;
    t.signer.fence();
    await superseded(beforeFence, other.people[0] as Person);
  });

  it("each person approves once, and only current approvers count", async () => {
    const t = startSigner();
    const world = await setUpWorld(t, { people: 3, adminThreshold: 2, policyThreshold: 2 });
    const [alice, bob, carol] = world.people as [Person, Person, Person];
    const { envelope, intent, token } = await payment(world, t);
    const submit = (person: Person) =>
      t.confirm.submitConfirmation(
        envelope.approvalId,
        token,
        assertAt(person, envelope, APPROVAL_ORIGIN),
      );

    expect((await submit(bob)).collected).toBe(1);
    await refused(submit(bob), "conflict");
    const waiting = (await t.confirm.getConfirmation(envelope.approvalId, token)).webauthn;
    expect(waiting.allowCredentials.toSorted()).toEqual(
      [alice.credential.credentialId, carol.credential.credentialId].toSorted(),
    );

    // Bob's passkey is removed: his approval no longer counts and is not handed out.
    await t.client.removeApprover(
      world.workspaceId,
      authorize(
        {
          ...header(t.clock, newId("apr"), world.workspaceId),
          type: "remove-approver",
          userId: bob.userId,
          credentialId: bob.credential.credentialId,
        },
        [alice, carol],
      ),
    );
    const view = await t.confirm.getConfirmation(envelope.approvalId, token);
    expect(view.approvals).toEqual({ collected: 0, required: 2 });
    expect((await t.client.listConfirmationAssertions(envelope.approvalId)).assertions).toEqual([]);
    await refused(submit(bob), "approver_unknown");

    expect(await submit(alice)).toMatchObject({ collected: 1, required: 2 });
    t.clock.value += 1;
    expect(await submit(carol)).toMatchObject({ collected: 2, required: 2 });
    await refused(submit(alice), "confirmation_closed");
    const { assertions } = await t.client.listConfirmationAssertions(envelope.approvalId);
    expect(assertions.map((assertion) => assertion.userId)).toEqual([alice.userId, carol.userId]);
    await t.client.sign({
      intent,
      authorization: { envelope, assertions },
      transaction: txParams(),
    });
  });

  it("after 64 submissions for one request, every further one is refused with rate_limited", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [alice] = world.people as [Person];
    const { envelope, subject, token } = await payment(world, t);
    const wrong = assertAt(alice, envelope, ORIGIN);
    for (let attempt = 0; attempt < 64; attempt += 1) {
      await refused(
        t.confirm.submitConfirmation(envelope.approvalId, token, wrong),
        "assertion_invalid",
      );
    }
    await refused(
      t.confirm.submitConfirmation(
        envelope.approvalId,
        token,
        assertAt(alice, envelope, APPROVAL_ORIGIN),
      ),
      "rate_limited",
    );
    // Reopening gives a new link, not new attempts.
    const fresh = await open(t, envelope, subject);
    await refused(
      t.confirm.submitConfirmation(
        envelope.approvalId,
        fresh,
        assertAt(alice, envelope, APPROVAL_ORIGIN),
      ),
      "rate_limited",
    );
  });
});

describe("request secrets", () => {
  it("the confirm secret cannot call the sign route and the control secret cannot call the confirm routes", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [alice] = world.people as [Person];
    const { envelope, subject, intent, token } = await payment(world, t);
    const fetch: typeof globalThis.fetch = (url, init) =>
      Promise.resolve(t.signer.app.request(String(url), init));
    const options = { baseUrl: "http://signer.test", now: t.clock.now, fetch };
    // The approve service's secret, used on the control plane's routes.
    const asControl = createSignerClient({ ...options, secret: t.confirmSecret });
    // The control plane's secret, used on the confirm routes.
    const asConfirm = createConfirmClient({ ...options, secret: t.secret });

    await refused(
      asControl.sign({
        intent,
        authorization: authorize(envelope, [alice]),
        transaction: txParams(),
      }),
      "unauthenticated",
    );
    await refused(
      asControl.openConfirmation(envelope.approvalId, { envelope, subject }),
      "unauthenticated",
    );
    await refused(asControl.listConfirmationAssertions(envelope.approvalId), "unauthenticated");
    await refused(asControl.getWorkspace(world.workspaceId), "unauthenticated");
    await refused(asConfirm.getConfirmation(envelope.approvalId, token), "unauthenticated");
    await refused(
      asConfirm.submitConfirmation(
        envelope.approvalId,
        token,
        assertAt(alice, envelope, APPROVAL_ORIGIN),
      ),
      "unauthenticated",
    );
    await refused(asConfirm.getPossession(envelope.approvalId, token), "unauthenticated");
    await refused(
      asConfirm.submitPossession(
        envelope.approvalId,
        token,
        assertAt(alice, envelope, APPROVAL_ORIGIN),
      ),
      "unauthenticated",
    );

    expect((await t.client.getApproval(envelope.approvalId)).state).toBe("unknown");
    expect((await t.client.listConfirmationAssertions(envelope.approvalId)).assertions).toEqual([]);
  });
});
