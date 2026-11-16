import {
  type AddApproverEnvelope,
  type ApproverCredential,
  AssertionResponse,
  type ConfirmationView,
  type Envelope,
  envelopeChallenge,
  keyFingerprint,
  newId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { b64url } from "@askgina/os-protocol/testing";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ORIGIN,
  answerPossession,
  approveIntent,
  authorize,
  header,
  intentFor,
  newNonce,
  newPerson,
  ORIGIN,
  type Person,
  RP_ID,
  refused,
  setUpWorld,
  startSigner,
  type TestSigner,
  type World,
} from "./harness.ts";

/** An approver change that adds `credential` to `world`'s workspace. */
function addApprover(world: World, credential: ApproverCredential): AddApproverEnvelope {
  return {
    ...header(world.t.clock, newId("apr"), world.workspaceId),
    type: "add-approver",
    ...credential,
  };
}

/** Open the confirmation page of `envelope` and return its token. */
async function open(t: TestSigner, envelope: Envelope): Promise<string> {
  const { path } = await t.client.openConfirmation(envelope.approvalId, {
    envelope,
    subject: { kind: "envelope-only" },
  });

  return path.slice(path.indexOf("#") + 1);
}

/** What a browser sends after `person` approved `envelope` on the confirmation page. */
function approvalOf(person: Person, envelope: Envelope): AssertionResponse {
  return AssertionResponse.parse(
    person.authenticator.authenticate({
      credentialId: person.credential.credentialId,
      challenge: b64url(envelopeChallenge(envelope)),
      origin: APPROVAL_ORIGIN,
    }),
  );
}

const lineOf = (view: ConfirmationView, label: string) =>
  view.lines.find((line) => line.label === label)?.value;

const PROVEN = "The new person proved they hold this passkey";

