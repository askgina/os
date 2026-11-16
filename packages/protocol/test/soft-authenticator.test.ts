import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { b64url, fromB64url, SoftAuthenticator, tamperClientData } from "../src/testing/index.ts";

const RP_ID = "localhost";

const ORIGIN = "http://localhost:3000";

const challenge = b64url(new Uint8Array(32).fill(1));

function flagsAndCounter(authenticatorData: string) {
  const bytes = fromB64url(authenticatorData);

  return {
    flags: bytes[32] ?? 0,
    counter: new DataView(bytes.buffer, bytes.byteOffset).getUint32(33),
  };
}

async function registered(device: SoftAuthenticator) {
  const { response, credential } = device.register({ rpId: RP_ID, challenge, origin: ORIGIN });

  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });

  if (!result.verified) throw new Error("registration did not verify");

  return { credential, info: result.registrationInfo };
}

describe("soft authenticator", () => {
  it("registrations verify with the real library and report backup state", async () => {
    const { info } = await registered(new SoftAuthenticator());
    expect(info.credentialDeviceType).toBe("singleDevice");
    const synced = await registered(new SoftAuthenticator({ flags: { be: true, bs: true } }));
    expect(synced.info.credentialDeviceType).toBe("multiDevice");
    expect(synced.info.credentialBackedUp).toBe(true);
  });

  it("assertions verify; counters increase unless the device models a synced passkey", async () => {
    const device = new SoftAuthenticator();
    const { credential, info } = await registered(device);
    const id = b64url(credential.id);
    const first = device.authenticate({ credentialId: id, challenge, origin: ORIGIN });
    const second = device.authenticate({ credentialId: id, challenge, origin: ORIGIN });
    expect(flagsAndCounter(first.response.authenticatorData).counter).toBe(1);
    expect(flagsAndCounter(second.response.authenticatorData).counter).toBe(2);

    const result = await verifyAuthenticationResponse({
      response: second,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: { id, publicKey: info.credential.publicKey, counter: 1 },
      requireUserVerification: true,
    });

    expect(result.verified).toBe(true);

    const synced = new SoftAuthenticator({ incrementCounter: false });
    const s = await registered(synced);

    const a = synced.authenticate({
      credentialId: b64url(s.credential.id),
      challenge,
      origin: ORIGIN,
    });

    expect(flagsAndCounter(a.response.authenticatorData).counter).toBe(0);
  });

  it("flags follow the defaults and per-call overrides", () => {
    const device = new SoftAuthenticator({ flags: { uv: false } });
    const { credential } = device.register({ rpId: RP_ID, challenge, origin: ORIGIN });
    const id = b64url(credential.id);
    const plain = device.authenticate({ credentialId: id, challenge });
    expect(flagsAndCounter(plain.response.authenticatorData).flags & 0x04).toBe(0);
    const verified = device.authenticate({ credentialId: id, challenge, flags: { uv: true } });
    expect(flagsAndCounter(verified.response.authenticatorData).flags & 0x05).toBe(0x05);
    const pinned = device.authenticate({ credentialId: id, challenge, signCount: 41 });
    expect(flagsAndCounter(pinned.response.authenticatorData).counter).toBe(41);
  });

  it("the tampering helper keeps the old signature, so the result no longer verifies", async () => {
    const device = new SoftAuthenticator();
    const { credential, info } = await registered(device);
    const id = b64url(credential.id);
    const real = device.authenticate({ credentialId: id, challenge, origin: ORIGIN });
    const other = b64url(new Uint8Array(32).fill(2));
    const tampered = tamperClientData(real, { challenge: other });
    expect(tampered.response.signature).toBe(real.response.signature);
    await expect(
      verifyAuthenticationResponse({
        response: tampered,
        expectedChallenge: other,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id, publicKey: info.credential.publicKey, counter: 0 },
      }).then(
        (r) => r.verified,
        () => false,
      ),
    ).resolves.toBe(false);
  });

  it("refuses to sign with a credential it does not hold", () => {
    expect(() =>
      new SoftAuthenticator().authenticate({ credentialId: "bm9wZQ", challenge }),
    ).toThrow();
  });
});
