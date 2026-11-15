import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, type RequestInfo, type RequestInit, fetch as undiciFetch } from "undici";

/**
 * A client's side of the mutual TLS to a signer on another host: its own certificate and key,
 * and the one certificate it accepts from the signer. PEM, as `deploy/split/make-peer-certs.sh`
 * writes them.
 */
export interface SignerTls {
  cert: Buffer;
  key: Buffer;
  peerCert: Buffer;
}

/** Which of the three files a {@link SignerTlsFileError} is about. */
export type SignerTlsFile = keyof SignerTls;

/** A TLS file that cannot be read or does not hold what it should. Never carries the bytes. */
export class SignerTlsFileError extends Error {
  override readonly name = "SignerTlsFileError";
  readonly file: SignerTlsFile;

  constructor(file: SignerTlsFile, message: string) {
    super(message);
    this.file = file;
  }
}

function readPem(file: SignerTlsFile, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new SignerTlsFileError(file, "file cannot be read");
  }
}

function certificateOf(file: SignerTlsFile, pem: Buffer): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    throw new SignerTlsFileError(file, "not a PEM certificate");
  }
}

/**
 * Read a client's TLS files and check them, so a wrong file stops the process at boot instead
 * of failing every request: both certificates parse, and the key is the client certificate's.
 */
export function readSignerTls(paths: { cert: string; key: string; peerCert: string }): SignerTls {
  const tls = {
    cert: readPem("cert", paths.cert),
    key: readPem("key", paths.key),
    peerCert: readPem("peerCert", paths.peerCert),
  };
  const own = certificateOf("cert", tls.cert);
  certificateOf("peerCert", tls.peerCert);
  let matches: boolean;
  try {
    matches = own.checkPrivateKey(createPrivateKey(tls.key));
  } catch {
    throw new SignerTlsFileError("key", "not a PEM private key");
  }
  if (!matches) throw new SignerTlsFileError("key", "not the key of the client certificate");
  return tls;
}

/**
 * A `fetch` for the signer clients (`createSignerClient`, `createConfirmClient`) that speaks
 * TLS 1.3 only, presents the client's certificate, and accepts exactly `peerCert` from the
 * signer, issued for `servername`. No certificate authority is trusted. It fails as `fetch`
 * fails: a refused handshake rejects the promise, as an unreachable signer does.
 *
 * The dispatcher and the `fetch` come from one `undici`, so pass a URL string or a `URL`, as
 * the signer clients do: a `Request` built by the runtime's own `fetch` is another class.
 */
export function createSignerFetch(tls: SignerTls, servername: string): typeof fetch {
  const dispatcher = new Agent({
    connect: {
      cert: tls.cert,
      key: tls.key,
      ca: [tls.peerCert],
      servername,
      minVersion: "TLSv1.3",
    },
  });
  const signerFetch = (input: RequestInfo, init?: RequestInit) =>
    undiciFetch(input, { ...init, dispatcher });
  // Each consumer's lib (Node's or the DOM's) declares its own `Request` and `Response`, which
  // undici's types do not match exactly; for a URL and an init, as the clients call it, the
  // function behaves as `fetch` and returns a standard `Response`.
  return signerFetch as unknown as typeof fetch;
}
