import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const MAKE_PEER_CERTS = new URL("../../../deploy/split/make-peer-certs.sh", import.meta.url)
  .pathname;

describe("the approve service's configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-approve-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The certificates an operator makes for a split deployment.
  execFileSync(MAKE_PEER_CERTS, ["signer.test", join(dir, "certs")], { stdio: "ignore" });
  const cert = (name: string) => join(dir, "certs", name);
  const secretFile = join(dir, "confirm-secret");
  writeFileSync(secretFile, randomBytes(32).toString("base64"));

  const base = {
    APPROVE_ORIGIN: "https://approve.os.example.com",
    SIGNER_URL: "http://signer:8787",
    APPROVE_SIGNER_SECRET_FILE: secretFile,
  };

  const tlsFiles = {
    APPROVE_TLS_CERT_FILE: cert("approve.crt"),
    APPROVE_TLS_KEY_FILE: cert("approve.key"),
    APPROVE_TLS_PEER_CERT_FILE: cert("signer.crt"),
  };

  const split: NodeJS.ProcessEnv = { ...base, SIGNER_URL: "https://signer:8787", ...tlsFiles };

  const refusal = (environment: NodeJS.ProcessEnv) => {
    try {
      loadConfig(environment);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;

      return error.message;
    }

    return null;
  };

  it("talks plain HTTP to an http: signer with no TLS files, as on one machine", () => {
    const config = loadConfig(base);
    expect([config.signerUrl, config.signerTls]).toEqual(["http://signer:8787", null]);
    // Compose passes an unset variable as "".
    expect(loadConfig({ ...base, APPROVE_TLS_CERT_FILE: "" }).signerTls).toBeNull();
  });

  it("reads its certificate, its key and the signer's certificate for an https: signer", () => {
    expect(loadConfig(split).signerTls).toEqual({
      cert: readFileSync(cert("approve.crt")),
      key: readFileSync(cert("approve.key")),
      peerCert: readFileSync(cert("signer.crt")),
    });
  });

  it("refuses an https: signer without all three files", () => {
    const https = { ...base, SIGNER_URL: "https://signer:8787" };
    expect(refusal(https)).toBe("APPROVE_TLS_*: an https SIGNER_URL needs all three");

    for (const name of Object.keys(tlsFiles)) {
      const { [name]: _dropped, ...two } = split;
      expect(refusal(two)).toBe("APPROVE_TLS_*: an https SIGNER_URL needs all three");
    }
  });

  it("refuses TLS files with an http: signer, which would talk in clear text", () => {
    expect(refusal({ ...split, SIGNER_URL: "http://signer:8787" })).toBe(
      "APPROVE_TLS_*: set only with an https SIGNER_URL",
    );

    for (const [name, path] of Object.entries(tlsFiles)) {
      expect(refusal({ ...base, [name]: path })).toBe(
        "APPROVE_TLS_*: set only with an https SIGNER_URL",
      );
    }
  });

  it("refuses TLS files that cannot work, naming the variable and never the content", () => {
    expect(refusal({ ...split, APPROVE_TLS_CERT_FILE: join(dir, "missing") })).toBe(
      "APPROVE_TLS_CERT_FILE: file cannot be read",
    );
    expect(refusal({ ...split, APPROVE_TLS_PEER_CERT_FILE: cert("signer.key") })).toBe(
      "APPROVE_TLS_PEER_CERT_FILE: not a PEM certificate",
    );
    expect(refusal({ ...split, APPROVE_TLS_KEY_FILE: cert("approve.crt") })).toBe(
      "APPROVE_TLS_KEY_FILE: not a PEM private key",
    );
    expect(refusal({ ...split, APPROVE_TLS_KEY_FILE: cert("control.key") })).toBe(
      "APPROVE_TLS_KEY_FILE: not the key of the client certificate",
    );
  });
});
