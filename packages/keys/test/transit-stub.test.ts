// Unit behaviour of TransitKeyProvider against the in-process stub: logins, retries, refusals,
// timeouts, renewal, refresh and what error messages may carry. No database.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import {
  KeyProviderConfigError,
  type KeyProviderEvent,
  KeyProviderRefusedError,
  KeyProviderUnavailableError,
  type TransitAuth,
  TransitKeyProvider,
  type TransitKeyProviderOptions,
} from "../src/index.ts";
import {
  startTransitStub,
  type TransitStub,
  type TransitStubOptions,
} from "./support/transit-stub.ts";

const dir = mkdtempSync(join(tmpdir(), "os-keys-transit-stub-"));
const opened: { close(): Promise<void> }[] = [];
const dataKey = randomBytes(32);
const aad = Buffer.from(JSON.stringify(["askgina.os/data-key/v1", "run", "wrun_x", null]));

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((item) => item.close()));
});

/** Fake only the timers the provider schedules; sockets, `Date` and retry pauses stay real. */
function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const path = join(dir, `${name}-${randomBytes(4).toString("hex")}`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

async function stub(options?: TransitStubOptions): Promise<TransitStub> {
  const started = await startTransitStub(options);
  opened.push(started);
  return started;
}

function appRole(server: TransitStub): TransitAuth {
  return {
    kind: "approle",
    roleIdFile: file("role-id", server.roleId),
    secretIdFile: file("secret-id", server.secretId),
  };
}

function provider(
  server: TransitStub,
  options: Partial<TransitKeyProviderOptions> = {},
): TransitKeyProvider {
  const made = new TransitKeyProvider({
    address: server.address,
    auth: appRole(server),
    refreshSeconds: 0,
    ...options,
  });
  opened.push(made);
  return made;
}

const count = (server: TransitStub, request: string) =>
  server.requests.filter((seen) => seen === request).length;

async function failure(attempt: Promise<unknown>): Promise<Error> {
  return attempt.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error as Error,
  );
}

describe("signing in", () => {
  test("AppRole logs in once for concurrent operations, then wraps and unwraps", async () => {
    const server = await stub();
    const transit = provider(server);
    await transit.ready();
    expect(transit.activeKekId()).toBe("bao:transit/os-kek@1");
    const wrapped = await Promise.all(
      Array.from({ length: 5 }, () => transit.wrap("bao:transit/os-kek@1", dataKey, aad)),
    );
    expect(count(server, "POST /v1/auth/approle/login")).toBe(1);
    expect(Buffer.from(wrapped[0] ?? []).toString("utf8")).toMatch(/^vault:v1:/);
    const key = await transit.unwrap("bao:transit/os-kek@1", wrapped[0] ?? new Uint8Array(), aad);
    expect(Buffer.from(key)).toEqual(dataKey);
  });

  test("a token file is read and looked up; Kubernetes logs in with its JWT file", async () => {
    const server = await stub();
    const byToken = provider(server, {
      auth: { kind: "token", tokenFile: file("token", `${server.rootToken}\n`) },
    });
    await byToken.ready();
    expect(count(server, "GET /v1/auth/token/lookup-self")).toBe(1);
    const byJwt = provider(server, {
      auth: {
        kind: "kubernetes",
        role: server.kubernetesRole,
        jwtFile: file("jwt", server.kubernetesJwt),
      },
    });
    await byJwt.ready();
    expect(count(server, "POST /v1/auth/kubernetes/login")).toBe(1);
  });

  test("wrong AppRole credentials are refused; a missing credential file is unavailable", async () => {
    const server = await stub();
    const wrong = provider(server, {
      auth: {
        kind: "approle",
        roleIdFile: file("role-id", server.roleId),
        secretIdFile: file("secret-id", "not-the-secret"),
      },
    });
    const refused = await failure(wrong.ready());
    expect(refused).toBeInstanceOf(KeyProviderRefusedError);
    expect((refused as KeyProviderRefusedError).status).toBe(400);
    expect(refused.message).not.toContain("not-the-secret");

    const missing = provider(server, {
      auth: { kind: "token", tokenFile: join(dir, "no-such-token") },
    });
    const unavailable = await failure(missing.ready());
    expect(unavailable).toBeInstanceOf(KeyProviderUnavailableError);
    expect(unavailable.message).toBe("openbao: the tokenFile is empty or cannot be read");
  });

  test("a 403 triggers one fresh login, and a second 403 is a refusal", async () => {
    const server = await stub();
    const transit = provider(server);
    await transit.ready();
    server.revokeTokens();
    await transit.wrap("bao:transit/os-kek@1", dataKey, aad);
    expect(count(server, "POST /v1/auth/approle/login")).toBe(2);

    const byToken = provider(server, {
      auth: { kind: "token", tokenFile: file("token", "s.revoked") },
    });
    const refused = await failure(byToken.ready());
    expect(refused).toBeInstanceOf(KeyProviderRefusedError);
    expect((refused as KeyProviderRefusedError).status).toBe(403);
  });
});

