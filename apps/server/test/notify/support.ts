import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * What a user agent does with a pushed body (RFC 8291 §3, RFC 8188), written apart from the
 * sender: read the header, derive the keys with its own private key, decrypt the one record,
 * then strip the zero padding and the 0x02 delimiter. Throws when anything does not hold.
 */
export async function decryptPush(
  body: Bytes,
  ua: { privateKey: CryptoKey; publicKey: Bytes; authSecret: Bytes },
): Promise<string> {
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
