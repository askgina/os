// @ts-check
/**
 * The fixture's stand-in for the signer's confirmation page, for development and the UI journey
 * only. It shows the request as the fixture holds it, asks the passkey on this origin, sends the
 * answer to the fixture, which holds the approval as the signer would, and goes back to the
 * request. The real page is `apps/approve/public/approve.js`.
 *
 * Like the real page, an approver change has one more step, for the person being added: they
 * answer with the new passkey ("This passkey is mine"), and the page shows them its fingerprint.
 * Approving waits until then.
 *
 * Built with createElement and textContent only, under a Content-Security-Policy that refuses
 * inline code.
 */

/**
 * @typedef {{
 *   approvalId: string;
 *   title: string;
 *   warnings: string[];
 *   lines: { label: string; value: string }[];
 *   state: "open" | "complete" | "closed";
 *   approvals: { collected: number; required: number };
 *   possession: "none" | "unproven" | "proven";
 *   webauthn: PasskeyRequest;
 *   returnUrl: string;
 * }} View
 */

/**
 * @typedef {{
 *   challenge: string;
 *   rpId: string;
 *   allowCredentials: string[];
 *   userVerification: UserVerificationRequirement;
 *   timeoutMs: number;
 * }} PasskeyRequest
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
 * Ask the passkey for an answer to `webauthn`, and send it to `path` on this page's API. Null
 * after saying so in `result` when there is no answer; otherwise the fixture's reply.
 * @param {PasskeyRequest} webauthn
 * @param {string} path
 * @param {string} token
 * @param {HTMLElement} result
 * @param {string} nothing what did not happen
 * @returns {Promise<{ ok: boolean; body: unknown } | null>}
 */
async function answerWithPasskey(webauthn, path, token, result, nothing) {
  result.className = "";
  result.textContent = "Waiting for your passkey…";
  const credential = await navigator.credentials
    .get({
      publicKey: {
        challenge: fromBase64Url(webauthn.challenge),
        rpId: webauthn.rpId,
        allowCredentials: webauthn.allowCredentials.map((id) => ({
          type: "public-key",
          id: fromBase64Url(id),
        })),
        userVerification: webauthn.userVerification,
        timeout: webauthn.timeoutMs,
      },
    })
    .catch(() => null);
  if (
    !(credential instanceof PublicKeyCredential) ||
    !(credential.response instanceof AuthenticatorAssertionResponse)
  ) {
    result.className = "refusal";
    result.textContent = `Your passkey did not answer. ${nothing} Try again.`;
    return null;
  }
  const { response } = credential;
  const answer = await fetch(path, {
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
  return { ok: answer.ok, body: await answer.json().catch(() => null) };
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
  const answer = await answerWithPasskey(
    view.webauthn,
    `/api/approvals/${encodeURIComponent(view.approvalId)}/assertions`,
    token,
    result,
    "Nothing was approved.",
  );
  if (answer === null) {
    button.disabled = false;
    return;
  }
  if (!answer.ok) {
    result.className = "refusal";
    result.textContent = errorMessage(answer.body);
    return;
  }
  const held = /** @type {{ collected: number; required: number }} */ (answer.body);
  button.hidden = true;
  result.textContent = `The fixture holds your approval: ${held.collected} of ${held.required}. Taking you back to the request…`;
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
  ];
  // Shown before the lines, as the real page shows the signer's warnings.
  if (view.warnings.length > 0) {
    const warnings = element("ul");
    warnings.className = "warnings";
    warnings.setAttribute("aria-label", "Warnings");
    for (const warning of view.warnings) warnings.append(element("li", warning));
    parts.push(warnings);
  }
  parts.push(lines);
  if (view.state === "open") {
    const decide = element("section");
    decide.setAttribute("aria-label", "Decision");
    const button = element("button", "Approve with passkey");
    button.type = "button";
    const result = element("p");
    result.setAttribute("role", "status");
    button.addEventListener("click", () => void approve(view, token, button, result));
    if (view.possession !== "none") {
      decide.append(
        element(
          "p",
          "Before you approve, ask the person being added to read you the fingerprint their page showed them, over a call or in person. Approve only if it matches the key fingerprint above.",
        ),
      );
    }
    if (view.possession === "unproven") {
      const waiting = element(
        "p",
        "Approving opens once the person being added has proven on this page that the passkey is theirs. Reload this page after they have.",
      );
      button.disabled = true;
      decide.append(waiting);
      parts.push(
        possessionStep(view, token, () => {
          button.disabled = false;
          waiting.remove();
        }),
      );
    }
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

/**
 * The possession step, for the person being added: the challenge only the new passkey may
 * answer is fetched when the step is shown; after the answer, the page shows the key's
 * fingerprint to read out.
 * @param {View} view
 * @param {string} token
 * @param {() => void} proven
 * @returns {HTMLElement}
 */
function possessionStep(view, token, proven) {
  const section = element("section");
  section.setAttribute("aria-label", "The new passkey");
  const button = element("button", "This passkey is mine");
  button.type = "button";
  button.disabled = true;
  const result = element("p");
  result.setAttribute("role", "status");
  const path = `/api/approvals/${encodeURIComponent(view.approvalId)}/possession`;
  /** @type {PasskeyRequest | null} */
  let challenge = null;
  void fetch(path, { headers: { [TOKEN_HEADER]: token }, cache: "no-store", credentials: "omit" })
    .then(async (answer) => {
      const body = await answer.json().catch(() => null);
      if (!answer.ok) {
        result.className = "refusal";
        result.textContent = errorMessage(body);
        return;
      }
      challenge = /** @type {PasskeyRequest} */ (body);
      button.disabled = false;
    })
    .catch(() => {
      result.className = "refusal";
      result.textContent = "The fixture did not answer.";
    });
  button.addEventListener("click", async () => {
    if (challenge === null) return;
    button.disabled = true;
    const answer = await answerWithPasskey(challenge, path, token, result, "Nothing was proven.");
    if (answer === null) {
      button.disabled = false;
      return;
    }
    if (!answer.ok) {
      result.className = "refusal";
      result.textContent = errorMessage(answer.body);
      return;
    }
    const { fingerprint } = /** @type {{ fingerprint: string }} */ (answer.body);
    button.hidden = true;
    const shown = element("strong", fingerprint);
    shown.className = "fingerprint";
    result.className = "";
    result.replaceChildren(
      "The signer checked that this passkey is yours. Its fingerprint is ",
      shown,
      ". Read it to the people who approve over a call or in person, not through this site or a message it sent. They approve only if it matches the fingerprint their page shows.",
    );
    proven();
  });
  section.append(
    element("h2", "Are you the person being added?"),
    element(
      "p",
      "Prove that the new passkey is yours, on the device where you just made it. Only you do this step. The people who approve wait for it, then compare the fingerprint with you.",
    ),
    button,
    result,
  );
  return section;
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
