import { readFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type KeyProvider,
  KeyProviderConfigError,
  KeyProviderRefusedError,
  KeyProviderUnavailableError,
} from "./keyring.ts";

/** How the provider gets an OpenBao token. Files are read at each login, never kept elsewhere. */
export type TransitAuth =
  | { kind: "token"; tokenFile: string }
  | { kind: "approle"; roleIdFile: string; secretIdFile: string }
  | { kind: "kubernetes"; role: string; jwtFile: string };

/** What the provider reports for monitoring. Ids, statuses and durations only. */
export interface KeyProviderEvent {
  event: "keys.provider_unavailable" | "keys.provider_refresh_failed";
  provider: "openbao";
  operation: string;
  status?: number;
  durationMs: number;
}

export interface TransitKeyProviderOptions {
  /** The OpenBao server, for example `https://bao.internal:8200`. */
  address: URL;
  /** Where the Transit engine is mounted. Default `transit`. */
  mount?: string;
  /** The Transit key that wraps data keys. Default `os-kek`. */
  key?: string;
  auth: TransitAuth;
  /** PEM file with the CA that signed the server's certificate, when not a public one. */
  caFile?: string;
  /** How long one operation may take, its one retry included. Default 2000. */
  timeoutMs?: number;
  /** How often the key's latest version is read again, so a rotation is picked up. Default 300; 0 never. */
  refreshSeconds?: number;
  onEvent?: (event: KeyProviderEvent) => void;
}

const KEK_ID = /^bao:([a-z0-9/_-]+)@([1-9][0-9]*)$/;

const MOUNT = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;

const NAME = /^[a-z0-9_-]+$/;

/** Key types that authenticate associated data; any other would ignore the AAD binding. */
const AEAD_TYPES: Record<string, true> = {
  "aes128-gcm96": true,
  "aes256-gcm96": true,
  "chacha20-poly1305": true,
};

const MAX_ANSWER_BYTES = 64 * 1024;

const RETRY_PAUSE_MIN_MS = 100;

const RETRY_PAUSE_SPREAD_MS = 200;

/** A retry is not started with less than this left of the deadline after its pause. */
const MIN_ATTEMPT_MS = 50;

/** The longest delay `setTimeout` accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/** Whether a KEK id names a Transit key version (`bao:<mount>/<key>@<version>`). */
export function isTransitKekId(kekId: string): boolean {
  return kekId.startsWith("bao:");
}

