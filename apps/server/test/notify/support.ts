import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { type Config, loadConfig } from "../../src/config.ts";

/** One request a receiver got, as it arrived. */
export interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** How a receiver answers one request. */
export interface Answer {
  status: number;
  headers?: Record<string, string>;
  /** Wait this long before answering. */
  delayMs?: number;
}

/** A local HTTP server standing in for an operator's webhook receiver. */
export interface Receiver {
  url: string;
  requests: Received[];
  /** Queue answers for the next requests, in order; once they are used up it answers 200. */
  answer(...answers: Answer[]): void;
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const requests: Received[] = [];
  const queue: Answer[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      const answer = queue.shift() ?? { status: 200 };
      setTimeout(() => {
        response.writeHead(answer.status, answer.headers ?? {});
        response.end("receiver body that must never be stored");
      }, answer.delayMs ?? 0);
    });
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    answer: (...answers) => {
      queue.push(...answers);
    },
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));

      return closed.promise;
    },
  };
}

/** A webhook secret as `init.mjs` makes one: 32 random bytes, base64url. */
export function webhookSecret(): Uint8Array {
  return new Uint8Array(Buffer.from(randomBytes(32).toString("base64url"), "utf8"));
}

/** What a receiver computes to check `x-os-signature`. */
export function expectedSignature(secret: Uint8Array, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Each way a marker could be carried in a text: as itself, as hex, and as base64(url). */
export function markerForms(marker: string): string[] {
  const bytes = Buffer.from(marker, "utf8");

  return [marker, bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")];
}

type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = (text: string): Bytes => new TextEncoder().encode(text);

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);

  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

/** What only the browser holds of its subscription: its ECDH private key, public key and secret. */
export interface BrowserKeys {
  privateKey: CryptoKey;
  publicKey: Bytes;
  authSecret: Bytes;
}

/**
 * What a user agent does with a pushed body (RFC 8291 §3, RFC 8188), written apart from the
 * sender: read the header, derive the keys with its own private key, decrypt the one record,
 * then strip the zero padding and the 0x02 delimiter. Throws when anything does not hold.
 */
export async function decryptPush(body: Bytes, ua: BrowserKeys): Promise<string> {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);

  if (recordSize !== 4096 || record.length > recordSize) throw new Error("not one 4096 record");

  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );

  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256),
  );

  const keyInfo = new Uint8Array([...utf8("WebPush: info\0"), ...ua.publicKey, ...asPublic]);
  const ikm = await hkdf(ua.authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);

  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, record),
  );

  let end = padded.length - 1;

  while (end >= 0 && padded[end] === 0) end -= 1;

  if (padded[end] !== 0x02) throw new Error("no padding delimiter");

  return new TextDecoder().decode(padded.subarray(0, end));
}

/** One message a push service got, as it arrived. */
export interface Pushed {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Uint8Array<ArrayBuffer>;
}

/** A push service of our own, over HTTPS on `localhost` with a certificate this process trusts. */
export interface PushService {
  /** `https://localhost:<port>`. */
  origin: string;
  pushed: Pushed[];
  /** Queue answers for the next messages, in order; once they are used up it answers 201. */
  answer(...answers: Answer[]): void;
  close(): Promise<void>;
}

export async function startPushService(): Promise<PushService> {
  const dir = mkdtempSync(join(tmpdir(), "os-push-service-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      join(dir, "tls-key.pem"),
      "-out",
      join(dir, "tls-cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(dir, "tls-cert.pem"), "utf8");
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), cert]);
  const pushed: Pushed[] = [];
  const queue: Answer[] = [];

  const server = createHttpsServer(
    { key: readFileSync(join(dir, "tls-key.pem")), cert },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        pushed.push({
          method: request.method ?? "",
          path: request.url ?? "",
          headers: request.headers,
          body: new Uint8Array(Buffer.concat(chunks)),
        });
        const answer = queue.shift() ?? { status: 201 };
        response.writeHead(answer.status, answer.headers ?? {});
        response.end();
      });
    },
  );

  const listening = Promise.withResolvers<void>();
  server.listen(0, listening.resolve);
  await listening.promise;
  const { port } = server.address() as AddressInfo;

  return {
    origin: `https://localhost:${port}`,
    pushed,
    answer: (...answers) => {
      queue.push(...answers);
    },
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());

      return closed.promise;
    },
  };
}

/** A browser's subscription at `endpoint`: its own ECDH key and auth secret, as it reports them. */
export async function browserSubscription(endpoint: string): Promise<{
  ua: BrowserKeys;
  keys: { endpoint: string; p256dh: string; auth: string };
}> {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);

  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const authSecret = new Uint8Array(randomBytes(16));

  return {
    ua: { privateKey: keys.privateKey, publicKey, authSecret },
    keys: {
      endpoint,
      p256dh: Buffer.from(publicKey).toString("base64url"),
      auth: Buffer.from(authSecret).toString("base64url"),
    },
  };
}

/**
 * A configuration with Web Push on, a fresh VAPID key, the subject `mailto:ops@example.com` and
 * `localhost` as the only push service, on top of {@link baseEnv} and `extra`.
 */
export function pushConfig(extra: NodeJS.ProcessEnv = {}): Config {
  const { env, dir } = baseEnv();
  const vapidFile = join(dir, "vapid.pem");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(vapidFile, privateKey.export({ format: "pem", type: "pkcs8" }));

  return loadConfig({
    ...env,
    WEB_PUSH_ENABLED: "1",
    WEB_PUSH_VAPID_KEY_FILE: vapidFile,
    WEB_PUSH_SUBJECT: "mailto:ops@example.com",
    WEB_PUSH_ENDPOINT_HOSTS: "localhost",
    ...extra,
  });
}

/** The settings every configuration needs, with the files they name in a fresh directory. */
export function baseEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "os-notify-config-"));
  const signerSecret = join(dir, "signer-secret");
  writeFileSync(signerSecret, randomBytes(32).toString("base64"));
  const chains = join(dir, "chains.json");
  writeFileSync(
    chains,
    JSON.stringify([
      { chainId: "eip155:31337", name: "Local", rpcUrl: "http://127.0.0.1:1", nativeSymbol: "ETH" },
    ]),
  );

  return {
    dir,
    env: {
      PUBLIC_ORIGIN: "https://os.example.com",
      APPROVE_ORIGIN: "https://approve.os.example.com",
      DATABASE_URL: "postgres://os@127.0.0.1:1/os",
      KEYRING_FILE: join(dir, "keyring.json"),
      SIGNER_URL: "http://signer.test",
      SIGNER_HMAC_SECRET_FILE: signerSecret,
      CHAINS_FILE: chains,
    },
  };
}
