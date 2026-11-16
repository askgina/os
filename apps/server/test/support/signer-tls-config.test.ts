import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ConfigError, loadConfig } from "../../src/config.ts";

const MAKE_PEER_CERTS = new URL("../../../../deploy/split/make-peer-certs.sh", import.meta.url)
  .pathname;

describe("the server's configuration for a signer on its own host", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-server-signer-tls-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The certificates an operator makes for a split deployment.
  execFileSync(MAKE_PEER_CERTS, ["signer.example.internal", join(dir, "certs")], {
    stdio: "ignore",
  });
  const cert = (name: string) => join(dir, "certs", name);
  const secretFile = join(dir, "signer-secret");
  writeFileSync(secretFile, randomBytes(32).toString("base64"));
  const chainsFile = join(dir, "chains.json");
  writeFileSync(
    chainsFile,
    JSON.stringify([
      {
        chainId: "eip155:31337",
        name: "Local",
        rpcUrl: "http://127.0.0.1:8545",
        nativeSymbol: "ETH",
      },
    ]),
  );

  const base: NodeJS.ProcessEnv = {
    PUBLIC_ORIGIN: "https://os.example.com",
    APPROVE_ORIGIN: "https://approve.os.example.com",
    DATABASE_URL: "postgres://localhost/none",
    SIGNER_URL: "http://signer:8787",
    SIGNER_HMAC_SECRET_FILE: secretFile,
    CHAINS_FILE: chainsFile,
  };

  const tlsFiles = {
    SIGNER_TLS_CERT_FILE: cert("control.crt"),
    SIGNER_TLS_KEY_FILE: cert("control.key"),
    SIGNER_TLS_PEER_CERT_FILE: cert("signer.crt"),
  };

  const split: NodeJS.ProcessEnv = {
    ...base,
    SIGNER_URL: "https://signer.example.internal:8787",
    ...tlsFiles,
  };

  /** The messages of a refused configuration: a schema refusal or a file that cannot be used. */
  const refusal = (environment: NodeJS.ProcessEnv): string[] | null => {
    try {
      loadConfig(environment);
    } catch (error) {
      if (error instanceof ZodError) return error.issues.map((issue) => issue.message);

      if (error instanceof ConfigError) return [error.message];
      throw error;
    }

    return null;
  };

  it("talks plain HTTP to an http: signer with no TLS files, as on one machine", () => {
    const config = loadConfig(base);
    expect([config.signerUrl, config.signerTls]).toEqual(["http://signer:8787", null]);
    // Compose passes an unset variable as "".
    expect(loadConfig({ ...base, SIGNER_TLS_CERT_FILE: "" }).signerTls).toBeNull();
  });

  it("reads its certificate, its key and the signer's certificate for an https: signer", () => {
    const config = loadConfig(split);
    expect(config.signerUrl).toBe("https://signer.example.internal:8787");
    expect(config.signerTls).toEqual({
      cert: readFileSync(cert("control.crt")),
      key: readFileSync(cert("control.key")),
      peerCert: readFileSync(cert("signer.crt")),
    });
  });

  it("refuses an https: signer without all three files", () => {
    const https = { ...base, SIGNER_URL: "https://signer.example.internal:8787" };
    expect(refusal(https)).toEqual(["an https SIGNER_URL needs all three SIGNER_TLS_* files"]);

    for (const name of Object.keys(tlsFiles)) {
      const { [name]: _dropped, ...two } = split;
      expect(refusal(two), name).toEqual([
        "an https SIGNER_URL needs all three SIGNER_TLS_* files",
      ]);
      expect(refusal({ ...split, [name]: "" }), `${name}=""`).toEqual([
        "an https SIGNER_URL needs all three SIGNER_TLS_* files",
      ]);
    }
  });

  it("refuses TLS files with an http: signer, which would talk in clear text", () => {
    expect(refusal({ ...split, SIGNER_URL: "http://signer.example.internal:8787" })).toEqual([
      "SIGNER_TLS_* files are set only with an https SIGNER_URL",
    ]);

    for (const [name, path] of Object.entries(tlsFiles)) {
      expect(refusal({ ...base, [name]: path }), name).toEqual([
        "SIGNER_TLS_* files are set only with an https SIGNER_URL",
      ]);
    }
  });

  it("refuses a signer that is neither http: nor https:", () => {
    expect(refusal({ ...base, SIGNER_URL: "ftp://signer:8787" })).not.toBeNull();
  });

  it("refuses TLS files that cannot work, naming the variable and never the content", () => {
    expect(refusal({ ...split, SIGNER_TLS_CERT_FILE: join(dir, "missing") })).toEqual([
      "SIGNER_TLS_CERT_FILE: file cannot be read",
    ]);
    expect(refusal({ ...split, SIGNER_TLS_PEER_CERT_FILE: cert("signer.key") })).toEqual([
      "SIGNER_TLS_PEER_CERT_FILE: not a PEM certificate",
    ]);
    expect(refusal({ ...split, SIGNER_TLS_KEY_FILE: cert("control.crt") })).toEqual([
      "SIGNER_TLS_KEY_FILE: not a PEM private key",
    ]);
    expect(refusal({ ...split, SIGNER_TLS_KEY_FILE: cert("approve.key") })).toEqual([
      "SIGNER_TLS_KEY_FILE: not the key of the client certificate",
    ]);
  });

  it("shows the Compose admin command by default and takes another that is safe to paste", () => {
    expect(loadConfig(base).signerAdminCommand).toBe(
      "docker compose exec signer node src/admin.ts",
    );
    expect(loadConfig({ ...base, SIGNER_ADMIN_COMMAND: "" }).signerAdminCommand).toBe(
      "docker compose exec signer node src/admin.ts",
    );

    const split =
      "docker compose -f deploy/split/signer.compose.yaml exec signer node src/admin.ts";

    expect(loadConfig({ ...base, SIGNER_ADMIN_COMMAND: split }).signerAdminCommand).toBe(split);
  });

  it("refuses an admin command that a root shell would read as more than words", () => {
    for (const command of [
      "docker compose exec signer node src/admin.ts; id",
      "docker compose exec signer $(id)",
      "docker  compose exec signer",
      " docker compose",
      "docker compose exec signer node src/admin.ts > /tmp/out",
      "ssh 'signer host' docker",
    ]) {
      expect(refusal({ ...base, SIGNER_ADMIN_COMMAND: command }), command).toEqual([
        "must be words of [A-Za-z0-9_./:-] separated by single spaces",
      ]);
    }
  });
});
