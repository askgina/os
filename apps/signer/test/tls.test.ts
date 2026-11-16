import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { newId } from "@askgina/os-protocol";
import {
  createConfirmClient,
  createSignerClient,
  SIGNATURE_HEADER,
  signRequest,
  TIMESTAMP_HEADER,
} from "@askgina/os-protocol/signer";
import { createSignerFetch, type SignerTls } from "@askgina/os-protocol/signer-transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createSigner, createTestVault } from "../src/index.ts";
import {
  CONFIRMATION_SETTINGS,
  confirmationEnvironment,
  newPerson,
  RP_ID,
  refused,
} from "./harness.ts";

const MAKE_PEER_CERTS = new URL("../../../deploy/split/make-peer-certs.sh", import.meta.url)
  .pathname;

const SIGNER_DIR = join(import.meta.dirname, "..");

const dir = mkdtempSync(join(tmpdir(), "os-signer-tls-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The certificates an operator makes with `deploy/split/make-peer-certs.sh`, in `out`. */
function makePeerCerts(out: string) {
  execFileSync(MAKE_PEER_CERTS, ["signer.test", out], { stdio: "ignore" });
  const path = (name: string) => join(out, name);
  const read = (name: string) => readFileSync(path(name));

  return {
    path,
    signer: { cert: read("signer.crt"), key: read("signer.key") },
    control: { cert: read("control.crt"), key: read("control.key") },
    approve: { cert: read("approve.crt"), key: read("approve.key") },
  };
}

const peers = makePeerCerts(join(dir, "peers"));

/** A second set nobody trusts: self-signed, with the same names. */
const strangers = makePeerCerts(join(dir, "strangers"));

/** A certificate for `os-control` that expired in 2020, signed by its own key. */
function expiredCertificate(out: string): string {
  mkdirSync(out);
  writeFileSync(join(out, "index.txt"), "");
  writeFileSync(join(out, "serial"), "01\n");
  writeFileSync(
    join(out, "ca.cnf"),
    [
      "[ca]",
      "default_ca = expired",
      "[expired]",
      `database = ${join(out, "index.txt")}`,
      `new_certs_dir = ${out}`,
      `serial = ${join(out, "serial")}`,
      "default_md = sha256",
      "policy = any",
      "unique_subject = no",
      "[any]",
      "commonName = supplied",
      "",
    ].join("\n"),
  );
  const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-subj",
    "/CN=os-control",
    "-keyout",
    join(out, "control.key"),
    "-out",
    join(out, "control.csr"),
  ]);
  openssl([
    "ca",
    "-batch",
    "-config",
    join(out, "ca.cnf"),
    "-selfsign",
    "-keyfile",
    join(out, "control.key"),
    "-in",
    join(out, "control.csr"),
    "-out",
    join(out, "control.crt"),
    "-startdate",
    "20200101000000Z",
    "-enddate",
    "20200102000000Z",
    "-notext",
  ]);

  return join(out, "control.crt");
}

const requestSecret = new Uint8Array(randomBytes(32));

const confirmSecret = new Uint8Array(randomBytes(32));

const secretFile = (name: string, bytes: Uint8Array) => {
  writeFileSync(join(dir, name), Buffer.from(bytes).toString("base64"));

  return join(dir, name);
};

/** A signer process's environment with mutual TLS, listening on `port` and `healthPort`. */
function signerEnvironment(port: number, healthPort: number): Record<string, string> {
  const dataDir = join(dir, `data-${port}`);

  return {
    PATH: process.env.PATH ?? "",
    SIGNER_PORT: String(port),
    SIGNER_HOST: "127.0.0.1",
    SIGNER_HEALTH_PORT: String(healthPort),
    SIGNER_DATA_DIR: dataDir,
    SIGNER_HMAC_SECRET_FILE: secretFile("hmac", requestSecret),
    SIGNER_KEY_FILE: secretFile("token-key", randomBytes(32)),
    SIGNER_VAULT_PASSPHRASE_FILE: join(dir, "passphrase"),
    WEBAUTHN_RP_ID: RP_ID,
    ...confirmationEnvironment(dir, confirmSecret),
    SIGNER_TLS_CERT_FILE: peers.path("signer.crt"),
    SIGNER_TLS_KEY_FILE: peers.path("signer.key"),
    SIGNER_TLS_CONTROL_CERT_FILE: peers.path("control.crt"),
    SIGNER_TLS_APPROVE_CERT_FILE: peers.path("approve.crt"),
  };
}