interface Answer {
  status: number;
  body: Record<string, unknown> | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 429, 5xx (503 is a sealed server) and anything that is neither success nor a 4xx answer. */
function transient(status: number): boolean {
  return status === 429 || status >= 500 || status < 400;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Wraps data keys with an OpenBao Transit key (`bao:<mount>/<key>@<version>`). The data key
 * goes to OpenBao and back over the connection; the KEK never leaves it. Every failure throws
 * {@link KeyProviderUnavailableError} (no answer, 429, 5xx, sealed; one retry inside
 * `timeoutMs`) or {@link KeyProviderRefusedError} (400, 403 after one fresh login, other 4xx,
 * an answer that is not what was asked for). There is no fallback to any other key.
 */
export class TransitKeyProvider implements KeyProvider {
  readonly #base: URL;
  readonly #mount: string;
  readonly #key: string;
  readonly #auth: TransitAuth;
  readonly #agent: HttpAgent | HttpsAgent;
  readonly #timeoutMs: number;
  readonly #refreshMs: number;
  readonly #onEvent: TransitKeyProviderOptions["onEvent"];
  #token: string | undefined;
  #login: Promise<string> | undefined;
  #active: string | undefined;
  #renewTimer: NodeJS.Timeout | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: TransitKeyProviderOptions) {
    const { address } = options;

    if (address.protocol !== "http:" && address.protocol !== "https:") {
      throw new KeyProviderConfigError(
        "openbao: the address must be an http: or https: URL",
        "address",
      );
    }

    if (address.username !== "" || address.password !== "" || address.search !== "") {
      throw new KeyProviderConfigError(
        "openbao: the address must carry no credentials and no query",
        "address",
      );
    }

    this.#base = new URL(address.href.endsWith("/") ? address.href : `${address.href}/`);
    this.#mount = options.mount ?? "transit";
    this.#key = options.key ?? "os-kek";

    if (!MOUNT.test(this.#mount)) {
      throw new KeyProviderConfigError(
        "openbao: the mount must match [a-z0-9_-]+(/[a-z0-9_-]+)*",
        "mount",
      );
    }

    if (!NAME.test(this.#key)) {
      throw new KeyProviderConfigError("openbao: the key name must match [a-z0-9_-]+", "key");
    }

    this.#timeoutMs = options.timeoutMs ?? 2000;

    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 60_000) {
      throw new KeyProviderConfigError(
        "openbao: timeoutMs must be an integer from 100 to 60000",
        "timeoutMs",
      );
    }

    const refreshSeconds = options.refreshSeconds ?? 300;

    if (!Number.isInteger(refreshSeconds) || refreshSeconds < 0 || refreshSeconds > 86_400) {
      throw new KeyProviderConfigError(
        "openbao: refreshSeconds must be an integer from 0 to 86400",
        "refreshSeconds",
      );
    }

    this.#refreshMs = refreshSeconds * 1000;
    this.#auth = options.auth;
    this.#onEvent = options.onEvent;

    if (this.#base.protocol === "https:") {
      let ca: Buffer | undefined;

      if (options.caFile !== undefined) {
        try {
          ca = readFileSync(options.caFile);
        } catch {
          throw new KeyProviderConfigError("openbao: the CA file cannot be read", "caFile");
        }
      }

      this.#agent = new HttpsAgent({ keepAlive: true, ...(ca ? { ca } : {}) });
    } else {
      if (options.caFile !== undefined) {
        throw new KeyProviderConfigError("openbao: a CA file needs an https: address", "caFile");
      }

      this.#agent = new HttpAgent({ keepAlive: true });
    }
  }

  /**
   * Log in when there is no token, and read the key's latest version, which becomes the active
   * KEK. Each call reads it again; a timer also does every `refreshSeconds`.
   */
  async ready(): Promise<void> {
    const body = await this.#call(
      "read key",
      "GET",
      `v1/${this.#mount}/keys/${this.#key}`,
      undefined,
      undefined,
    );

    const data = record(body?.data);
    const latest = data?.latest_version;

    if (typeof latest !== "number" || !Number.isSafeInteger(latest) || latest < 1) {
      throw new KeyProviderRefusedError(
        `openbao: the key ${this.#mount}/${this.#key} was read without a latest version`,
      );
    }

    if (typeof data?.type !== "string" || AEAD_TYPES[data.type] !== true) {
      throw new KeyProviderRefusedError(
        `openbao: the key ${this.#mount}/${this.#key} is not of a type that authenticates associated data`,
      );
    }

    this.#active = `bao:${this.#mount}/${this.#key}@${latest}`;

    if (this.#refreshMs > 0 && this.#refreshTimer === undefined && !this.#closed) {
      this.#refreshTimer = setInterval(() => {
        const started = Date.now();
        this.ready().catch((error: unknown) => {
          this.#onEvent?.({
            event: "keys.provider_refresh_failed",
            provider: "openbao",
            operation: "read key",
            ...(error instanceof KeyProviderRefusedError && error.status !== undefined
              ? { status: error.status }
              : {}),
            durationMs: Date.now() - started,
          });
        });
      }, this.#refreshMs);
      this.#refreshTimer.unref();
    }
  }

  activeKekId(): string {
    if (this.#active === undefined) {
      throw new KeyProviderUnavailableError("openbao: the provider is not ready yet");
    }

    return this.#active;
  }

  async wrap(kekId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const version = this.#version(kekId);

    const body = await this.#call(
      "encrypt",
      "POST",
      `v1/${this.#mount}/encrypt/${this.#key}`,
      { plaintext: base64(dataKey), associated_data: base64(aad), key_version: version },
      kekId,
    );

    const ciphertext = record(body?.data)?.ciphertext;

    if (typeof ciphertext !== "string" || !ciphertext.startsWith(`vault:v${version}:`)) {
      throw new KeyProviderRefusedError(
        `openbao: encrypt under ${kekId} did not answer with a version ${version} ciphertext`,
        { kekId },
      );
    }

    return new TextEncoder().encode(ciphertext);
  }

  async unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const version = this.#version(kekId);
    let ciphertext: string;

    try {
      ciphertext = new TextDecoder("utf-8", { fatal: true }).decode(wrapped);
    } catch {
      ciphertext = "";
    }

    if (!ciphertext.startsWith(`vault:v${version}:`)) {
      throw new KeyProviderRefusedError(
        `openbao: the wrapped key is not a version ${version} ciphertext of ${kekId}`,
        { kekId },
      );
    }

    const body = await this.#call(
      "decrypt",
      "POST",
      `v1/${this.#mount}/decrypt/${this.#key}`,
      { ciphertext, associated_data: base64(aad) },
      kekId,
    );

    const plaintext = record(body?.data)?.plaintext;
    const key = typeof plaintext === "string" ? Buffer.from(plaintext, "base64") : undefined;

    if (key?.length !== 32) {
      key?.fill(0);
      throw new KeyProviderRefusedError(
        `openbao: decrypt under ${kekId} did not answer with a 32-byte key`,
        { kekId },
      );
    }

    const out = new Uint8Array(key);
    key.fill(0);

    return out;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#renewTimer);
    clearInterval(this.#refreshTimer);
    this.#token = undefined;
    this.#agent.destroy();
  }

  #version(kekId: string): number {
    const match = KEK_ID.exec(kekId);

    if (!match || match[1] !== `${this.#mount}/${this.#key}`) {
      throw new KeyProviderRefusedError(
        `openbao: ${kekId} is not a version of ${this.#mount}/${this.#key}`,
        { kekId },
      );
    }

    return Number(match[2]);
  }

  /**
   * One authenticated operation within `timeoutMs`: one retry of a transient failure when time
   * is left, and one fresh login after a 403.
   */
  async #call(
    operation: string,
    method: "GET" | "POST",
    path: string,
    payload: Record<string, unknown> | undefined,
    kekId: string | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const started = Date.now();
    const deadline = started + this.#timeoutMs;
    let retried = false;
    let relogged = false;

    for (;;) {
      if (this.#closed) {
        throw new KeyProviderUnavailableError("openbao: the provider is closed", { kekId });
      }

      let failure: KeyProviderUnavailableError;

      try {
        const token = await this.#currentToken(deadline);
        const answer = await this.#send(method, path, payload, token, deadline);

        if (answer.status >= 200 && answer.status < 300) return answer.body;

        if (answer.status === 403 && !relogged) {
          relogged = true;

          if (this.#token === token) this.#token = undefined;
          continue;
        }

        if (!transient(answer.status)) {
          throw new KeyProviderRefusedError(
            `openbao: ${operation}${kekId ? ` under ${kekId}` : ""} was refused with status ${answer.status}`,
            { ...(kekId ? { kekId } : {}), status: answer.status },
          );
        }

        failure = new KeyProviderUnavailableError(
          `openbao: ${operation}${kekId ? ` under ${kekId}` : ""} failed with status ${answer.status}`,
          { ...(kekId ? { kekId } : {}), status: answer.status },
        );
      } catch (error) {
        if (!(error instanceof KeyProviderUnavailableError)) throw error;
        failure = error;
      }

      const pause = RETRY_PAUSE_MIN_MS + Math.random() * RETRY_PAUSE_SPREAD_MS;

      if (!retried && deadline - Date.now() > pause + MIN_ATTEMPT_MS) {
        retried = true;
        await sleep(pause);
        continue;
      }

      this.#onEvent?.({
        event: "keys.provider_unavailable",
        provider: "openbao",
        operation,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        durationMs: Date.now() - started,
      });
      throw failure;
    }
  }

  #currentToken(deadline: number): Promise<string> {
    if (this.#token !== undefined) return Promise.resolve(this.#token);
    this.#login ??= this.#logIn(deadline).finally(() => {
      this.#login = undefined;
    });

    return this.#login;
  }

  async #logIn(deadline: number): Promise<string> {
    const auth = this.#auth;

    if (auth.kind === "token") {
      const token = this.#readCredential(auth.tokenFile, "tokenFile");

      const data = record(
        this.#expect(
          "token lookup",
          await this.#send("GET", "v1/auth/token/lookup-self", undefined, token, deadline),
        )?.data,
      );

      this.#adopt(token, data?.ttl, data?.renewable === true);

      return token;
    }

    const answer =
      auth.kind === "approle"
        ? await this.#send(
            "POST",
            "v1/auth/approle/login",
            {
              role_id: this.#readCredential(auth.roleIdFile, "roleIdFile"),
              secret_id: this.#readCredential(auth.secretIdFile, "secretIdFile"),
            },
            undefined,
            deadline,
          )
        : await this.#send(
            "POST",
            "v1/auth/kubernetes/login",
            { role: auth.role, jwt: this.#readCredential(auth.jwtFile, "jwtFile") },
            undefined,
            deadline,
          );

    const result = record(this.#expect("login", answer)?.auth);
    const token = result?.client_token;

    if (typeof token !== "string" || token === "") {
      throw new KeyProviderRefusedError("openbao: the login answered without a token");
    }

    this.#adopt(token, result?.lease_duration, result?.renewable === true);

    return token;
  }

  /** Use a token, and renew it, or drop it for a fresh login, at two thirds of its TTL. */
  #adopt(token: string, ttlSeconds: unknown, renewable: boolean): void {
    if (this.#closed) throw new KeyProviderUnavailableError("openbao: the provider is closed");
    this.#token = token;
    clearTimeout(this.#renewTimer);
    this.#renewTimer = undefined;

    if (typeof ttlSeconds !== "number" || !(ttlSeconds > 0)) return;
    const delay = Math.min(Math.floor((ttlSeconds * 2000) / 3), MAX_TIMER_MS);
    this.#renewTimer = setTimeout(() => void this.#renew(token, renewable), delay);
    this.#renewTimer.unref();
  }

  async #renew(token: string, renewable: boolean): Promise<void> {
    if (this.#closed || this.#token !== token) return;

    if (renewable) {
      try {
        const answer = await this.#send(
          "POST",
          "v1/auth/token/renew-self",
          {},
          token,
          Date.now() + this.#timeoutMs,
        );

        const result = record(answer.body?.auth);
        const lease = result?.lease_duration;

        if (answer.status === 200 && typeof lease === "number" && lease >= 3) {
          if (this.#token === token && !this.#closed) {
            this.#adopt(token, lease, result?.renewable === true);
          }

          return;
        }
      } catch {
        // Not renewed: the next operation logs in again.
      }
    }

    if (this.#token === token) this.#token = undefined;
  }

  #readCredential(file: string, option: string): string {
    let value = "";

    try {
      value = readFileSync(file, "utf8").trim();
    } catch {
      // Reported below without the file's path or contents.
    }

    // A sidecar that writes the file may not have written it yet, so this is worth a retry.
    if (value === "") {
      throw new KeyProviderUnavailableError(`openbao: the ${option} is empty or cannot be read`);
    }

    return value;
  }

  #expect(operation: string, answer: Answer): Record<string, unknown> | undefined {
    if (answer.status >= 200 && answer.status < 300) return answer.body;

    if (transient(answer.status)) {
      throw new KeyProviderUnavailableError(
        `openbao: ${operation} failed with status ${answer.status}`,
        { status: answer.status },
      );
    }

    throw new KeyProviderRefusedError(
      `openbao: ${operation} was refused with status ${answer.status}`,
      { status: answer.status },
    );
  }

  /** One HTTP exchange, abandoned at `deadline`. Never rejects with anything but "unavailable". */
  #send(
    method: "GET" | "POST",
    path: string,
    payload: Record<string, unknown> | undefined,
    token: string | undefined,
    deadline: number,
  ): Promise<Answer> {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      return Promise.reject(
        new KeyProviderUnavailableError(`openbao: no answer within ${this.#timeoutMs} ms`),
      );
    }

    const url = new URL(path, this.#base);
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const signal = AbortSignal.timeout(remaining);
    const { promise, resolve, reject } = Promise.withResolvers<Answer>();

    const fail = (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      reject(
        new KeyProviderUnavailableError(
          signal.aborted
            ? `openbao: no answer within ${this.#timeoutMs} ms`
            : `openbao: the server could not be reached${typeof code === "string" ? ` (${code})` : ""}`,
        ),
      );
    };

    const send = url.protocol === "https:" ? httpsRequest : httpRequest;

    const request = send(
      url,
      {
        method,
        agent: this.#agent,
        signal,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
          ...(token ? { "x-vault-token": token } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;

          if (size > MAX_ANSWER_BYTES) {
            request.destroy(new Error("answer too large"));

            return;
          }

          chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          let parsed: unknown;

          try {
            parsed = size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = undefined;
          }

          resolve({ status: response.statusCode ?? 0, body: record(parsed) });
        });
      },
    );

    request.on("error", fail);
    request.end(body);

    return promise;
  }
}
