import { beforeEach, describe, expect, it } from "vitest";
import {
  type ApproverCredential,
  type Assertion,
  AssertionResponse,
  type Envelope,
  envelopeChallenge,
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
} from "../src/webauthn/index.ts";
import {
  approveIntent,
  changedEnvelopes,
  envelopeVariants,
  T0,
  USER_A,
  USER_B,
  USER_C,
} from "./fixtures.ts";

const RP: RelyingParty = { id: "os.example.com", origins: ["https://os.example.com"] };
const ORIGIN = "https://os.example.com";

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

describe("relying party and authenticator checks", () => {
  it("wrong origin", async () => {
    const envelope = approveIntent();
    const assertion = sign(alice, envelope, "https://evil.example.com");
    expect(codeOf(await verify(envelope, [assertion]))).toBe("assertion_invalid");
  });

  it("an origin on the allowed list other than the first is accepted", async () => {
    const envelope = approveIntent();
    const rp = { id: RP.id, origins: [ORIGIN, "https://approve.os.example.com"] };
    const assertion = sign(alice, envelope, "https://approve.os.example.com");
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
