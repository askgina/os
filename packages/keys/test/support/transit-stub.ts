// An in-process stand-in for the parts of OpenBao's API that TransitKeyProvider uses: Transit
// encrypt, decrypt and key reads with real AES-256-GCM and associated data, token, AppRole and
// Kubernetes logins, token lookup and renewal. It can hold requests (as a paused server does),
// answer with a chosen status, and count what it was asked. Test keys only.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { JsonValue } from "../../src/index.ts";

export interface TransitStubOptions {
  mount?: string;
  key?: string;
  /** TTL of tokens the logins issue, in seconds. */
  tokenTtl?: number;
  renewable?: boolean;
  keyType?: string;
}

export interface TransitStub {
  address: URL;
  /** A token that never expires, as a dev server's root token. */
  rootToken: string;
  roleId: string;
  secretId: string;
  kubernetesRole: string;
  kubernetesJwt: string;
  /** Every request seen, as `METHOD /path`. */
  requests: string[];
  rotate(): void;
  setMinDecryptionVersion(version: number): void;
  /** Hold every request without an answer until `unpause`. */
  pause(): void;
  unpause(): void;
  /** Answer the next `count` requests with `status`. */
  failNext(status: number, count?: number): void;
  /** Invalidate every token, the root token too, so the next request with one gets 403. */
  revokeTokens(): void;
  /** Answer decrypts with this many bytes of plaintext instead of the real one. */
  corruptPlaintextLength(length: number | undefined): void;
  close(): Promise<void>;
}

/** A field or header the stub reads; absent or of another type, it reads as `undefined`. */
const RequestText = z.string().optional().catch(undefined);

/** The fields of a request body the stub reads, on whichever route it is. */
const RequestBody = z.object({
  role_id: RequestText,
  secret_id: RequestText,
  role: RequestText,
  jwt: RequestText,
  key_version: z.number().optional().catch(undefined),
  plaintext: RequestText,
  associated_data: RequestText,
  ciphertext: RequestText,
});

function aes(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

function unaes(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));

  return Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]);
}