describe("failures", () => {
  test("one 503 is retried; a second makes it unavailable, reported once", async () => {
    const server = await stub();
    const events: KeyProviderEvent[] = [];
    const transit = provider(server, { onEvent: (event) => events.push(event) });
    await transit.ready();
    server.failNext(503);
    await transit.wrap("bao:transit/os-kek@1", dataKey, aad);
    expect(count(server, "POST /v1/transit/encrypt/os-kek")).toBe(2);

    server.failNext(503, 2);
    const error = await failure(transit.wrap("bao:transit/os-kek@1", dataKey, aad));
    expect(error).toBeInstanceOf(KeyProviderUnavailableError);
    expect(error).toMatchObject({ status: 503, kekId: "bao:transit/os-kek@1", retryable: true });
    expect(count(server, "POST /v1/transit/encrypt/os-kek")).toBe(4);
    expect(events).toEqual([
      expect.objectContaining({
        event: "keys.provider_unavailable",
        provider: "openbao",
        operation: "encrypt",
        status: 503,
      }),
    ]);

    server.failNext(429, 2);
    expect(await failure(transit.ready())).toBeInstanceOf(KeyProviderUnavailableError);
  });

  test("400 and 404 are refusals, never retried", async () => {
    const server = await stub();
    const transit = provider(server);
    await transit.ready();
    for (const status of [400, 404]) {
      server.failNext(status);
      const before = count(server, "POST /v1/transit/encrypt/os-kek");
      const error = await failure(transit.wrap("bao:transit/os-kek@1", dataKey, aad));
      expect(error).toBeInstanceOf(KeyProviderRefusedError);
      expect(error).toMatchObject({ status, retryable: false });
      expect(count(server, "POST /v1/transit/encrypt/os-kek")).toBe(before + 1);
    }
  });

  test("a server that holds the request fails as unavailable in time and never resolves later", async () => {
    const server = await stub();
    const transit = provider(server, { timeoutMs: 300 });
    await transit.ready();
    server.pause();
    let resolved = false;
    const started = Date.now();
    const attempt = transit.wrap("bao:transit/os-kek@1", dataKey, aad);
    attempt.then(
      () => {
        resolved = true;
      },
      () => {},
    );
    const error = await failure(attempt);
    expect(Date.now() - started).toBeLessThan(300 + 500);
    expect(error).toBeInstanceOf(KeyProviderUnavailableError);
    expect(error.message).toBe("openbao: no answer within 300 ms");
    // The held request is answered now, to a connection the provider has already dropped.
    server.unpause();
    expect(await transit.wrap("bao:transit/os-kek@1", dataKey, aad)).toBeInstanceOf(Uint8Array);
    expect(resolved).toBe(false);
  });

  test("nothing listening is unavailable, with the connection error's code", async () => {
    const server = await stub();
    const address = server.address;
    await server.close();
    const transit = provider(server, { address, timeoutMs: 1000 });
    const started = Date.now();
    const error = await failure(transit.ready());
    expect(Date.now() - started).toBeLessThan(1500);
    expect(error).toBeInstanceOf(KeyProviderUnavailableError);
    expect(error.message).toBe("openbao: the server could not be reached (ECONNREFUSED)");
  });
});

