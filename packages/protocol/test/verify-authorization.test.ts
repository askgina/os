import { beforeEach, describe, expect, it } from "vitest";
import {
  type ApproverCredential,
  type Assertion,
  AssertionResponse,
  type Envelope,
  envelopeChallenge,
  possessionChallenge,
  type UserId,
} from "../src/index.ts";
import {
  approverCredentialOf,
  assertEnvelope,
  b64url,
  SoftAuthenticator,
  tamperClientData,
} from "../src/testing/index.ts";
import {
  AUTHORIZATION_FAILURES,
  type AuthorizationVerdict,
  CLOCK_SKEW_SECONDS,
  type RelyingParty,
  verifyAuthorization,
  verifyPossession,
} from "../src/webauthn/index.ts";
import {
  APPROVAL,
  approveIntent,
  changedEnvelopes,
  envelopeVariants,
  T0,
  USER_A,
  USER_B,
  USER_C,
} from "./fixtures.ts";

/** The confirmation page, where approvals are made: a name under the RP ID. */
const ORIGIN = "https://approve.os.example.com";
/** The control plane's page: the same RP ID, so its passkey prompts work, but not an approval origin. */
const CONTROL_PLANE = "https://os.example.com";
const RP: RelyingParty = { id: "os.example.com", origins: [ORIGIN] };

type Person = { userId: UserId; device: SoftAuthenticator; credential: ApproverCredential };

function enroll(userId: UserId, device = new SoftAuthenticator()): Person {
  const { credential } = device.register({ rpId: RP.id, challenge: "c2V0dXA" });
  return { userId, device, credential: approverCredentialOf(userId, credential) };
}

function sign(person: Person, envelope: Envelope, origin = ORIGIN): Assertion {
  return assertEnvelope(person.device, {
    userId: person.userId,
    credentialId: person.credential.credentialId,
    envelope,
    origin,
  });
}

let alice: Person;
let bob: Person;
let carol: Person;
beforeEach(() => {
  alice = enroll(USER_A);
  bob = enroll(USER_B);
  carol = enroll(USER_C);
});

function verify(
  envelope: Envelope,
  assertions: Assertion[],
  options: {
    threshold?: number;
    now?: number;
    maxTtl?: number;
    approvers?: ApproverCredential[];
    rp?: RelyingParty;
  } = {},
): Promise<AuthorizationVerdict> {
  return verifyAuthorization({
    authorization: { envelope, assertions },
    approvers: options.approvers ?? [alice.credential, bob.credential, carol.credential],
    relyingParty: options.rp ?? RP,
    threshold: options.threshold ?? 1,
    maxTtlSeconds: options.maxTtl ?? 3600,
    now: options.now ?? T0 + 10,
  });
}

const codeOf = (verdict: AuthorizationVerdict) => (verdict.ok ? "ok" : verdict.code);

describe("valid authorizations", () => {
  it("one person", async () => {
    const envelope = approveIntent();
    expect(await verify(envelope, [sign(alice, envelope)])).toEqual({
      ok: true,
      approvedBy: [USER_A],
    });
  });

  it("several people meeting a threshold", async () => {
    const envelope = approveIntent();
    const verdict = await verify(envelope, [sign(alice, envelope), sign(bob, envelope)], {
      threshold: 2,
    });
    expect(verdict).toEqual({ ok: true, approvedBy: [USER_A, USER_B] });
  });

  it("every envelope type", async () => {
    for (const { base } of envelopeVariants) {
      expect(codeOf(await verify(base, [sign(alice, base)]))).toBe("ok");
    }
  });

  // Synced passkeys always report counter 0. The verifier must accept the same counter twice;
  // what stops a replay of one envelope is the caller consuming its nonce, not this function.
  it("a synced passkey with counter 0 verifies every time; replay protection is the caller's nonce", async () => {
    const synced = enroll(
      USER_A,
      new SoftAuthenticator({ incrementCounter: false, flags: { be: true, bs: true } }),
    );
    const envelope = approveIntent();
    const first = sign(synced, envelope);
    const second = sign(synced, envelope);
    const approvers = [synced.credential];
    expect(codeOf(await verify(envelope, [first], { approvers }))).toBe("ok");
    expect(codeOf(await verify(envelope, [second], { approvers }))).toBe("ok");
    // The identical assertion, replayed, also verifies.
    expect(codeOf(await verify(envelope, [first], { approvers }))).toBe("ok");
  });
});

