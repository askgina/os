import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";

/** One entry of a venues file as a test writes it, whether the server would take it or not. */
interface VenueEntry {
  network: string;
  apiUrl: string;
}

describe("the server's venues file", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-server-venues-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
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

  let files = 0;

  /** The configuration with a venues file holding `text`. */
  const withVenuesText = (text: string): NodeJS.ProcessEnv => {
    files += 1;
    const file = join(dir, `venues-${files}.json`);
    writeFileSync(file, text);

    return { ...base, VENUES_FILE: file };
  };

  /** The configuration with a venues file holding `content` as JSON. */
  const withVenues = (content: VenueEntry | readonly VenueEntry[]) =>
    withVenuesText(JSON.stringify(content));

  /** The message a refused configuration stops the boot with. */
  const refusalOf = (environment: NodeJS.ProcessEnv): string | null => {
    try {
      loadConfig(environment);
    } catch (error) {
      if (error instanceof ConfigError) return error.message;
      throw error;
    }

    return null;
  };

  /** The message a refused venues file holding `content` as JSON stops the boot with. */
  const refusal = (content: VenueEntry | readonly VenueEntry[]) => refusalOf(withVenues(content));

  it("has no venues without a venues file", () => {
    expect(loadConfig(base).venues).toEqual([]);
  });

  it("takes either network on a host that is not Hyperliquid's own, such as a fake venue", () => {
    for (const network of ["hyperliquid:testnet", "hyperliquid:mainnet"]) {
      const venues = [{ network, apiUrl: "http://127.0.0.1:9000" }];
      expect(loadConfig(withVenues(venues)).venues, network).toEqual(venues);
    }
  });

  it("takes Hyperliquid's own hosts named with their own networks, both at once", () => {
    const venues = [
      { network: "hyperliquid:testnet", apiUrl: "https://api.hyperliquid-testnet.xyz" },
      { network: "hyperliquid:mainnet", apiUrl: "https://api.hyperliquid.xyz" },
    ];

    expect(loadConfig(withVenues(venues)).venues).toEqual(venues);
  });

  it("refuses Hyperliquid's own host named with the other network", () => {
    expect(
      refusal([{ network: "hyperliquid:testnet", apiUrl: "https://api.hyperliquid.xyz" }]),
    ).toBe(
      "VENUES_FILE: api.hyperliquid.xyz is Hyperliquid's mainnet API; its entry must name hyperliquid:mainnet",
    );
    expect(
      refusal([{ network: "hyperliquid:testnet", apiUrl: "https://API.Hyperliquid.xyz/info" }]),
    ).toBe(
      "VENUES_FILE: api.hyperliquid.xyz is Hyperliquid's mainnet API; its entry must name hyperliquid:mainnet",
    );
    expect(
      refusal([{ network: "hyperliquid:mainnet", apiUrl: "https://api.hyperliquid-testnet.xyz" }]),
    ).toBe(
      "VENUES_FILE: api.hyperliquid-testnet.xyz is Hyperliquid's testnet API; its entry must name hyperliquid:testnet",
    );
  });

  it("refuses two entries for one network", () => {
    for (const network of ["hyperliquid:testnet", "hyperliquid:mainnet"]) {
      expect(
        refusal([
          { network, apiUrl: "http://127.0.0.1:9000" },
          { network, apiUrl: "http://127.0.0.1:9001" },
        ]),
        network,
      ).toBe("VENUES_FILE: at most one entry per network");
    }
  });

  it("refuses a file that is not a JSON array of entries", () => {
    expect(refusalOf(withVenuesText("not json"))).toBe(
      "VENUES_FILE: expected a JSON array of { network, apiUrl }",
    );

    for (const content of [
      { network: "hyperliquid:testnet", apiUrl: "http://127.0.0.1:9000" },
      [{ network: "hyperliquid:devnet", apiUrl: "http://127.0.0.1:9000" }],
      [
        { network: "hyperliquid:testnet", apiUrl: "http://127.0.0.1:9000" },
        { network: "hyperliquid:mainnet", apiUrl: "http://127.0.0.1:9001" },
        { network: "hyperliquid:mainnet", apiUrl: "http://127.0.0.1:9002" },
      ],
    ]) {
      expect(refusal(content)).toBe("VENUES_FILE: expected a JSON array of { network, apiUrl }");
    }
  });
});