describe("what is checked", () => {
  test("a KEK id of another key, a ciphertext of another version and non-UTF-8 bytes are refused without a request", async () => {
    const server = await stub();
    const transit = provider(server);
    await transit.ready();
    const wrapped = await transit.wrap("bao:transit/os-kek@1", dataKey, aad);
    const requests = server.requests.length;
    for (const attempt of [
      transit.wrap("bao:transit/other@1", dataKey, aad),
      transit.wrap("k1", dataKey, aad),
      transit.unwrap("bao:transit/os-kek@2", wrapped, aad),
      transit.unwrap("bao:transit/os-kek@1", Buffer.from([0xff, 0xfe]), aad),
    ]) {
      expect(await failure(attempt)).toBeInstanceOf(KeyProviderRefusedError);
    }
    expect(server.requests).toHaveLength(requests);
  });

  test("other associated data is refused, and no message carries the key or the AAD", async () => {
    const server = await stub();
    const transit = provider(server);
    await transit.ready();
    const wrapped = await transit.wrap("bao:transit/os-kek@1", dataKey, aad);
    const error = await failure(
      transit.unwrap("bao:transit/os-kek@1", wrapped, Buffer.from("another row")),
    );
    expect(error).toBeInstanceOf(KeyProviderRefusedError);
    expect(error.message).toBe(
      "openbao: decrypt under bao:transit/os-kek@1 was refused with status 400",
    );
    for (const secret of [dataKey.toString("base64"), aad.toString("base64"), "another row"]) {
      expect(error.message).not.toContain(secret);
    }
  });

  test("a plaintext that is not 32 bytes is refused", async () => {
    const server = await stub();
    const transit = provider(server);
    await transit.ready();
    const wrapped = await transit.wrap("bao:transit/os-kek@1", dataKey, aad);
    server.corruptPlaintextLength(16);
    expect(await failure(transit.unwrap("bao:transit/os-kek@1", wrapped, aad))).toBeInstanceOf(
      KeyProviderRefusedError,
    );
  });

  test("a key type that does not authenticate associated data is refused at ready()", async () => {
    const server = await stub({ keyType: "ed25519" });
    expect(await failure(provider(server).ready())).toBeInstanceOf(KeyProviderRefusedError);
  });

  test("activeKekId before ready() is unavailable, not a guess", async () => {
    const server = await stub();
    expect(() => provider(server).activeKekId()).toThrow(KeyProviderUnavailableError);
  });

  test.each([
    ["address", { address: new URL("ftp://127.0.0.1:1") }],
    ["address", { address: new URL("http://user:pass@127.0.0.1:1") }],
    ["mount", { mount: "Transit" }],
    ["key", { key: "os kek" }],
    ["timeoutMs", { timeoutMs: 10 }],
    ["refreshSeconds", { refreshSeconds: -1 }],
    ["caFile", { caFile: "/etc/hosts" }],
  ])("a bad %s is a configuration error", (setting, options) => {
    let error: unknown;
    try {
      new TransitKeyProvider({
        address: new URL("http://127.0.0.1:1"),
        auth: { kind: "token", tokenFile: "/nonexistent" },
        ...options,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(KeyProviderConfigError);
    expect((error as KeyProviderConfigError).code).toBe(setting);
    expect((error as Error).message).not.toContain("pass");
  });
});

describe("timers", () => {
  test("the refresh timer picks up a rotation", async () => {
    fakeTimers();
    const server = await stub();
    const transit = provider(server, { refreshSeconds: 1 });
    await transit.ready();
    server.rotate();
    expect(transit.activeKekId()).toBe("bao:transit/os-kek@1");
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(transit.activeKekId()).toBe("bao:transit/os-kek@2"));
  });

  test("a renewable token is renewed at two thirds of its TTL; a fixed one is replaced by a login", async () => {
    fakeTimers();
    const renewable = await stub({ tokenTtl: 3 });
    const renewing = provider(renewable);
    await renewing.ready();
    const fixed = await stub({ tokenTtl: 3, renewable: false });
    const relogging = provider(fixed);
    await relogging.ready();
    vi.advanceTimersByTime(1999);
    expect(count(renewable, "POST /v1/auth/token/renew-self")).toBe(0);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(count(renewable, "POST /v1/auth/token/renew-self")).toBe(1));
    await renewing.wrap("bao:transit/os-kek@1", dataKey, aad);
    expect(count(renewable, "POST /v1/auth/approle/login")).toBe(1);
    expect(count(fixed, "POST /v1/auth/token/renew-self")).toBe(0);
    await relogging.wrap("bao:transit/os-kek@1", dataKey, aad);
    expect(count(fixed, "POST /v1/auth/approle/login")).toBe(2);
  });

  test("close stops the timers and every later operation is unavailable", async () => {
    fakeTimers();
    const server = await stub({ tokenTtl: 3 });
    const transit = provider(server, { refreshSeconds: 1 });
    await transit.ready();
    await transit.close();
    const requests = server.requests.length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(server.requests).toHaveLength(requests);
    const error = await failure(transit.wrap("bao:transit/os-kek@1", dataKey, aad));
    expect(error).toBeInstanceOf(KeyProviderUnavailableError);
    expect(error.message).toBe("openbao: the provider is closed");
  });
});