/** Start `node src/main.ts`; resolves with its output once every message in `until` appeared. */
function startProcess(environment: Record<string, string>, until: string[]) {
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: SIGNER_DIR,
    env: environment,
    stdio: ["ignore", "pipe", "inherit"],
  });

  let output = "";
  const ready = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<number | null>();
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();

    if (until.every((message) => output.includes(`"message":"${message}"`))) ready.resolve(output);
  });
  child.once("exit", (code) => {
    exited.resolve(code);
    ready.reject(new Error(`signer exited with ${code}: ${output}`));
  });
  ready.promise.catch(() => undefined);

  return { child, ready: ready.promise, exited: exited.promise, output: () => output };
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;

  return port;
}

/**
 * Send one HTTP request on `socket` and collect every byte that comes back until the connection
 * ends, however it ends. A refused handshake ends it before any byte of an HTTP response.
 */
async function exchange(socket: Socket): Promise<string> {
  const received: Buffer[] = [];
  const ended = Promise.withResolvers<void>();
  socket.on("data", (chunk: Buffer) => received.push(chunk));
  socket.on("error", () => ended.resolve());
  socket.on("close", () => ended.resolve());
  socket.write("GET /healthz HTTP/1.1\r\nHost: signer\r\nConnection: close\r\n\r\n");
  await ended.promise;

  return Buffer.concat(received).toString("latin1");
}

const tlsOf = (set: typeof peers, client: "control" | "approve"): SignerTls => ({
  cert: set[client].cert,
  key: set[client].key,
  peerCert: peers.signer.cert,
});

