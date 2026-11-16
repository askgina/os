import { describe, expect, it } from "vitest";
import { encryptPayload, PushEncryptionError } from "../../src/notify/webpush/encrypt.ts";
import { decryptPush } from "./support.ts";

type Bytes = Uint8Array<ArrayBuffer>;

const b64 = (text: string): Bytes =>
  new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "base64url"));

const utf8 = (text: string): Bytes => new TextEncoder().encode(text);

/** RFC 8291 §5 and Appendix A, verbatim (whitespace removed). */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: b64(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ),
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: b64(
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  ),
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  authSecret: b64("BTBZMqHH6r4Tts7J_aSIgg"),
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`.replace(/\s+/g, ""),
};

/** A P-256 key pair from the RFC's base64url private scalar and uncompressed public point. */
async function keyPair(privateScalar: string, publicPoint: Bytes) {
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateScalar,
    x: Buffer.from(publicPoint.subarray(1, 33)).toString("base64url"),
    y: Buffer.from(publicPoint.subarray(33, 65)).toString("base64url"),
  };

  const algorithm = { name: "ECDH", namedCurve: "P-256" };

  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", publicPoint, algorithm, true, []),
  };
}

describe("Web Push encryption (RFC 8291)", () => {
  it("reproduces the RFC 8291 Appendix A body byte for byte from its keys, salt and plaintext", async () => {
    const body = await encryptPayload({
      plaintext: utf8(RFC.plaintext),
      uaPublicKey: RFC.uaPublic,
      authSecret: RFC.authSecret,
      salt: RFC.salt,
      asKeyPair: await keyPair(RFC.asPrivate, RFC.asPublic),
    });

    expect(Buffer.from(body).toString("base64url")).toBe(RFC.body);
    // Header, the plaintext and its delimiter, and the tag. The RFC's example request says
    // `Content-Length: 145`; the body it shows is these 144 bytes.
    expect(body.length).toBe(86 + RFC.plaintext.length + 1 + 16);
  });

  it("refuses a key that is not an uncompressed point on P-256, and an auth secret that is not 16 bytes", async () => {
    const offCurve = new Uint8Array(RFC.uaPublic);
    offCurve[64] = (offCurve[64] ?? 0) ^ 0x01;

    const compressed = new Uint8Array([
      0x02 | ((RFC.uaPublic[64] ?? 0) & 1),
      ...RFC.uaPublic.subarray(1, 33),
    ]);

    for (const uaPublicKey of [
      RFC.uaPublic.subarray(1),
      offCurve,
      compressed,
      new Uint8Array(65),
    ]) {
      await expect(
        encryptPayload({ plaintext: utf8("x"), uaPublicKey, authSecret: RFC.authSecret }),
      ).rejects.toMatchObject({ name: "PushEncryptionError", code: "bad_key" });
    }

    await expect(
      encryptPayload({
        plaintext: utf8("x"),
        uaPublicKey: RFC.uaPublic,
        authSecret: RFC.authSecret.subarray(0, 15),
      }),
    ).rejects.toBeInstanceOf(PushEncryptionError);
  });

  it("pads every message to one length, and the user agent decrypts its own output", async () => {
    const ua = await keyPair(RFC.uaPrivate, RFC.uaPublic);
    const short = '{"web_push":8030}';
    const long = JSON.stringify({ web_push: 8030, notification: { title: "x".repeat(300) } });

    const bodies = await Promise.all(
      [short, long].map((text) =>
        encryptPayload({
          plaintext: utf8(text),
          uaPublicKey: RFC.uaPublic,
          authSecret: RFC.authSecret,
          paddedLength: 512,
        }),
      ),
    );

    // 86 bytes of header, the 512-byte record and the 16-byte tag, whatever the message.
    expect(bodies.map((body) => body.length)).toEqual([614, 614]);
    // A fresh salt and sender key per message.
    expect(Buffer.from(bodies[0] ?? []).subarray(0, 16)).not.toEqual(
      Buffer.from(bodies[1] ?? []).subarray(0, 16),
    );

    const reader = {
      privateKey: ua.privateKey,
      publicKey: RFC.uaPublic,
      authSecret: RFC.authSecret,
    };

    expect(await decryptPush(bodies[0] ?? new Uint8Array(), reader)).toBe(short);
    expect(await decryptPush(bodies[1] ?? new Uint8Array(), reader)).toBe(long);
  });

  it("refuses a message that does not fit its padded length or one record", async () => {
    await expect(
      encryptPayload({
        plaintext: new Uint8Array(512),
        uaPublicKey: RFC.uaPublic,
        authSecret: RFC.authSecret,
        paddedLength: 512,
      }),
    ).rejects.toMatchObject({ code: "too_long" });
    await expect(
      encryptPayload({
        plaintext: new Uint8Array(4080),
        uaPublicKey: RFC.uaPublic,
        authSecret: RFC.authSecret,
      }),
    ).rejects.toMatchObject({ code: "too_long" });
  });
});
