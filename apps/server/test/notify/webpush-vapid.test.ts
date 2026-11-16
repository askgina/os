import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { importVapidKey, vapidAuthorization } from "../../src/notify/webpush/vapid.ts";
import { baseEnv } from "./support.ts";

/** A VAPID key file as `init.mjs` writes one: a PKCS#8 PEM. */
function vapidKeyFile(dir: string, namedCurve = "prime256v1"): string {
  const path = join(dir, `vapid-${namedCurve}.pem`);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve });
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }));

  return path;
}

function pushConfig(extra: NodeJS.ProcessEnv) {
  const { env, dir } = baseEnv();

  return loadConfig({
    ...env,
    WEB_PUSH_ENABLED: "1",
    WEB_PUSH_VAPID_KEY_FILE: vapidKeyFile(dir),
    ...extra,
  });
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 JWT that verifies with the public key, for the endpoint's origin, expiring 12 hours from now", async () => {
    const { env, dir } = baseEnv();
    const keyFile = vapidKeyFile(dir);
    const config = loadConfig({ ...env, WEB_PUSH_ENABLED: "1", WEB_PUSH_VAPID_KEY_FILE: keyFile });
    const webPush = config.notify.webPush;

    if (webPush === null) throw new Error("Web Push should be on");
    // An https PUBLIC_ORIGIN is the default subject; the default hosts are the browsers'.
    expect(webPush.subject).toBe("https://os.example.com");
    expect(webPush.endpointHosts).toEqual([
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "push.apple.com",
      "notify.windows.com",
    ]);
    // The application server key is the PEM's public point, uncompressed.
    const jwk = createPublicKey(readFileSync(keyFile, "utf8")).export({ format: "jwk" });
    expect(Buffer.from(webPush.vapidPublicKey).toString("hex")).toBe(
      `04${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}`,
    );

    const now = 1_800_000_000;

    const header = await vapidAuthorization({
      endpoint: new URL("https://fcm.googleapis.com/fcm/send/abc:def?x=1"),
      subject: webPush.subject,
      privateKey: await importVapidKey(webPush.vapidPrivateKey),
      publicKeyRaw: webPush.vapidPublicKey,
      now,
    });

    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);

    if (!match) throw new Error(`not a VAPID header: ${header}`);
    const [, encodedHeader = "", encodedClaims = "", signature = "", key = ""] = match;
    expect(decode(encodedHeader)).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = decode(encodedClaims);
    expect(claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now + 43_200,
      sub: "https://os.example.com",
    });
    expect(claims.exp - now).toBeLessThanOrEqual(86_400);
    expect(Buffer.from(key, "base64url")).toEqual(Buffer.from(webPush.vapidPublicKey));

    const publicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(Buffer.from(key, "base64url")),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const verify = (signed: string) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        new Uint8Array(Buffer.from(signature, "base64url")),
        new TextEncoder().encode(signed),
      );

    expect(await verify(`${encodedHeader}.${encodedClaims}`)).toBe(true);

    const forged = Buffer.from(JSON.stringify({ ...claims, exp: now + 86_400 * 30 })).toString(
      "base64url",
    );

    expect(await verify(`${encodedHeader}.${forged}`)).toBe(false);
  });

  it("refuses a subject that is not mailto: or https:, and needs one when PUBLIC_ORIGIN is not https", () => {
    for (const subject of ["http://os.example.com", "ftp://os.example.com", "ops@example.com"]) {
      expect(() => pushConfig({ WEB_PUSH_SUBJECT: subject })).toThrow(/WEB_PUSH_SUBJECT/);
    }

    expect(pushConfig({ WEB_PUSH_SUBJECT: "mailto:ops@example.com" }).notify.webPush?.subject).toBe(
      "mailto:ops@example.com",
    );

    const local = {
      PUBLIC_ORIGIN: "http://localhost:8080",
      APPROVE_ORIGIN: "http://localhost:8081",
    };

    expect(() => pushConfig(local)).toThrow(/WEB_PUSH_SUBJECT/);
    expect(
      pushConfig({ ...local, WEB_PUSH_SUBJECT: "https://ops.example.com" }).notify.webPush?.subject,
    ).toBe("https://ops.example.com");
  });

  it("is off unless WEB_PUSH_ENABLED=1, and then needs a P-256 key file", () => {
    const { env, dir } = baseEnv();
    expect(loadConfig(env).notify.webPush).toBeNull();
    // Compose passes an unset variable as "".
    expect(loadConfig({ ...env, WEB_PUSH_ENABLED: "" }).notify.webPush).toBeNull();
    expect(loadConfig({ ...env, WEB_PUSH_ENABLED: "0" }).notify.webPush).toBeNull();
    expect(() => loadConfig({ ...env, WEB_PUSH_ENABLED: "yes" })).toThrow(/WEB_PUSH_ENABLED/);
    expect(() => loadConfig({ ...env, WEB_PUSH_ENABLED: "1" })).toThrow(/WEB_PUSH_VAPID_KEY_FILE/);
    expect(() =>
      loadConfig({
        ...env,
        WEB_PUSH_ENABLED: "1",
        WEB_PUSH_VAPID_KEY_FILE: vapidKeyFile(dir, "secp384r1"),
      }),
    ).toThrow(/P-256/);
  });

  it("reads the endpoint host suffixes as a comma list of host names", () => {
    expect(pushConfig({ WEB_PUSH_ENDPOINT_HOSTS: "" }).notify.webPush?.endpointHosts).toHaveLength(
      4,
    );
    expect(
      pushConfig({ WEB_PUSH_ENDPOINT_HOSTS: " push.example.net , web.push.apple.com" }).notify
        .webPush?.endpointHosts,
    ).toEqual(["push.example.net", "web.push.apple.com"]);

    for (const hosts of ["https://push.example.net", "push.example.net/path", ",", "*.example"]) {
      expect(() => pushConfig({ WEB_PUSH_ENDPOINT_HOSTS: hosts })).toThrow(
        /WEB_PUSH_ENDPOINT_HOSTS/,
      );
    }
  });
});