describe("a signer on its own host, behind mutual TLS", () => {
  let port: number;
  let healthPort: number;
  let signer: ChildProcess | null = null;
  const baseUrl = () => `https://127.0.0.1:${port}`;

  beforeAll(async () => {
    port = await freePort();
    healthPort = await freePort();

    const started = startProcess(signerEnvironment(port, healthPort), [
      "listening",
      "health listening",
    ]);

    signer = started.child;
    await started.ready;
  });
  afterAll(async () => {
    if (signer === null || signer.exitCode !== null) return;
    const exited = Promise.withResolvers<void>();
    signer.once("exit", () => exited.resolve());
    signer.kill("SIGTERM");
    await exited.promise;
  });

  it("lets the control plane's certificate check health and make a control-scope request", async () => {
    const control = createSignerClient({
      baseUrl: baseUrl(),
      secret: requestSecret,
      fetch: createSignerFetch(tlsOf(peers, "control"), "signer"),
    });

    expect(await control.health()).toEqual({ ok: true, version: "0.1.0" });
    const workspaceId = newId("ws");

    const workspace = await control.createWorkspace({
      workspaceId,
      adminThreshold: 1,
      approvers: [newPerson().credential],
    });

    expect(workspace.workspaceId).toBe(workspaceId);
  });

  it("binds each certificate to its scope, whatever secret signs the request", async () => {
    const controlFetch = createSignerFetch(tlsOf(peers, "control"), "signer");
    const approveFetch = createSignerFetch(tlsOf(peers, "approve"), "signer");

    // The `approve` service's certificate reaches a confirm-scope route: past authentication,
    // the signer looks the approval up.
    const approve = createConfirmClient({
      baseUrl: baseUrl(),
      secret: confirmSecret,
      fetch: approveFetch,
    });

    await refused(approve.getConfirmation(newId("apr"), "token"), "not_found");

    // With the control secret, from the `approve` certificate: refused, as a stolen control
    // secret on the signer host would be.
    const approveAsControl = createSignerClient({
      baseUrl: baseUrl(),
      secret: requestSecret,
      fetch: approveFetch,
    });

    await refused(approveAsControl.getWorkspace(newId("ws")), "unauthenticated");

    // With the confirm secret, from the control certificate: refused, so a stolen confirm
    // secret is useless from the control host.
    const controlAsApprove = createConfirmClient({
      baseUrl: baseUrl(),
      secret: confirmSecret,
      fetch: controlFetch,
    });

    await refused(controlAsApprove.getConfirmation(newId("apr"), "token"), "unauthenticated");
  });

  it("keeps a resumed TLS session bound to the certificate it was made with", async () => {
    const path = `/v1/workspaces/${newId("ws")}`;
    let session: Buffer | undefined;
    const answers: { reused: boolean; status: string }[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = signRequest(requestSecret, {
        method: "GET",
        pathWithQuery: path,
        timestamp,
        body: new Uint8Array(),
      });

      const socket = connectTls({
        host: "127.0.0.1",
        port,
        ca: [peers.signer.cert],
        servername: "signer",
        ...peers.control,
        session,
      });

      socket.on("session", (ticket: Buffer) => {
        session = ticket;
      });
      const received = Promise.withResolvers<string>();
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      socket.on("end", () => received.resolve(text));
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: signer\r\n${TIMESTAMP_HEADER}: ${timestamp}\r\n` +
          `${SIGNATURE_HEADER}: ${signature}\r\nConnection: close\r\n\r\n`,
      );
      const response = await received.promise;
      answers.push({ reused: socket.isSessionReused(), status: response.split("\r\n")[0] ?? "" });
    }

    // The second connection resumed the first one's session and still reached the control
    // route: past authentication, the signer looked the workspace up.
    expect(answers).toEqual([
      { reused: false, status: "HTTP/1.1 404 Not Found" },
      { reused: true, status: "HTTP/1.1 404 Not Found" },
    ]);
  });

  it("ends a connection without a trusted client certificate before any HTTP response", async () => {
    const tlsConnection = (options: { cert?: Buffer; key?: Buffer }) =>
      connectTls({
        host: "127.0.0.1",
        port,
        ca: [peers.signer.cert],
        servername: "signer",
        ...options,
      });

    // No client certificate.
    expect(await exchange(tlsConnection({}))).not.toContain("HTTP/");
    // A self-signed certificate the signer does not trust.
    expect(await exchange(tlsConnection(strangers.control))).not.toContain("HTTP/");
    // Plain HTTP on the TLS port.
    expect(await exchange(connectTcp({ host: "127.0.0.1", port }))).not.toContain("HTTP/");

    // And through the client transport, a refused handshake rejects like an unreachable signer.
    const stranger = createSignerClient({
      baseUrl: baseUrl(),
      secret: requestSecret,
      fetch: createSignerFetch(tlsOf(strangers, "control"), "signer"),
    });

    await expect(stranger.health()).rejects.toThrow(TypeError);
    // The trusted certificate on the same raw path gets an answer, so the checks above are not
    // passing because the helper never sees one.
    expect(await exchange(tlsConnection(peers.control))).toContain("HTTP/1.1 200 OK");
  });

  it("answers the health check in plain HTTP on 127.0.0.1 only, and nothing else there", async () => {
    const health = await fetch(`http://127.0.0.1:${healthPort}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: "0.1.0" });

    for (const [method, path] of [
      ["POST", "/healthz"],
      ["GET", `/v1/workspaces/${newId("ws")}`],
      ["POST", "/v1/workspaces"],
      ["GET", `/v1/confirm/${newId("apr")}`],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${healthPort}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    // Another loopback address reaches the same host but not a listener bound to 127.0.0.1.
    await expect(fetch(`http://127.0.0.2:${healthPort}/healthz`)).rejects.toThrow(TypeError);
  });

  it("refuses to start when a certificate has expired", async () => {
    const otherPort = await freePort();

    const started = startProcess(
      {
        ...signerEnvironment(otherPort, await freePort()),
        SIGNER_TLS_CONTROL_CERT_FILE: expiredCertificate(join(dir, "expired")),
      },
      ["listening"],
    );

    expect(await started.exited).toBe(1);

    const lines = started
      .output()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // Every start logs the days left on each certificate: about two years for the two made by
    // the script, years ago for the expired one.
    const expiry = lines.find((line) => line.message === "tls_expiry");
    expect(expiry?.SIGNER_TLS_CERT_FILE).toBeGreaterThan(700);
    expect(expiry?.SIGNER_TLS_APPROVE_CERT_FILE).toBeGreaterThan(700);
    expect(expiry?.SIGNER_TLS_CONTROL_CERT_FILE).toBeLessThan(-2000);
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: "refusing to start",
        code: "tls_certificate_expired",
        variable: "SIGNER_TLS_CONTROL_CERT_FILE",
      }),
    );
    expect(lines.some((line) => line.message === "listening")).toBe(false);
  });
});