describe("an assertion is bound to its exact envelope", () => {
  for (const variant of envelopeVariants) {
    it(`${variant.name}: changing any one field invalidates it`, async () => {
      const assertion = sign(alice, variant.base);
      for (const { field, envelope } of changedEnvelopes(variant)) {
        // Shift the clock with the timestamps so only the binding is under test.
        const verdict = await verify(envelope, [assertion], { now: T0 + 10 });
        expect([field, codeOf(verdict)]).toEqual([field, "assertion_invalid"]);
      }
    });
  }

  it("an approval for one type cannot be used as another", async () => {
    const [first, second] = envelopeVariants;
    if (!first || !second) throw new Error("fixture");
    expect(codeOf(await verify(second.base, [sign(alice, first.base)]))).toBe("assertion_invalid");
  });
});

/** An assertion over `envelope` with the client data a browser would write in other situations. */
function signWith(
  person: Person,
  envelope: Envelope,
  clientData: { origin?: string; crossOrigin?: boolean; topOrigin?: string; type?: string },
): Assertion {
  return {
    userId: person.userId,
    credentialId: person.credential.credentialId,
    response: AssertionResponse.parse(
      person.device.authenticate({
        credentialId: person.credential.credentialId,
        challenge: b64url(envelopeChallenge(envelope)),
        origin: clientData.origin ?? ORIGIN,
        ...(clientData.crossOrigin === undefined ? {} : { crossOrigin: clientData.crossOrigin }),
        ...(clientData.topOrigin === undefined ? {} : { topOrigin: clientData.topOrigin }),
        ...(clientData.type === undefined ? {} : { clientDataType: clientData.type }),
      }),
    ),
  };
}

