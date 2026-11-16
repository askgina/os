// keyProviderFromEnv: which provider the environment selects, and how bad settings fail.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CompositeKeyProvider,
  type KeyProvider,
  KeyProviderConfigError,
  keyProviderFromEnv,
  LocalKeyring,
  TransitKeyProvider,
} from "../src/index.ts";
import { startTransitStub, type TransitStub } from "./support/transit-stub.ts";

const dir = mkdtempSync(join(tmpdir(), "os-keys-providers-"));

const keyringFile = join(dir, "keyring.json");

writeFileSync(keyringFile, JSON.stringify(LocalKeyring.generate("k1")), { mode: 0o600 });

const tokenFile = join(dir, "token");

let stub: TransitStub;

const built: KeyProvider[] = [];

beforeAll(async () => {
  stub = await startTransitStub();
  writeFileSync(tokenFile, stub.rootToken, { mode: 0o600 });
});

afterAll(async () => {
  await Promise.all(built.map((provider) => provider.close()));
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

function build(env: NodeJS.ProcessEnv, keyringFileVariable = "KEYRING_FILE"): KeyProvider {
  const provider = keyProviderFromEnv(env, { keyringFileVariable });
  built.push(provider);

  return provider;
}

function configError(env: NodeJS.ProcessEnv): KeyProviderConfigError {
  try {
    build(env);
  } catch (error) {
    if (error instanceof KeyProviderConfigError) return error;
    throw error;
  }

  throw new Error("expected a configuration error");
}

const openbao = () => ({
  KEY_PROVIDER: "openbao",
  OPENBAO_ADDR: stub.address.href,
  OPENBAO_AUTH: "token",
  OPENBAO_TOKEN_FILE: tokenFile,
});

describe("keyProviderFromEnv", () => {
  test("the keyring file is the default, under the variable the caller names", () => {
    expect(build({ KEYRING_FILE: keyringFile })).toBeInstanceOf(LocalKeyring);
    expect(
      build({ KEY_PROVIDER: "file", WORLD_KEYRING_FILE: keyringFile }, "WORLD_KEYRING_FILE"),
    ).toBeInstanceOf(LocalKeyring);
    expect(configError({})).toMatchObject({
      message: "KEYRING_FILE is not set",
      code: "KEYRING_FILE",
    });
  });

  test("OpenBao alone is the Transit provider; with the keyring file it is the composite", async () => {
    const alone = build(openbao());
    expect(alone).toBeInstanceOf(TransitKeyProvider);
    await alone.ready();
    expect(alone.activeKekId()).toBe("bao:transit/os-kek@1");
    const aad = Buffer.from("aad");
    const key = randomBytes(32);
    const wrapped = await alone.wrap(alone.activeKekId(), key, aad);
    expect(Buffer.from(await alone.unwrap(alone.activeKekId(), wrapped, aad))).toEqual(key);

    const both = build({ ...openbao(), KEYRING_FILE: keyringFile });
    expect(both).toBeInstanceOf(CompositeKeyProvider);
    await both.ready();
    expect(both.activeKekId()).toBe("bao:transit/os-kek@1");
  });

  test("the Transit settings reach the provider", async () => {
    const custom = await startTransitStub({ mount: "kv/transit", key: "server-kek" });

    try {
      const provider = build({
        ...openbao(),
        OPENBAO_ADDR: custom.address.href,
        OPENBAO_TRANSIT_MOUNT: "kv/transit",
        OPENBAO_TRANSIT_KEY: "server-kek",
        OPENBAO_AUTH: "kubernetes",
        OPENBAO_KUBERNETES_ROLE: custom.kubernetesRole,
        OPENBAO_KUBERNETES_JWT_FILE: join(dir, "jwt"),
        OPENBAO_TIMEOUT_MS: "500",
      });

      writeFileSync(join(dir, "jwt"), custom.kubernetesJwt, { mode: 0o600 });
      await provider.ready();
      expect(provider.activeKekId()).toBe("bao:kv/transit/server-kek@1");
    } finally {
      await custom.close();
    }
  });

  test.each([
    ["KEY_PROVIDER", { KEY_PROVIDER: "vault", KEYRING_FILE: keyringFile }],
    ["KEY_PROVIDER", { OPENBAO_ADDR: "http://127.0.0.1:1", KEYRING_FILE: keyringFile }],
    ["OPENBAO_ADDR", { KEY_PROVIDER: "openbao", OPENBAO_AUTH: "token", OPENBAO_TOKEN_FILE: "/t" }],
    ["OPENBAO_ADDR", { KEY_PROVIDER: "openbao", OPENBAO_ADDR: "not a url with-secret-text" }],
    [
      "OPENBAO_ADDR",
      {
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: "ftp://bao",
        OPENBAO_AUTH: "token",
        OPENBAO_TOKEN_FILE: "/t",
      },
    ],
    ["OPENBAO_AUTH", { KEY_PROVIDER: "openbao", OPENBAO_ADDR: "http://bao:8200" }],
    [
      "OPENBAO_TOKEN_FILE",
      { KEY_PROVIDER: "openbao", OPENBAO_ADDR: "http://bao:8200", OPENBAO_AUTH: "token" },
    ],
    [
      "OPENBAO_SECRET_ID_FILE",
      {
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: "http://bao:8200",
        OPENBAO_AUTH: "approle",
        OPENBAO_ROLE_ID_FILE: "/r",
      },
    ],
    [
      "OPENBAO_KUBERNETES_ROLE",
      { KEY_PROVIDER: "openbao", OPENBAO_ADDR: "http://bao:8200", OPENBAO_AUTH: "kubernetes" },
    ],
    [
      "OPENBAO_TRANSIT_MOUNT",
      {
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: "http://bao:8200",
        OPENBAO_AUTH: "token",
        OPENBAO_TOKEN_FILE: "/t",
        OPENBAO_TRANSIT_MOUNT: "../sys",
      },
    ],
    [
      "OPENBAO_TRANSIT_KEY",
      {
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: "http://bao:8200",
        OPENBAO_AUTH: "token",
        OPENBAO_TOKEN_FILE: "/t",
        OPENBAO_TRANSIT_KEY: "a b",
      },
    ],
    [
      "OPENBAO_TIMEOUT_MS",
      {
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: "http://bao:8200",
        OPENBAO_AUTH: "token",
        OPENBAO_TOKEN_FILE: "/t",
        OPENBAO_TIMEOUT_MS: "1.5",
      },
    ],
    [
      "OPENBAO_TIMEOUT_MS",
      {
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: "http://bao:8200",
        OPENBAO_AUTH: "token",
        OPENBAO_TOKEN_FILE: "/t",
        OPENBAO_TIMEOUT_MS: "999999",
      },
    ],
    [
      "OPENBAO_CA_FILE",
      {
        KEY_PROVIDER: "openbao",
        OPENBAO_ADDR: "http://bao:8200",
        OPENBAO_AUTH: "token",
        OPENBAO_TOKEN_FILE: "/t",
        OPENBAO_CA_FILE: "/etc/hosts",
      },
    ],
  ] satisfies [string, NodeJS.ProcessEnv][])(
    "a bad or missing %s is a configuration error naming it",
    (variable, env) => {
      const error = configError(env);
      expect(error.code).toBe(variable);
      expect(error.message).not.toContain("with-secret-text");
    },
  );
});
