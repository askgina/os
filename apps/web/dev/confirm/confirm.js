// @ts-check
/**
 * The fixture's stand-in for the signer's confirmation page, for development and the UI journey
 * only. It shows the request as the fixture holds it, asks the passkey on this origin, sends the
 * answer to the fixture, which holds the approval as the signer would, and goes back to the
 * request. The real page is `apps/approve/public/approve.js`.
 *
 * Built with createElement and textContent only, under a Content-Security-Policy that refuses
 * inline code.
 */

/**
 * @typedef {{
 *   approvalId: string;
 *   title: string;
 *   lines: { label: string; value: string }[];
 *   state: "open" | "complete" | "closed";
 *   approvals: { collected: number; required: number };
 *   webauthn: {
 *     challenge: string;
 *     rpId: string;
 *     allowCredentials: string[];
 *     userVerification: UserVerificationRequirement;
 *     timeoutMs: number;
 *   };
 *   returnUrl: string;
 * }} View
 */

const TOKEN_HEADER = "x-confirm-token";
/** How long the result stays on screen before the page goes back to the request. */
const RETURN_DELAY_MS = 1_000;

const STATE_TEXT = {
  open: "Waiting for approval:",
  complete: "Enough approvals are in. Go back to the request to see it applied.",
  closed: "This request no longer waits for approval.",
};

/**
 * @param {string} text unpadded base64url
 * @returns {ArrayBuffer}
 */
function fromBase64Url(text) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string} unpadded base64url
 */
function toBase64Url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The message of an error body the fixture sent.
 * @param {unknown} body
 * @returns {string}
 */
function errorMessage(body) {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body;
    if (typeof error === "object" && error !== null && "message" in error) {
      return String(error.message);
    }
  }
  return "The fixture did not answer.";
}

/**
 * Ask the passkey, send its answer, and go back to the request.
 * @param {View} view
 * @param {string} token
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} result
 */
async function approve(view, token, button, result) {
  button.disabled = true;
  result.className = "";
  result.textContent = "Waiting for your passkey…";
  const credential = await navigator.credentials
    .get({
      publicKey: {
        challenge: fromBase64Url(view.webauthn.challenge),
        rpId: view.webauthn.rpId,
        allowCredentials: view.webauthn.allowCredentials.map((id) => ({
          type: "public-key",
          id: fromBase64Url(id),
        })),
        userVerification: view.webauthn.userVerification,
        timeout: view.webauthn.timeoutMs,
      },
    })
    .catch(() => null);
  if (
    !(credential instanceof PublicKeyCredential) ||
    !(credential.response instanceof AuthenticatorAssertionResponse)
  ) {
    result.className = "refusal";
    result.textContent = "Your passkey did not answer. Nothing was approved. Try again.";
    button.disabled = false;
    return;
  }
  const { response } = credential;
  const answer = await fetch(`/api/approvals/${encodeURIComponent(view.approvalId)}/assertions`, {
    method: "POST",
    headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
    body: JSON.stringify({
      response: {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: "public-key",
        response: {
          clientDataJSON: toBase64Url(response.clientDataJSON),
          authenticatorData: toBase64Url(response.authenticatorData),
          signature: toBase64Url(response.signature),
          ...(response.userHandle === null ? {} : { userHandle: toBase64Url(response.userHandle) }),
        },
        clientExtensionResults: {},
      },
    }),
    cache: "no-store",
    credentials: "omit",
  });
  const body = await answer.json().catch(() => null);
  if (!answer.ok) {
    result.className = "refusal";
    result.textContent = errorMessage(body);
    return;
  }
  button.hidden = true;
  result.textContent = `The fixture holds your approval: ${body.collected} of ${body.required}. Taking you back to the request…`;
  setTimeout(() => location.assign(view.returnUrl), RETURN_DELAY_MS);
}

/**
 * @param {HTMLElement} main
 * @param {View} view
 * @param {string} token
 */
function render(main, view, token) {
  const { collected, required } = view.approvals;
  const lines = element("dl");
  for (const line of view.lines) lines.append(element("dt", line.label), element("dd", line.value));
  /** @type {HTMLElement[]} */
  const parts = [
    element("h1", view.title),
    element(
      "p",
      view.state === "open"
        ? `${STATE_TEXT.open} ${collected} of ${required} so far.`
        : STATE_TEXT[view.state],
    ),
    lines,
  ];
  if (view.state === "open") {
    const decide = element("section");
    decide.setAttribute("aria-label", "Decision");
    const button = element("button", "Approve with passkey");
    button.type = "button";
    const result = element("p");
    result.setAttribute("role", "status");
    button.addEventListener("click", () => void approve(view, token, button, result));
    decide.append(button, result);
    parts.push(decide);
  }
  const link = element("a", "Back to the request");
  link.href = view.returnUrl;
  const back = element("p");
  back.append(link);
  parts.push(back);
  main.replaceChildren(...parts);
}

async function start() {
  const main = document.getElementById("main");
  const origin = document.getElementById("origin");
  if (main === null || origin === null) return;
  origin.textContent = location.origin;
  const approvalId = /^\/a\/([^/]+)$/.exec(location.pathname)?.[1] ?? "";
  const token = location.hash.slice(1);
  const answer = await fetch(`/api/approvals/${approvalId}`, {
    headers: { [TOKEN_HEADER]: token },
    cache: "no-store",
    credentials: "omit",
  });
  const body = await answer.json().catch(() => null);
  if (!answer.ok) {
    const refusal = element("p", errorMessage(body));
    refusal.className = "refusal";
    main.replaceChildren(refusal);
    return;
  }
  render(main, body, token);
}

void start();