describe("the signer's scope binding in process", () => {
  it("refuses every signed route to a request that did not arrive over verified TLS", async () => {
    const signer = createSigner({
      sqlitePath: ":memory:",
      vault: createTestVault(),
      rpId: RP_ID,
      requestSecret,
      confirmSecret,
      ...CONFIRMATION_SETTINGS,
      tokenKey: new Uint8Array(randomBytes(32)),
      maxIntentTtlSeconds: 3600,
      maxAdminTtlSeconds: 86_400,
      clientCertificates: { control: peers.control.cert, approve: peers.approve.cert },
    });

    const fetch: typeof globalThis.fetch = (url, init) =>
      Promise.resolve(signer.app.request(String(url), init));

    const control = createSignerClient({
      baseUrl: "http://signer.test",
      secret: requestSecret,
      fetch,
    });

    expect(await control.health()).toEqual({ ok: true, version: "0.1.0" });
    await refused(control.getWorkspace(newId("ws")), "unauthenticated");

    const approve = createConfirmClient({
      baseUrl: "http://signer.test",
      secret: confirmSecret,
      fetch,
    });

    await refused(approve.getConfirmation(newId("apr"), "token"), "unauthenticated");
    signer.close();
  });

  it("refuses one certificate for both clients", () => {
    expect(() =>
      createSigner({
        sqlitePath: ":memory:",
        vault: createTestVault(),
        rpId: RP_ID,
        requestSecret,
        confirmSecret,
        ...CONFIRMATION_SETTINGS,
        tokenKey: new Uint8Array(randomBytes(32)),
        maxIntentTtlSeconds: 3600,
        maxAdminTtlSeconds: 86_400,
        clientCertificates: { control: peers.control.cert, approve: peers.control.cert },
      }),
    ).toThrow("the two client certificates must differ");
  });
});

describe("the signer's TLS configuration", () => {
  const base = { ...signerEnvironment(8787, 8789) };

  const plain = Object.fromEntries(
    Object.entries(base).filter(([name]) => !name.startsWith("SIGNER_TLS_")),
  );

  const refusal = (environment: Record<string, string>) => {
    try {
      loadConfig(environment);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;

      return error.message;
    }

    return null;
  };

  it("serves plain HTTP on 0.0.0.0 as on one machine when no TLS variable is set", () => {
    const { SIGNER_HOST: _host, ...unset } = plain;
    const config = loadConfig(unset);
    expect([config.tls, config.host, config.port, config.healthPort]).toEqual([
      null,
      "0.0.0.0",
      8787,
      8789,
    ]);
    // Compose passes an unset variable as "".
    expect(loadConfig({ ...unset, SIGNER_TLS_CERT_FILE: "", SIGNER_HOST: "" }).tls).toBeNull();
  });

  it("reads the four files when all are set", () => {
    const config = loadConfig(base);
    expect(config.host).toBe("127.0.0.1");
    expect(config.tls).toEqual({
      cert: peers.signer.cert,
      key: peers.signer.key,
      control: peers.control.cert,
      approve: peers.approve.cert,
    });
  });

  it("refuses some TLS files without the others", () => {
    for (const name of Object.keys(base).filter((variable) => variable.startsWith("SIGNER_TLS_"))) {
      expect(refusal({ ...plain, [name]: base[name] ?? "" })).toBe(
        "SIGNER_TLS_*: set all four or none",
      );
      const { [name]: _dropped, ...three } = base;
      expect(refusal(three)).toBe("SIGNER_TLS_*: set all four or none");
    }
  });

  it("refuses files that cannot work, naming the variable and never the content", () => {
    expect(refusal({ ...base, SIGNER_TLS_CERT_FILE: join(dir, "missing") })).toBe(
      "SIGNER_TLS_CERT_FILE: file cannot be read",
    );
    expect(refusal({ ...base, SIGNER_TLS_APPROVE_CERT_FILE: peers.path("approve.key") })).toBe(
      "SIGNER_TLS_APPROVE_CERT_FILE: not a PEM certificate",
    );
    expect(refusal({ ...base, SIGNER_TLS_KEY_FILE: peers.path("signer.crt") })).toBe(
      "SIGNER_TLS_KEY_FILE: not a PEM private key",
    );
    expect(refusal({ ...base, SIGNER_TLS_KEY_FILE: peers.path("control.key") })).toBe(
      "SIGNER_TLS_KEY_FILE: not the key of SIGNER_TLS_CERT_FILE",
    );
  });

  it("refuses a certificate in two roles and a health port on the signer's port", () => {
    expect(refusal({ ...base, SIGNER_TLS_APPROVE_CERT_FILE: peers.path("control.crt") })).toBe(
      "SIGNER_TLS_APPROVE_CERT_FILE: the same certificate as SIGNER_TLS_CONTROL_CERT_FILE",
    );
    expect(refusal({ ...base, SIGNER_TLS_CONTROL_CERT_FILE: peers.path("signer.crt") })).toBe(
      "SIGNER_TLS_CONTROL_CERT_FILE: the signer's own certificate",
    );
    expect(refusal({ ...base, SIGNER_HEALTH_PORT: "8787" })).toBe(
      "SIGNER_HEALTH_PORT: the same port as SIGNER_PORT",
    );
    // Without TLS there is no health listener, so the port is not checked against the other.
    expect(refusal({ ...plain, SIGNER_HEALTH_PORT: "8787" })).toBeNull();
  });
});
