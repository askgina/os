import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const DEPLOY = new URL("../../../deploy/", import.meta.url).pathname;

describe("the signer's configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-signer-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const controlSecret = randomBytes(32);
  const file = (name: string, content: string | Buffer) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  const base = {
    SIGNER_DATA_DIR: dir,
    SIGNER_HMAC_SECRET_FILE: file("hmac", controlSecret.toString("base64")),
    SIGNER_CONFIRM_SECRET_FILE: file("confirm", randomBytes(32).toString("base64")),
    SIGNER_KEY_FILE: file("key", randomBytes(32).toString("base64")),
    SIGNER_VAULT_PASSPHRASE_FILE: join(dir, "passphrase"),
    WEBAUTHN_RP_ID: "os.example.com",
    SIGNER_APPROVAL_ORIGIN: "https://approve.os.example.com",
    SIGNER_RETURN_ORIGIN: "https://os.example.com",
    SIGNER_CHAINS_FILE: join(DEPLOY, "chains.json"),
    SIGNER_ASSETS_FILE: join(DEPLOY, "assets.json"),
  };
  const refusal = (changes: Record<string, string>) => {
    try {
      loadConfig({ ...base, ...changes });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      return error.message;
    }
    return null;
  };

  it("reads the deployment's chains and assets files, keeping only each chain's name and coin", () => {
    const config = loadConfig(base);
    expect(config.chains).toEqual([
      { chainId: "eip155:31337", name: "Local chain", nativeSymbol: "ETH" },
    ]);
    expect(config.assets).toEqual([]);
    expect(config.rpId).toBe("os.example.com");
    expect(config.approvalOrigin).toBe("https://approve.os.example.com");
    expect(config.returnOrigin).toBe("https://os.example.com");
  });

  it("the signer refuses to start when the approval origin's host is not under the RP ID", () => {
    for (const origin of [
      "https://evil.example",
      // Ends with the RP ID, but is not a name under it.
      "https://notos.example.com",
      "https://os.example.com.evil.example",
    ]) {
      expect(refusal({ SIGNER_APPROVAL_ORIGIN: origin })).toMatch(/^SIGNER_APPROVAL_ORIGIN:/);
    }
    // Another port on the RP ID's own host is the layout for hosts without subdomains.
    expect(refusal({ SIGNER_APPROVAL_ORIGIN: "https://os.example.com:8443" })).toBeNull();
    // Origins are compared exactly, so only their canonical form is accepted.
    expect(refusal({ SIGNER_APPROVAL_ORIGIN: "https://approve.os.example.com/" })).toMatch(
      /^SIGNER_APPROVAL_ORIGIN:/,
    );
  });

  it("the signer refuses to start when the approval origin equals the return origin", () => {
    // The return origin is the control plane's: an approval page there would protect nothing.
    expect(refusal({ SIGNER_RETURN_ORIGIN: "https://approve.os.example.com" })).toMatch(
      /^SIGNER_RETURN_ORIGIN:/,
    );
    expect(refusal({ SIGNER_APPROVAL_ORIGIN: "https://os.example.com" })).toMatch(
      /^SIGNER_RETURN_ORIGIN:/,
    );
  });

  it("the signer refuses to start when the confirm secret equals the control secret or is short", () => {
    const same = file("same", controlSecret.toString("base64"));
    expect(refusal({ SIGNER_CONFIRM_SECRET_FILE: same })).toMatch(/^SIGNER_CONFIRM_SECRET_FILE:/);
    const short = file("short", randomBytes(31).toString("base64"));
    expect(refusal({ SIGNER_CONFIRM_SECRET_FILE: short })).toMatch(/^SIGNER_CONFIRM_SECRET_FILE:/);
  });

  it("names that could pass for something else stop the signer instead of reaching the page", () => {
    const chain = { chainId: "eip155:1", rpcUrl: "https://rpc.example" };
    for (const entry of [
      { ...chain, name: "Ethereum\u202Emainnet", nativeSymbol: "ETH" },
      { ...chain, name: "Ethereum", nativeSymbol: "ETH " },
      { ...chain, name: "Ethereum" },
    ]) {
      const chains = file("chains.json", JSON.stringify([entry]));
      expect(refusal({ SIGNER_CHAINS_FILE: chains })).toMatch(/^SIGNER_CHAINS_FILE:/);
    }
    const token = { chainId: "eip155:1", asset: `0x${"11".repeat(20)}`, symbol: "USDC" };
    for (const entry of [
      { ...token, decimals: 37 },
      { ...token, decimals: 6, symbol: "US DC" },
      { ...token, decimals: 6, name: "USD Coin" },
    ]) {
      const assets = file("assets.json", JSON.stringify([entry]));
      expect(refusal({ SIGNER_ASSETS_FILE: assets })).toMatch(/^SIGNER_ASSETS_FILE:/);
    }
  });
});
