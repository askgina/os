import { setTimeout as delay } from "node:timers/promises";
import {
  type ApiClient,
  type ApprovalDetail,
  createApiClient,
  RegistrationResponse,
  type SessionInfo,
} from "@askgina/os-api";
import { AssertionResponse } from "@askgina/os-protocol";
import { b64url, SoftAuthenticator } from "@askgina/os-protocol/testing";

/**
 * A person using the product, without a browser. They hold a passkey in a software
 * authenticator, keep their session cookie, and send the `Origin` a page of the app would send.
 * To the server this is indistinguishable from a browser: registration and assertions go through
 * the same verification as a real passkey.
 */
export class Person {
  readonly name: string;
  readonly origin: string;
  readonly api: ApiClient;
  readonly authenticator = new SoftAuthenticator();
  /** base64url id of this person's passkey, once registered. */
  credentialId: string | undefined;
  readonly #cookies = new Map<string, string>();

  constructor(origin: string, name: string) {
    this.origin = origin;
    this.name = name;
    this.api = createApiClient({
      baseUrl: origin,
      fetch: (input, init) => this.#fetch(input, init),
    });
  }

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("origin", this.origin);
    if (this.#cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await fetch(input, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired || value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return response;
  }

  get signedIn(): boolean {
    return this.#cookies.size > 0;
  }

  /** Answer a registration ceremony the server started, creating this person's passkey. */
  #register(options: Record<string, unknown>) {
    const rp = options.rp as { id: string };
    const user = options.user as { id: string };
    const { response, credential } = this.authenticator.register({
      rpId: rp.id,
      challenge: options.challenge as string,
      origin: this.origin,
      userHandle: new Uint8Array(Buffer.from(user.id, "base64url")),
    });
    this.credentialId = b64url(credential.id);
    return RegistrationResponse.parse(response);
  }

  /** Answer a sign-in or approval ceremony with this person's passkey. */
  #assert(options: Record<string, unknown>) {
    if (this.credentialId === undefined) throw new Error(`${this.name} has no passkey yet`);
    return AssertionResponse.parse(
      this.authenticator.authenticate({
        credentialId: this.credentialId,
        challenge: options.challenge as string,
        origin: this.origin,
      }),
    );
  }

  /** Claim a fresh installation with its setup token. */
  async setUp(setupToken: string): Promise<SessionInfo> {
    const { ceremonyId, options } = await this.api.call("startSetup", {
      body: { setupToken, displayName: this.name },
    });
    return this.api.call("finishSetup", {
      body: { ceremonyId, response: this.#register(options) },
    });
  }

  /** Join a workspace through an invite link, registering a passkey on the way. */
  async join(inviteUrl: string): Promise<SessionInfo> {
    const token = new URL(inviteUrl).pathname.split("/").at(-1) ?? "";
    const { ceremonyId, options } = await this.api.call("startInviteRegistration", {
      params: { token },
      body: { displayName: this.name },
    });
    return this.api.call("finishInviteRegistration", {
      params: { token },
      body: { ceremonyId, response: this.#register(options) },
    });
  }

  async signIn(): Promise<SessionInfo> {
    const { ceremonyId, options } = await this.api.call("startLogin", { body: {} });
    return this.api.call("finishLogin", {
      body: { ceremonyId, response: this.#assert(options) },
    });
  }

  async signOut(): Promise<void> {
    await this.api.call("logout", { body: {} });
  }

  /** Approve a request with the passkey, exactly as the approval page does. */
  async approve(approvalId: string): Promise<ApprovalDetail> {
    const { options } = await this.api.call("startApproval", {
      params: { approvalId },
      body: {},
    });
    return this.api.call("approve", {
      params: { approvalId },
      body: { response: this.#assert(options) },
    });
  }

  async reject(approvalId: string): Promise<ApprovalDetail> {
    return this.api.call("reject", { params: { approvalId }, body: {} });
  }

  /** Wait until an approval request leaves `pending`/`approved`, and return it. */
  async settled(approvalId: string, timeoutMs = 60_000): Promise<ApprovalDetail> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const approval = await this.api.call("getApproval", { params: { approvalId } });
      if (approval.status !== "pending" && approval.status !== "approved") return approval;
      if (Date.now() > deadline) {
        throw new Error(`approval ${approvalId} is still ${approval.status} after ${timeoutMs} ms`);
      }
      await delay(250);
    }
  }
}