export async function startTransitStub(options: TransitStubOptions = {}): Promise<TransitStub> {
  const mount = options.mount ?? "transit";
  const keyName = options.key ?? "os-kek";
  const tokenTtl = options.tokenTtl ?? 3600;
  const renewable = options.renewable ?? true;
  const keyType = options.keyType ?? "aes256-gcm96";
  const versions = new Map<number, Buffer>([[1, randomBytes(32)]]);
  let minDecryption = 1;
  const rootToken = "stub-root";
  const tokens = new Map<string, { expires: number | null }>([[rootToken, { expires: null }]]);
  const requests: string[] = [];
  let held: (() => void)[] | null = null;
  let failures: { status: number; count: number } | null = null;
  let plaintextLength: number | undefined;

  const credentials = {
    roleId: "role-id-for-tests",
    secretId: "secret-id-for-tests",
    kubernetesRole: "os-server",
    kubernetesJwt: "jwt-for-tests",
  };

  const issue = () => {
    const token = `s.${randomBytes(12).toString("hex")}`;
    tokens.set(token, { expires: tokenTtl > 0 ? Date.now() + tokenTtl * 1000 : null });

    return { client_token: token, lease_duration: tokenTtl, renewable };
  };

  function reply(res: ServerResponse, status: number, body?: JsonValue) {
    if (res.destroyed) return;
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  }

  function handle(req: IncomingMessage, res: ServerResponse, raw: string) {
    if (failures && failures.count > 0) {
      failures.count -= 1;
      reply(res, failures.status, { errors: ["stub failure"] });

      return;
    }

    let body: z.infer<typeof RequestBody>;

    try {
      body = RequestBody.parse(raw === "" ? {} : JSON.parse(raw));
    } catch {
      reply(res, 400, { errors: ["bad json"] });

      return;
    }

    const path = new URL(req.url ?? "/", "http://stub").pathname;
    const method = req.method ?? "GET";

    if (method === "POST" && path === "/v1/auth/approle/login") {
      if (body.role_id !== credentials.roleId || body.secret_id !== credentials.secretId) {
        reply(res, 400, { errors: ["invalid role or secret ID"] });

        return;
      }

      reply(res, 200, { auth: issue() });

      return;
    }

    if (method === "POST" && path === "/v1/auth/kubernetes/login") {
      if (body.role !== credentials.kubernetesRole || body.jwt !== credentials.kubernetesJwt) {
        reply(res, 403, { errors: ["permission denied"] });

        return;
      }

      reply(res, 200, { auth: issue() });

      return;
    }

    const token = RequestText.parse(req.headers["x-vault-token"]);
    const entry = token === undefined ? undefined : tokens.get(token);

    if (!entry || (entry.expires !== null && entry.expires <= Date.now())) {
      reply(res, 403, { errors: ["permission denied"] });

      return;
    }

    if (method === "GET" && path === "/v1/auth/token/lookup-self") {
      const ttl = entry.expires === null ? 0 : Math.ceil((entry.expires - Date.now()) / 1000);
      reply(res, 200, { data: { ttl, renewable: entry.expires !== null && renewable } });

      return;
    }

    if (method === "POST" && path === "/v1/auth/token/renew-self") {
      if (entry.expires !== null) entry.expires = Date.now() + tokenTtl * 1000;
      reply(res, 200, { auth: { lease_duration: tokenTtl, renewable } });

      return;
    }

    const latest = versions.size;

    if (method === "GET" && path === `/v1/${mount}/keys/${keyName}`) {
      reply(res, 200, {
        data: {
          type: keyType,
          latest_version: latest,
          min_decryption_version: minDecryption,
          min_encryption_version: 0,
          keys: Object.fromEntries([...versions.keys()].map((v) => [String(v), 1_800_000_000])),
        },
      });

      return;
    }

    if (method === "POST" && path === `/v1/${mount}/encrypt/${keyName}`) {
      const version = body.key_version ?? latest;
      const key = versions.get(version);

      if (!key || body.plaintext === undefined) {
        reply(res, 400, { errors: ["invalid key version or plaintext"] });

        return;
      }

      const aad = Buffer.from(body.associated_data ?? "", "base64");
      const sealed = aes(key, Buffer.from(body.plaintext, "base64"), aad);
      reply(res, 200, { data: { ciphertext: `vault:v${version}:${sealed.toString("base64")}` } });

      return;
    }

    if (method === "POST" && path === `/v1/${mount}/decrypt/${keyName}`) {
      const match = /^vault:v(\d+):(.+)$/.exec(body.ciphertext ?? "");
      const version = Number(match?.[1]);
      const key = versions.get(version);

      if (!match || !key) {
        reply(res, 400, { errors: ["invalid ciphertext"] });

        return;
      }

      if (version < minDecryption) {
        reply(res, 400, { errors: ["ciphertext or signature version is disallowed by policy"] });

        return;
      }

      let plaintext: Buffer;

      try {
        plaintext = unaes(
          key,
          Buffer.from(match[2] ?? "", "base64"),
          Buffer.from(body.associated_data ?? "", "base64"),
        );
      } catch {
        reply(res, 400, { errors: ["cipher: message authentication failed"] });

        return;
      }

      if (plaintextLength !== undefined) plaintext = randomBytes(plaintextLength);
      reply(res, 200, { data: { plaintext: plaintext.toString("base64") } });

      return;
    }

    reply(res, 404, { errors: ["no handler for route"] });
  }

  const server = createServer((req, res) => {
    requests.push(`${req.method} ${new URL(req.url ?? "/", "http://stub").pathname}`);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");

      if (held) held.push(() => handle(req, res, raw));
      else handle(req, res, raw);
    });
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  // SAFETY: `server.address()` returns an AddressInfo for a server listening on a TCP port, as
  // this one is once `listen(0, "127.0.0.1")` has called back (awaited just above); it returns a
  // string only for a pipe or socket path and null only before listening.
  const port = (server.address() as AddressInfo).port;

  return {
    address: new URL(`http://127.0.0.1:${port}`),
    rootToken,
    ...credentials,
    requests,
    rotate() {
      versions.set(versions.size + 1, randomBytes(32));
    },
    setMinDecryptionVersion(version) {
      minDecryption = version;
    },
    pause() {
      held ??= [];
    },
    unpause() {
      const waiting = held ?? [];
      held = null;

      for (const run of waiting) run();
    },
    failNext(status, count = 1) {
      failures = { status, count };
    },
    revokeTokens() {
      tokens.clear();
    },
    corruptPlaintextLength(length) {
      plaintextLength = length;
    },
    async close() {
      held = null;
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