describe("proof of possession of a new approver's passkey", () => {
  it("an approver change is refused until possession is proven", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [alice] = world.people as [Person];
    const carol = newPerson();
    const envelope = addApprover(world, carol.credential);
    const id = envelope.approvalId;

    const apply = (authorization = authorize(envelope, [alice])) =>
      t.client.addApprover(world.workspaceId, { authorization });

    // With no confirmation page at all, approvals sent straight to the signer add no one.
    await refused(apply(), "possession_unproven");

    // The page shows the key's fingerprint and that nobody proved holding it, and takes no
    // approval until someone does.
    const token = await open(t, envelope);
    const before = await t.confirm.getConfirmation(id, token);
    expect(before.state).toBe("open");
    expect(before.warnings).toEqual(["possession_unproven"]);
    expect(lineOf(before, "Key fingerprint")).toBe(keyFingerprint(carol.credential.publicKey));
    expect(lineOf(before, PROVEN)).toBe("no");
    await refused(
      t.confirm.submitConfirmation(id, token, approvalOf(alice, envelope)),
      "possession_unproven",
    );
    expect((await t.client.listConfirmationAssertions(id)).assertions).toEqual([]);
    await refused(apply(), "possession_unproven");

    const refusals = (await t.client.listDecisions(world.workspaceId)).decisions.filter(
      (decision) => decision.action === "add-approver",
    );

    expect(refusals.map((decision) => [decision.outcome, decision.code])).toEqual([
      ["denied", "possession_unproven"],
      ["denied", "possession_unproven"],
    ]);

    // Carol answers with the passkey being added. Only that passkey is asked, over a challenge
    // that is not the envelope's, and the page shows her the fingerprint to read out.
    const options = await t.confirm.getPossession(id, token);
    expect(options).toMatchObject({
      rpId: RP_ID,
      allowCredentials: [carol.credential.credentialId],
      userVerification: "required",
      timeoutMs: 120_000,
    });
    expect(options.challenge).not.toBe(b64url(envelopeChallenge(envelope)));
    expect(await t.confirm.submitPossession(id, token, answerPossession(carol, options))).toEqual({
      fingerprint: keyFingerprint(carol.credential.publicKey),
    });
    const after = await t.confirm.getConfirmation(id, token);
    expect(after.warnings).toEqual([]);
    expect(lineOf(after, PROVEN)).toBe("yes");

    // The proof belongs to this exact envelope: not to another envelope under the same id,
    // nor to another request for the same key.
    await refused(
      apply(authorize({ ...envelope, nonce: newNonce() }, [alice])),
      "possession_unproven",
    );
    const again = addApprover(world, carol.credential);
    const againToken = await open(t, again);
    expect((await t.confirm.getConfirmation(again.approvalId, againToken)).warnings).toEqual([
      "possession_unproven",
    ]);
    await refused(
      t.client.addApprover(world.workspaceId, { authorization: authorize(again, [alice]) }),
      "possession_unproven",
    );

    // Now Alice's approval on the page is taken, and the signer adds Carol with it.
    expect(
      await t.confirm.submitConfirmation(id, token, approvalOf(alice, envelope)),
    ).toMatchObject({ collected: 1, required: 1 });
    const { assertions } = await t.client.listConfirmationAssertions(id);
    const state = await apply({ envelope, assertions });
    expect(state.approvers.map((approver) => approver.credentialId)).toContain(
      carol.credential.credentialId,
    );
    expect((await t.confirm.getConfirmation(id, token)).state).toBe("used");
  });

  it("a passkey other than the envelope's cannot prove possession", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const [alice] = world.people as [Person];
    const carol = newPerson();
    const mallory = newPerson();
    const envelope = addApprover(world, carol.credential);
    const id = envelope.approvalId;
    const token = await open(t, envelope);

    const prove = async (answer: (options: { challenge: string }) => AssertionResponse) =>
      t.confirm.submitPossession(id, token, answer(await t.confirm.getPossession(id, token)));

    /** Mallory's answer, labelled with Carol's credential id as if it came from her passkey. */
    const relabelled = (options: { challenge: string }): AssertionResponse => {
      const answer = answerPossession(mallory, options);

      return { ...answer, id: carol.credential.credentialId, rawId: carol.credential.credentialId };
    };

    await refused(
      prove((options) => answerPossession(mallory, options)),
      "assertion_invalid",
    );
    await refused(prove(relabelled), "assertion_invalid");
    // An approver of the workspace cannot prove it for the newcomer either.
    await refused(
      prove((options) => answerPossession(alice, options)),
      "assertion_invalid",
    );
    expect((await t.confirm.getConfirmation(id, token)).warnings).toEqual(["possession_unproven"]);
    await refused(
      t.client.addApprover(world.workspaceId, { authorization: authorize(envelope, [alice]) }),
      "possession_unproven",
    );

    // A request that carries Carol's credential id with a key Mallory chose, as a compromised
    // control plane would send: Carol's own passkey cannot prove it.
    const swapped = addApprover(world, {
      ...carol.credential,
      publicKey: mallory.credential.publicKey,
    });

    const swappedToken = await open(t, swapped);
    const options = await t.confirm.getPossession(swapped.approvalId, swappedToken);
    expect(options.allowCredentials).toEqual([carol.credential.credentialId]);
    await refused(
      t.confirm.submitPossession(
        swapped.approvalId,
        swappedToken,
        answerPossession(carol, options),
      ),
      "assertion_invalid",
    );

    // Mallory holds that key and can prove it. What gives the swap away is the fingerprint:
    // the page shows her key's, not the one Carol reads from her own page.
    const proven = await t.confirm.submitPossession(
      swapped.approvalId,
      swappedToken,
      relabelled(await t.confirm.getPossession(swapped.approvalId, swappedToken)),
    );

    expect(proven.fingerprint).toBe(keyFingerprint(mallory.credential.publicKey));
    expect(proven.fingerprint).not.toBe(keyFingerprint(carol.credential.publicKey));
    const shown = await t.confirm.getConfirmation(swapped.approvalId, swappedToken);
    expect(lineOf(shown, "Key fingerprint")).toBe(proven.fingerprint);
  });

  it("possession proven on another origin is refused", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const carol = newPerson();
    const envelope = addApprover(world, carol.credential);
    const id = envelope.approvalId;
    const token = await open(t, envelope);

    const attempt = async (
      overrides: Parameters<typeof answerPossession>[2],
      options?: { challenge: string },
    ) =>
      t.confirm.submitPossession(
        id,
        token,
        answerPossession(carol, options ?? (await t.confirm.getPossession(id, token)), overrides),
      );

    const elsewhere = [
      // The control plane's page, which uses the same RP ID.
      ["the control plane's page", { origin: ORIGIN }],
      // Another host under the RP ID, and the approval host over the other scheme.
      ["another host", { origin: "http://evil.localhost:8081" }],
      ["another scheme", { origin: "https://localhost:8081" }],
      // The approval origin, but inside a frame of another page.
      ["a frame", { crossOrigin: true }],
      ["a frame with a top origin", { topOrigin: ORIGIN }],
      // Correctly signed, but not an assertion, or without user verification.
      ["a registration", { clientDataType: "webauthn.create" }],
      ["no user verification", { flags: { uv: false } }],
    ] as const;

    const outcomes: [string, string][] = [];

    for (const [where, overrides] of elsewhere) {
      const code = await attempt(overrides).then(
        () => "accepted",
        (error: unknown) => (error instanceof SignerError ? error.code : String(error)),
      );

      outcomes.push([where, code]);
    }

    expect(outcomes).toEqual(elsewhere.map(([where]) => [where, "assertion_invalid"]));
    // The envelope's own challenge (an approval, not a proof) does not count.
    await refused(
      attempt({}, { challenge: b64url(envelopeChallenge(envelope)) }),
      "assertion_invalid",
    );
    // Refused answers used nothing: every page open on the request gets the same challenge
    // until an answer uses it.
    const challenge = await t.confirm.getPossession(id, token);
    expect((await t.confirm.getPossession(id, token)).challenge).toBe(challenge.challenge);
    expect((await t.confirm.getConfirmation(id, token)).warnings).toEqual(["possession_unproven"]);

    expect(await attempt({}, challenge)).toEqual({
      fingerprint: keyFingerprint(carol.credential.publicKey),
    });
    expect((await t.confirm.getConfirmation(id, token)).warnings).toEqual([]);
    // A challenge is answered once, and the next one is new.
    await refused(attempt({}, challenge), "assertion_invalid");
    expect((await t.confirm.getPossession(id, token)).challenge).not.toBe(challenge.challenge);
  });

  it("only an approver change that can still be applied has a possession step", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const carol = newPerson();

    // A payment has none.
    const intent = intentFor(world);
    const { envelope: payment } = approveIntent(world, intent, { people: [] });

    const { path } = await t.client.openConfirmation(payment.approvalId, {
      envelope: payment,
      subject: { kind: "approve-intent", intent },
    });

    const paymentToken = path.slice(path.indexOf("#") + 1);
    await refused(t.confirm.getPossession(payment.approvalId, paymentToken), "not_found");
    await refused(
      t.confirm.submitPossession(
        payment.approvalId,
        paymentToken,
        approvalOf(world.people[0] as Person, payment),
      ),
      "not_found",
    );

    // A wrong token reaches nothing.
    const rejected = addApprover(world, carol.credential);
    const token = await open(t, rejected);
    await refused(t.confirm.getPossession(rejected.approvalId, "A".repeat(22)), "not_found");

    // A rejected request, and one that expired.
    const options = await t.confirm.getPossession(rejected.approvalId, token);
    await t.client.revokeApproval(rejected.approvalId, world.workspaceId);
    await refused(t.confirm.getPossession(rejected.approvalId, token), "confirmation_closed");
    await refused(
      t.confirm.submitPossession(rejected.approvalId, token, answerPossession(carol, options)),
      "confirmation_closed",
    );
    const expiring = addApprover(world, carol.credential);
    const expiringToken = await open(t, expiring);
    t.clock.value = expiring.expiresAt;
    await refused(
      t.confirm.getPossession(expiring.approvalId, expiringToken),
      "confirmation_closed",
    );
  });

  it("answers to the possession step count toward the 64 submissions of a request", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const carol = newPerson();
    const envelope = addApprover(world, carol.credential);
    const token = await open(t, envelope);
    const options = await t.confirm.getPossession(envelope.approvalId, token);
    const wrong = answerPossession(carol, options, { origin: ORIGIN });

    for (let attempt = 0; attempt < 64; attempt += 1) {
      await refused(
        t.confirm.submitPossession(envelope.approvalId, token, wrong),
        "assertion_invalid",
      );
    }

    await refused(
      t.confirm.submitPossession(envelope.approvalId, token, answerPossession(carol, options)),
      "rate_limited",
    );
  });

  it("the host operator still enrolls an approver with no possession step", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const replacement = newPerson();
    t.signer.enrollApproverByOperator(world.workspaceId, replacement.credential);
    const state = await t.client.getWorkspace(world.workspaceId);
    expect(state.approvers.map((approver) => approver.credentialId)).toContain(
      replacement.credential.credentialId,
    );
  });
});