describe("relying party and authenticator checks", () => {
  it("an assertion from an origin outside the approval origins is refused", async () => {
    // Every envelope kind: a payment, and the admin changes that grant lasting control.
    for (const { name, base } of envelopeVariants) {
      for (const origin of [CONTROL_PLANE, "https://evil.example.com", `${ORIGIN}:8443`]) {
        const verdict = await verify(base, [sign(alice, base, origin)]);
        expect([name, origin, codeOf(verdict)]).toEqual([name, origin, "assertion_invalid"]);
      }
      // The same passkey on the confirmation page: accepted.
      expect([name, codeOf(await verify(base, [sign(alice, base)]))]).toEqual([name, "ok"]);
    }
  });

  it("an assertion with crossOrigin true is refused", async () => {
    const envelope = approveIntent();
    // A page that frames the confirmation page gets the confirmation page's origin stamped in,
    // and the browser says so only with these two members.
    for (const clientData of [
      { crossOrigin: true },
      { crossOrigin: true, topOrigin: "https://evil.example.com" },
      { crossOrigin: false, topOrigin: CONTROL_PLANE },
    ]) {
      const verdict = await verify(envelope, [signWith(alice, envelope, clientData)]);
      expect([clientData, codeOf(verdict)]).toEqual([clientData, "assertion_invalid"]);
    }
    // One framed assertion fails the whole authorization, even beside a good one.
    const framed = signWith(bob, envelope, { crossOrigin: true });
    expect(codeOf(await verify(envelope, [sign(alice, envelope), framed], { threshold: 2 }))).toBe(
      "assertion_invalid",
    );
    expect(
      codeOf(await verify(envelope, [signWith(alice, envelope, { crossOrigin: false })])),
    ).toBe("ok");
  });

  it("a signed assertion of another type than webauthn.get is refused", async () => {
    const envelope = approveIntent();
    for (const type of ["webauthn.create", "payment.get"]) {
      const verdict = await verify(envelope, [signWith(alice, envelope, { type })]);
      expect([type, codeOf(verdict)]).toEqual([type, "assertion_invalid"]);
    }
  });

  it("an origin on the allowed list other than the first is accepted", async () => {
    const envelope = approveIntent();
    const rp = { id: RP.id, origins: [ORIGIN, "https://os.example.com:8443"] };
    const assertion = sign(alice, envelope, "https://os.example.com:8443");
    expect(codeOf(await verify(envelope, [assertion], { rp }))).toBe("ok");
  });

  it("wrong RP id hash in authenticator data", async () => {
    const envelope = approveIntent();
    const assertion: Assertion = {
      userId: USER_A,
      credentialId: alice.credential.credentialId,
      response: AssertionResponse.parse(
        alice.device.authenticate({
          credentialId: alice.credential.credentialId,
          challenge: b64url(envelopeChallenge(envelope)),
          origin: ORIGIN,
          rpIdHashOf: "evil.example.com",
        }),
      ),
    };
    expect(codeOf(await verify(envelope, [assertion]))).toBe("assertion_invalid");
    // Even a correctly signed assertion for another RP id fails.
    const otherRp = enroll(USER_A);
    const signed = assertEnvelope(otherRp.device, {
      userId: USER_A,
      credentialId: otherRp.credential.credentialId,
      envelope,
      origin: ORIGIN,
    });
    expect(
      codeOf(
        await verify(envelope, [signed], {
          approvers: [otherRp.credential],
          rp: { id: "other.example.com", origins: [ORIGIN] },
        }),
      ),
    ).toBe("assertion_invalid");
  });

  it("user verification flag unset", async () => {
    const device = new SoftAuthenticator({ flags: { uv: false } });
    const person = enroll(USER_A, device);
    const envelope = approveIntent();
    expect(
      codeOf(await verify(envelope, [sign(person, envelope)], { approvers: [person.credential] })),
    ).toBe("assertion_invalid");
  });

  it("a challenge swapped in clientDataJSON without re-signing", async () => {
    const envelope = approveIntent();
    const other = approveIntent({ nonce: "BAAAAAAAAAAAAAAAAAAAAA" });
    const assertion = sign(alice, other);
    const challenge = b64url(envelopeChallenge(envelope));
    const tampered: Assertion = {
      ...assertion,
      response: tamperClientData(assertion.response as never, { challenge }) as never,
    };
    expect(codeOf(await verify(envelope, [tampered]))).toBe("assertion_invalid");
  });
});

describe("approvers", () => {
  it("a second assertion from the same person does not count twice", async () => {
    const envelope = approveIntent();
    const secondKey = enroll(USER_A);
    const verdict = await verify(envelope, [sign(alice, envelope), sign(secondKey, envelope)], {
      threshold: 2,
      approvers: [alice.credential, secondKey.credential, bob.credential],
    });
    expect(codeOf(verdict)).toBe("assertion_invalid");
    // The same assertion submitted twice is refused too.
    const once = sign(alice, envelope);
    expect(codeOf(await verify(envelope, [once, once], { threshold: 2 }))).toBe(
      "assertion_invalid",
    );
  });

  it("an assertion labelled with another approver's ids", async () => {
    const envelope = approveIntent();
    const real = sign(alice, envelope);
    // Claims to be Bob, using Bob's registered ids, but the signature is Alice's.
    const relabelled: Assertion = {
      ...real,
      userId: USER_B,
      credentialId: bob.credential.credentialId,
    };
    expect(codeOf(await verify(envelope, [relabelled]))).toBe("assertion_invalid");
    // Bob's user id with Alice's credential id is not a registered pair.
    expect(codeOf(await verify(envelope, [{ ...real, userId: USER_B }]))).toBe("approver_unknown");
  });

  it("unknown approver, and one unknown approver fails the whole authorization", async () => {
    const envelope = approveIntent();
    const stranger = enroll(USER_C);
    expect(
      codeOf(
        await verify(envelope, [sign(alice, envelope), sign(stranger, envelope)], {
          approvers: [alice.credential],
        }),
      ),
    ).toBe("approver_unknown");
  });

  it("threshold above the number of assertions", async () => {
    const envelope = approveIntent();
    const verdict = await verify(envelope, [sign(alice, envelope), sign(bob, envelope)], {
      threshold: 3,
    });
    expect(codeOf(verdict)).toBe("insufficient_approvals");
  });
});

