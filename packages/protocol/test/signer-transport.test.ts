import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { newId } from "../src/index.ts";
import {
  createSignerClient,
  SIGNATURE_HEADER,
  SignerError,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
} from "../src/signer/index.ts";
import {
  createSignerFetch,
  readSignerTls,
  type SignerTls,
  SignerTlsFileError,
} from "../src/signer/transport.ts";

const dir = mkdtempSync(join(tmpdir(), "os-signer-transport-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Pair {
  cert: Buffer;
  key: Buffer;
  certPath: string;
  keyPath: string;
}

/** A self-signed P-256 certificate, as `deploy/split/make-peer-certs.sh` makes them. */
function selfSigned(name: string, subjectAltName?: string): Pair {
  const certPath = join(dir, `${name}.crt`);
  const keyPath = join(dir, `${name}.key`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "2",
      "-subj",
      `/CN=${name}`,
      ...(subjectAltName === undefined ? [] : ["-addext", `subjectAltName=${subjectAltName}`]),
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );

  return { cert: readFileSync(certPath), key: readFileSync(keyPath), certPath, keyPath };
}

const signer = selfSigned("os-signer", "DNS:signer");

/** Another signer certificate for the same name, with another key. */
const impostor = selfSigned("os-signer-impostor", "DNS:signer");

const control = selfSigned("os-control");

const secret = new Uint8Array(randomBytes(32));

const clientTls: SignerTls = { cert: control.cert, key: control.key, peerCert: signer.cert };

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

interface TestSigner {
  baseUrl: string;
  /** The SHA-256 fingerprint of each client certificate a request arrived with. */
  peers: string[];
}

/**
 * A TLS signer that trusts exactly the control certificate: it answers the health check and
 * refuses every signed request as `not_found` once its signature checks, `unauthenticated`
 * otherwise, as the signer does.
 */
async function startSigner(
  identity: Pair,
  options: { maxVersion?: "TLSv1.2" } = {},
): Promise<TestSigner> {
  const peers: string[] = [];

  const server = createServer(
    {
      cert: identity.cert,
      key: identity.key,
      ca: [control.cert],
      requestCert: true,
      rejectUnauthorized: true,
      ...(options.maxVersion === undefined ? {} : { maxVersion: options.maxVersion }),
    },
    async (request, response) => {
      peers.push((request.socket as TLSSocket).getPeerCertificate().fingerprint256);
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(chunk as Buffer);

      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };

      if (request.url === "/healthz") return reply(200, { ok: true, version: "0.1.0" });

      const authentic = verifyRequestSignature(secret, {
        method: request.method ?? "",
        pathWithQuery: request.url ?? "",
        timestamp: Number(request.headers[TIMESTAMP_HEADER]),
        body: new Uint8Array(Buffer.concat(chunks)),
        signature: String(request.headers[SIGNATURE_HEADER] ?? ""),
        now: Math.floor(Date.now() / 1000),
      });

      const code = authentic ? "not_found" : "unauthenticated";

      return reply(authentic ? 404 : 401, { error: { code, message: code } });
    },
  );

  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;

  return { baseUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, peers };
}

const controlFingerprint = new X509Certificate(control.cert).fingerprint256;

describe("createSignerFetch", () => {
  it("completes a signed request to a TLS signer, presenting the client certificate", async () => {
    const test = await startSigner(signer);

    const client = createSignerClient({
      baseUrl: test.baseUrl,
      secret,
      fetch: createSignerFetch(clientTls, "signer"),
    });

    expect(await client.health()).toEqual({ ok: true, version: "0.1.0" });
    // The request signature still binds the request inside TLS: the signer checked it.
    const refusal = await client.getWorkspace(newId("ws")).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SignerError);
    expect((refusal as SignerError).code).toBe("not_found");
    expect(test.peers).toEqual([controlFingerprint, controlFingerprint]);
  });

  it("fails against a signer presenting another certificate, before any request is made", async () => {
    const test = await startSigner(impostor);

    const client = createSignerClient({
      baseUrl: test.baseUrl,
      secret,
      fetch: createSignerFetch(clientTls, "signer"),
    });

    const failure = await client.health().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).cause).toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(test.peers).toEqual([]);
  });

  it("fails when the signer's certificate is not issued for the expected name", async () => {
    const test = await startSigner(signer);

    const client = createSignerClient({
      baseUrl: test.baseUrl,
      secret,
      fetch: createSignerFetch(clientTls, "signer.elsewhere"),
    });

    const failure = await client.health().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).cause).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(test.peers).toEqual([]);
  });

  it("speaks nothing older than TLS 1.3", async () => {
    const test = await startSigner(signer, { maxVersion: "TLSv1.2" });

    const client = createSignerClient({
      baseUrl: test.baseUrl,
      secret,
      fetch: createSignerFetch(clientTls, "signer"),
    });

    await expect(client.health()).rejects.toThrow(TypeError);
    expect(test.peers).toEqual([]);
  });
});

describe("readSignerTls", () => {
  const refusal = (paths: { cert: string; key: string; peerCert: string }) => {
    try {
      readSignerTls(paths);
    } catch (error) {
      if (!(error instanceof SignerTlsFileError)) throw error;

      return `${error.file}: ${error.message}`;
    }

    return null;
  };

  const paths = { cert: control.certPath, key: control.keyPath, peerCert: signer.certPath };

  it("reads a client certificate, its key and the signer's certificate", () => {
    expect(readSignerTls(paths)).toEqual(clientTls);
  });

  it("refuses files that cannot work, naming the file and never its content", () => {
    const notPem = join(dir, "not-pem");
    writeFileSync(notPem, "not a certificate");
    expect(refusal({ ...paths, cert: join(dir, "missing") })).toBe("cert: file cannot be read");
    expect(refusal({ ...paths, peerCert: notPem })).toBe("peerCert: not a PEM certificate");
    expect(refusal({ ...paths, key: notPem })).toBe("key: not a PEM private key");
    expect(refusal({ ...paths, key: signer.keyPath })).toBe(
      "key: not the key of the client certificate",
    );
  });
});
