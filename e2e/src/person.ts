import { setTimeout as delay } from "node:timers/promises";
import {
  type ApiClient,
  type ApprovalDetail,
  type ApprovalSummary,
  createApiClient,
  type MandateDraft,
  type MandateSummary,
  RegistrationResponse,
  type SessionInfo,
} from "@askgina/os-api";
import { AssertionResponse, ConfirmationView } from "@askgina/os-protocol";
import {
  CONFIRM_TOKEN_HEADER,
  GetPossessionResponse,
  SignerErrorBody,
  SubmitConfirmationResponse,
  SubmitPossessionResponse,
} from "@askgina/os-protocol/signer";
import { b64url, SoftAuthenticator } from "@askgina/os-protocol/testing";

/** The confirmation page refused a request, with the signer's (or the `approve` service's) code. */
export class ConfirmationRefused extends Error {
  override readonly name = "ConfirmationRefused";
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(`the confirmation page refused with ${status} ${code}`);
    this.code = code;
    this.status = status;
  }
}

/** A link to the signer's confirmation page, split the way the page itself reads it. */
export interface ConfirmationLink {
  /** The page's origin, which the browser writes into every assertion made there. */
  origin: string;
  approvalId: string;
  /** From the fragment: it never reaches a server in a path or a query. */
  token: string;
}

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

  /**
   * What the browser returns when a page at `origin` asks this person's passkey to sign
   * `challenge` (base64url): the browser writes the page's origin into the assertion, and no page
   * script can change it. Sign-in happens on the control plane's origin; an approval counts only
   * when made on the confirmation page's.
   */
  assertion(challenge: string, origin: string): AssertionResponse {
    if (this.credentialId === undefined) throw new Error(`${this.name} has no passkey yet`);

    return AssertionResponse.parse(
      this.authenticator.authenticate({ credentialId: this.credentialId, challenge, origin }),
    );
  }

  /** Claim a fresh installation with a setup token from the operator's command. */
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
      body: { ceremonyId, response: this.assertion(options.challenge as string, this.origin) },
    });
  }

  async signOut(): Promise<void> {
    await this.api.call("logout", { body: {} });
  }

  /** The confirmation page's link the approval page shows for a request that waits. */
  async confirmationLink(approvalId: string): Promise<ConfirmationLink> {
    const { confirmUrl } = await this.api.call("getApproval", { params: { approvalId } });

    if (confirmUrl === null) throw new Error(`${approvalId} shows no confirmation page`);
    const url = new URL(confirmUrl);
    const id = /^\/a\/([^/]+)$/.exec(url.pathname)?.[1];

    if (id !== approvalId || url.search !== "" || url.hash.length < 2) {
      throw new Error(`${approvalId} links to an unexpected confirmation page`);
    }

    return { origin: url.origin, approvalId: id, token: url.hash.slice(1) };
  }

  /** What the confirmation page shows for `link`, fetched as the page fetches it. */
  async readConfirmation(link: ConfirmationLink): Promise<ConfirmationView> {
    const response = await fetch(`${link.origin}/api/approvals/${link.approvalId}`, {
      headers: { [CONFIRM_TOKEN_HEADER]: link.token },
      redirect: "manual",
    });

    return ConfirmationView.parse(await answerOf(response));
  }

  /**
   * Send an approval to the confirmation page at `link`, as the page does. By default it is made
   * there, signing the view's challenge at that page's origin; `response` sends one the passkey
   * made elsewhere. The signer stores an approval it accepts; the control plane counts it when it
   * collects.
   */
  async approveOnConfirmationPage(
    link: ConfirmationLink,
    view: ConfirmationView,
    response: AssertionResponse = this.assertion(view.webauthn.challenge, link.origin),
  ): Promise<SubmitConfirmationResponse> {
    const answer = await fetch(`${link.origin}/api/approvals/${link.approvalId}/assertions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: link.origin,
        [CONFIRM_TOKEN_HEADER]: link.token,
      },
      body: JSON.stringify({ response }),
      redirect: "manual",
    });

    return SubmitConfirmationResponse.parse(await answerOf(answer));
  }

  /**
   * The challenge the confirmation page at `link` asks the new passkey of an approver change to
   * answer, fetched as the page fetches it when the person being added presses "This passkey is
   * mine".
   */
  async readPossession(link: ConfirmationLink): Promise<GetPossessionResponse> {
    const response = await fetch(`${link.origin}/api/approvals/${link.approvalId}/possession`, {
      headers: { [CONFIRM_TOKEN_HEADER]: link.token },
      redirect: "manual",
    });

    return GetPossessionResponse.parse(await answerOf(response));
  }

  /**
   * Answer the possession step on the confirmation page at `link`, as the page does: by default
   * with this person's passkey, signing `options`' challenge at that page's origin; `response`
   * sends another answer. The signer records the proof if it accepts it.
   */
  async proveOnConfirmationPage(
    link: ConfirmationLink,
    options: GetPossessionResponse,
    response: AssertionResponse = this.assertion(options.challenge, link.origin),
  ): Promise<SubmitPossessionResponse> {
    const answer = await fetch(`${link.origin}/api/approvals/${link.approvalId}/possession`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: link.origin,
        [CONFIRM_TOKEN_HEADER]: link.token,
      },
      body: JSON.stringify({ response }),
      redirect: "manual",
    });

    return SubmitPossessionResponse.parse(await answerOf(answer));
  }

  /**
   * As the person being added does before anyone can approve their passkey: follow the approver
   * change's link to the confirmation page and prove there that the passkey is theirs. Returns
   * the fingerprint the page shows them, to read to the people who approve.
   */
  async provePossession(approvalId: string): Promise<string> {
    const link = await this.confirmationLink(approvalId);

    const { fingerprint } = await this.proveOnConfirmationPage(
      link,
      await this.readPossession(link),
    );

    return fingerprint;
  }

  /**
   * Approve a request the only way there is: follow the link the approval page shows to the
   * signer's confirmation page, read it there, approve there, then let the control plane collect.
   */
  async confirm(approvalId: string): Promise<ApprovalDetail> {
    const link = await this.confirmationLink(approvalId);
    await this.approveOnConfirmationPage(link, await this.readConfirmation(link));

    return this.api.call("collectApproval", { params: { approvalId }, body: {} });
  }

  async reject(approvalId: string): Promise<ApprovalDetail> {
    return this.api.call("reject", { params: { approvalId }, body: {} });
  }

  /**
   * As an owner: ask to let one agent pay from `walletId` within `draft` with no person asked
   * per payment. Opens a `grant-mandate` request at the workspace's admin threshold, approved
   * like every other request on the signer's confirmation page ({@link confirm}).
   */
  async proposeMandate(
    workspaceId: string,
    walletId: string,
    draft: MandateDraft,
  ): Promise<ApprovalSummary> {
    return this.api.call("proposeMandate", { params: { workspaceId, walletId }, body: draft });
  }

  /** As an owner or approver: end a mandate for good. No passkey: it only removes authority. */
  async revokeMandate(workspaceId: string, mandateId: string): Promise<MandateSummary> {
    return this.api.call("revokeMandate", { params: { workspaceId, mandateId }, body: {} });
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

/** The JSON of a successful answer from the confirmation page, or its refusal as an error. */
async function answerOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);

  if (response.ok) return body;
  const refusal = SignerErrorBody.safeParse(body);
  throw new ConfirmationRefused(
    refusal.success ? refusal.data.error.code : "unreadable",
    response.status,
  );
}