describe("time", () => {
  const envelope = approveIntent(); // issuedAt T0, expiresAt T0 + 600

  it("issuedAt may be at most the allowed skew ahead of the clock", async () => {
    const assertion = sign(alice, envelope);
    expect(codeOf(await verify(envelope, [assertion], { now: T0 - CLOCK_SKEW_SECONDS }))).toBe(
      "ok",
    );
    expect(codeOf(await verify(envelope, [assertion], { now: T0 - CLOCK_SKEW_SECONDS - 1 }))).toBe(
      "envelope_not_yet_valid",
    );
  });

  it("expires at exactly expiresAt", async () => {
    const assertion = sign(alice, envelope);
    expect(codeOf(await verify(envelope, [assertion], { now: T0 + 599 }))).toBe("ok");
    expect(codeOf(await verify(envelope, [assertion], { now: T0 + 600 }))).toBe("envelope_expired");
  });

  it("lifetime above the maximum", async () => {
    const assertion = sign(alice, envelope);
    expect(codeOf(await verify(envelope, [assertion], { maxTtl: 600 }))).toBe("ok");
    expect(codeOf(await verify(envelope, [assertion], { maxTtl: 599 }))).toBe(
      "envelope_ttl_too_long",
    );
  });

  it("time checks run before any signature is examined", async () => {
    const assertion = { ...sign(alice, envelope), userId: USER_C };
    expect(codeOf(await verify(envelope, [assertion], { now: T0 + 600 }))).toBe("envelope_expired");
  });
});

describe("possession of a new approver's passkey", () => {
  const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
  const possessionOf = (person: Person) => ({
    approvalId: APPROVAL,
    credentialId: person.credential.credentialId,
    nonce: NONCE,
  });
  const answer = (
    person: Person,
    overrides: { origin?: string; crossOrigin?: boolean; challenge?: string } = {},
  ) =>
    AssertionResponse.parse(
      person.device.authenticate({
        credentialId: person.credential.credentialId,
        challenge: b64url(possessionChallenge(possessionOf(person))),
        origin: ORIGIN,
        ...overrides,
      }),
    );
  const check = (
    person: Person,
    response: AssertionResponse,
    publicKey = person.credential.publicKey,
  ) =>
    verifyPossession({
      possession: possessionOf(person),
      publicKey,
      response,
      relyingParty: RP,
    });

  it("the passkey being added answers its challenge on the confirmation page", async () => {
    expect(await check(alice, answer(alice))).toEqual({ ok: true });
  });

  it("another passkey, another key or another challenge proves nothing", async () => {
    const results = [
      // Bob's passkey, under its own id.
      await check(alice, answer(bob)),
      // Bob's signature labelled with Alice's credential id.
      await check(alice, { ...answer(bob), id: alice.credential.credentialId }),
      // Alice's passkey, but the request carries Bob's key under her id.
      await check(alice, answer(alice), bob.credential.publicKey),
      // An approval of an envelope is not a proof of possession.
      await check(alice, answer(alice, { challenge: b64url(envelopeChallenge(approveIntent())) })),
      // Another nonce.
      await check(
        alice,
        answer(alice, {
          challenge: b64url(
            possessionChallenge({ ...possessionOf(alice), nonce: "AAAAAAAAAAAAAAAAAAAAAQ" }),
          ),
        }),
      ),
    ];
    expect(results.map((result) => (result.ok ? "ok" : result.code))).toEqual(
      Array(results.length).fill("assertion_invalid"),
    );
  });

  it("a proof made on the control plane's page or in a frame is refused", async () => {
    for (const overrides of [{ origin: CONTROL_PLANE }, { crossOrigin: true }]) {
      expect(await check(alice, answer(alice, overrides))).toMatchObject({
        ok: false,
        code: "assertion_invalid",
      });
    }
  });
});

it("every failure code has a test above", () => {
  expect([...AUTHORIZATION_FAILURES].sort()).toEqual(
    [
      "approver_unknown",
      "assertion_invalid",
      "envelope_expired",
      "envelope_not_yet_valid",
      "envelope_ttl_too_long",
      "insufficient_approvals",
    ].sort(),
  );
});
