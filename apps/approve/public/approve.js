// @ts-check
/**
 * The confirmation page. It shows one approval as the signer holds it and asks the person's
 * passkey to approve it here, on an origin the control plane does not serve, so the browser
 * writes this origin into the assertion and the signer can tell it apart.
 *
 * Hand-written, with no dependencies and no framework: everything is built with createElement
 * and textContent, under a Content-Security-Policy whose Trusted Types turn any other way of
 * making markup from a string into an error. Everything shown comes from the signer through the
 * `approve` service; nothing here decides what a request means.
 *
 * An approver change has one more step, for the person being added: they prove here, with the
 * passkey the request adds, that it is theirs, and the page shows them its fingerprint to read
 * to the people who approve. Approving waits until that step is done.
 *
 * The exports are pure helpers for the tests. The page starts itself when a browser runs it.
 */

/** @typedef {import("@askgina/os-protocol").ConfirmationView} ConfirmationView */
/** @typedef {import("@askgina/os-protocol").ConfirmationState} ConfirmationState */
/** @typedef {import("@askgina/os-protocol").ConfirmationWarning} ConfirmationWarning */
/** @typedef {import("@askgina/os-protocol").AssertionResponse} AssertionResponse */
/** @typedef {import("@askgina/os-protocol").PasskeyRequest} PasskeyRequest */
/** @typedef {import("@askgina/os-protocol/signer").SignerErrorCode} SignerErrorCode */
/** @typedef {import("@askgina/os-protocol/signer").SubmitConfirmationResponse} SubmitConfirmationResponse */
/** @typedef {import("@askgina/os-protocol/signer").SubmitPossessionResponse} SubmitPossessionResponse */

/**
 * The parts of a `PublicKeyCredential` from `navigator.credentials.get` that the signer checks.
 * @typedef {{
 *   id: string,
 *   rawId: ArrayBuffer,
 *   type: string,
 *   response: {
 *     clientDataJSON: ArrayBuffer,
 *     authenticatorData: ArrayBuffer,
 *     signature: ArrayBuffer,
 *     userHandle: ArrayBuffer | null,
 *   },
 *   getClientExtensionResults(): AuthenticationExtensionsClientOutputs,
 * }} AssertionCredential
 */

/** The header the token travels in. It never goes into a URL the server sees. */
const TOKEN_HEADER = "x-confirm-token";
/** How long the page shows its result before it goes back to the request. */
const RETURN_DELAY_MS = 2_000;

/** @type {Record<ConfirmationState, string>} */
export const STATE_TEXT = {
  open: "Waiting for approvals.",
  complete: "Enough people approved this request. Nothing is left to do here.",
  expired: "This request expired before enough people approved it. Nothing was signed or changed.",
  revoked: "This request was rejected or withdrawn. The signer will never act on it.",
  used: "The signer already acted on this request. It cannot be approved again.",
  superseded:
    "The signer will never act on this request: the wallet's limits changed since it was proposed, or it was made before the signer was restored from a backup. Ask for it again.",
};

/** @type {Record<ConfirmationWarning, string>} */
export const WARNING_TEXT = {
  keys_destroyed:
    "After the time below the signer destroys these keys. Whatever is still in these wallets then is lost for good.",
  balances_unchecked:
    "The signer cannot see balances, so nothing on this page says these wallets are empty. Check them before you approve.",
  raw_contract_call:
    "A raw contract call. The signer cannot say what it does: approve only if you know this contract and this data.",
  unknown_token:
    "The signer does not know this token's name or decimals, so the amount is shown in base units.",
  unknown_chain: "The signer does not know this network's name.",
  recipient_not_allowlisted:
    "The recipient is not on this wallet's list of allowed recipients, so the signer will refuse it.",
  over_remaining_daily_cap:
    "This is more than the wallet may still send in the last 24 hours, so the signer will refuse it.",
  first_policy: "This is the wallet's first policy: everything below is new.",
  possession_unproven:
    "The person being added has not yet proven on this page that they hold this passkey. Approving waits until they have.",
};

/** @type {Record<SignerErrorCode, string>} */
export const REFUSAL_TEXT = {
  invalid_request: "The signer could not read what this page sent. Reload the page and try again.",
  unauthenticated: "This page is not set up to reach the signer. Tell whoever runs this server.",
  not_found:
    "This link does not open a request. It is incomplete or no longer valid: open the request where you were asked to approve it and follow its link again.",
  conflict: "You already approved this request.",
  confirmation_closed:
    "This request no longer takes approvals: it was approved, rejected, used or replaced, or it expired.",
  possession_unproven:
    "The person being added has not yet proven on this page that the new passkey is theirs. Ask them to open this link and do that first, then reload this page.",
  rate_limited:
    "Too many approvals were tried for this request, so the signer takes no more for it.",
  workspace_paused: "This workspace is paused. The signer refuses everything until it is resumed.",
  approval_revoked: "This request was rejected or withdrawn.",
  envelope_mismatch: "This request does not match what it names, so the signer refuses it.",
  envelope_expired: "This request expired.",
  envelope_not_yet_valid: "This request is dated in the future. The servers' clocks disagree.",
  envelope_ttl_too_long: "This request stays open longer than the signer allows.",
  envelope_fenced:
    "This request was made before the signer was restored from a backup. Ask for it again.",
  nonce_reused: "This request was already used.",
  intent_mismatch: "The payment does not match what the request names, so the signer refuses it.",
  policy_missing: "This wallet has no limits at the signer yet.",
  policy_changed: "The wallet's limits changed since this was proposed. Ask for it again.",
  policy_denied: "The wallet's limits do not allow this.",
  policy_invalid: "These limits are not valid.",
  fee_cap_exceeded: "The network fee is above the ceiling the request allows.",
  insufficient_approvals: "Not enough people approved this yet.",
  assertion_invalid:
    "The signer did not accept your passkey's answer. It must come from this page, for this request. Try again.",
  approver_unknown:
    "This passkey does not approve for this workspace. Try again with the passkey you approve with.",
  threshold_unreachable: "Not enough approvers are left to approve this.",
  sweep_destination_not_allowed:
    "The signer sends a sweep only to the treasury or to an allowed recipient.",
  mandate_revoked: "This mandate was revoked. Nothing more is paid under it.",
  mandate_expired: "This mandate has ended.",
  mandate_not_yet_valid: "This mandate has not started yet.",
  mandate_denied: "This mandate does not cover this payment.",
  mandate_invalid:
    "The signer refuses this mandate: it does not fit the wallet's limits, or it lasts too long.",
  fee_not_raised: "The network fee must be higher than the transaction's last attempt.",
  attempts_exhausted:
    "This transaction has as many attempts as the signer allows, so it signs no more for it.",
  reprice_window_closed:
    "This transaction can no longer have its fee raised without approval. Cancel it instead.",
  workspace_deleting: "This workspace is being deleted. The signer refuses everything else for it.",
  workspace_deleted: "This workspace was deleted. The signer refuses everything for it.",
  wallet_retired: "This wallet is retired. The signer signs nothing for it.",
  wallet_set_mismatch:
    "The wallets in this request are not the workspace's wallets at the signer. Ask for it again.",
  destroy_delay_out_of_range:
    "The destroy time is sooner or later than the signer allows. Ask for it again.",
  destroy_not_due: "The destroy time has not come yet.",
  vault_error: "The signer's key store failed. Try again later.",
  internal: "The signer could not be reached or failed. Try again in a moment.",
};

/** @type {Partial<Record<SignerErrorCode, true>>} Refusals after which approving again here can work. */
const RETRYABLE = {
  invalid_request: true,
  assertion_invalid: true,
  approver_unknown: true,
  vault_error: true,
  internal: true,
};

/**
 * What to tell a person for a refusal code, including one this page does not know.
 * @param {string} code
 * @returns {string}
 */
export function refusalText(code) {
  return Object.hasOwn(REFUSAL_TEXT, code)
    ? REFUSAL_TEXT[/** @type {SignerErrorCode} */ (code)]
    : REFUSAL_TEXT.internal;
}

/**
 * Unpadded base64url, the encoding of every binary field the signer reads.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function toBase64Url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} text unpadded base64url
 * @returns {ArrayBuffer}
 */
export function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * Where the possession step of a request stands: `none` for anything but an approver change,
 * `unproven` until the person being added proved on this page that the new passkey is theirs,
 * `proven` after. Approving an approver change waits for `proven`.
 * @param {ConfirmationView} view
 * @returns {"none" | "unproven" | "proven"}
 */
export function possessionOf(view) {
  if (view.kind !== "add-approver") return "none";
  return view.warnings.includes("possession_unproven") ? "unproven" : "proven";
}

/**
 * The browser's request options for a challenge from the signer: the envelope's digest, or the
 * possession step's. Converted by hand rather than with
 * `PublicKeyCredential.parseRequestOptionsFromJSON`, which older browsers lack.
 * @param {PasskeyRequest} webauthn
 * @returns {PublicKeyCredentialRequestOptions}
 */
export function requestOptions(webauthn) {
  return {
    challenge: fromBase64Url(webauthn.challenge),
    rpId: webauthn.rpId,
    allowCredentials: webauthn.allowCredentials.map((id) => ({
      type: "public-key",
      id: fromBase64Url(id),
    })),
    userVerification: webauthn.userVerification,
    timeout: webauthn.timeoutMs,
  };
}

/**
 * The assertion as the JSON the signer verifies. Encoded by hand rather than with
 * `PublicKeyCredential.toJSON`, which older browsers lack.
 * @param {AssertionCredential} credential
 * @returns {AssertionResponse}
 */
export function encodeAssertion(credential) {
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: "public-key",
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      ...(response.userHandle === null ? {} : { userHandle: toBase64Url(response.userHandle) }),
    },
    clientExtensionResults: { ...credential.getClientExtensionResults() },
  };
}

/**
 * The code of an error body the `approve` service or the signer sent, or `internal`.
 * @param {unknown} body
 * @returns {string}
 */
function errorCode(body) {
  if (typeof body !== "object" || body === null || !("error" in body)) return "internal";
  const { error } = body;
  if (typeof error !== "object" || error === null || !("code" in error)) return "internal";
  return typeof error.code === "string" ? error.code : "internal";
}

/**
 * An element with a class and text, never markup.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A link to an http or https address, or plain text when the address is anything else.
 * @param {string} href
 * @param {string} text
 * @returns {HTMLElement}
 */
function link(href, text) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return element("span", "", text);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return element("span", "", text);
  const anchor = element("a", "", text);
  anchor.href = url.href;
  anchor.rel = "noopener noreferrer";
  return anchor;
}

/**
 * @param {HTMLElement} node
 * @param {string} text
 * @param {"" | "refusal" | "success"} tone
 */
function say(node, text, tone) {
  node.className = tone === "" ? "result" : `result ${tone}`;
  node.textContent = text;
}

/**
 * @param {HTMLElement} main
 * @param {string} text
 */
function showRefusal(main, text) {
  main.replaceChildren(
    element("h1", "", "This request cannot be shown"),
    element("p", "refusal", text),
  );
}

/**
 * @param {ConfirmationView} view
 * @returns {HTMLElement}
 */
function lines(view) {
  const list = element("dl", "lines");
  for (const line of view.lines) {
    const row = element("div", `line line-${line.kind}`);
    const label = element("dt", "", line.label);
    // Text nobody checked (an agent's note, a wallet's name) is set apart from what the signer states.
    if (line.kind === "unchecked")
      label.append(" ", element("span", "tag", "Not checked by the signer"));
    row.append(label, element("dd", `value value-${line.kind}`, line.value));
    list.append(row);
  }
  return list;
}

/**
 * @param {ConfirmationView} view
 * @returns {HTMLElement}
 */
function technicalDetails(view) {
  const details = element("details", "technical");
  details.append(
    element("summary", "", "Technical details"),
    element("p", "detail-label", "Envelope (exactly what your passkey signs)"),
    element("pre", "", JSON.stringify(view.envelope, null, 2)),
    element("p", "detail-label", "What the envelope names by its hash"),
    element("pre", "", JSON.stringify(view.subject, null, 2)),
    element("p", "detail-label", "Passkey challenge (the envelope's digest)"),
    element("code", "", view.webauthn.challenge),
  );
  return details;
}

/**
 * One request to this page's API with the link's token: the answer's body, or the refusal's
 * code (`internal` when the service could not be reached).
 * @param {string} path
 * @param {string} token
 * @param {unknown} [body] sent as JSON with POST; without it the request is a GET
 * @returns {Promise<{ ok: true, body: unknown } | { ok: false, code: string }>}
 */
async function call(path, token, body) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(path, {
      ...(body === undefined
        ? { headers: { [TOKEN_HEADER]: token } }
        : {
            method: "POST",
            headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
            body: JSON.stringify(body),
          }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    return { ok: false, code: "internal" };
  }
  const answer = await response.json().catch(() => null);
  return response.ok ? { ok: true, body: answer } : { ok: false, code: errorCode(answer) };
}

/**
 * Ask the browser for a passkey's answer to `webauthn`. Null when there is none, after saying
 * so with `nothing` (what did not happen).
 * @param {PasskeyRequest} webauthn
 * @param {HTMLElement} result
 * @param {string} nothing
 * @returns {Promise<AssertionResponse | null>}
 */
async function askPasskey(webauthn, result, nothing) {
  say(result, "Waiting for your passkey…", "");
  /** @type {Credential | null} */
  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey: requestOptions(webauthn) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    say(result, `Your passkey did not answer (${name}). ${nothing} Try again.`, "refusal");
    return null;
  }
  if (
    !(credential instanceof PublicKeyCredential) ||
    !(credential.response instanceof AuthenticatorAssertionResponse)
  ) {
    say(result, `Your browser returned no passkey. ${nothing} Try again.`, "refusal");
    return null;
  }
  const passkey = credential;
  return encodeAssertion({
    id: passkey.id,
    rawId: passkey.rawId,
    type: passkey.type,
    response: credential.response,
    getClientExtensionResults: () => passkey.getClientExtensionResults(),
  });
}

/**
 * Ask the passkey, send its assertion to the signer, and go back to the request.
 * @param {ConfirmationView} view
 * @param {string} token
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} result
 */
async function approve(view, token, button, result) {
  button.disabled = true;
  const assertion = await askPasskey(view.webauthn, result, "Nothing was approved.");
  if (assertion === null) {
    button.disabled = false;
    return;
  }
  say(result, "Sending your approval to the signer…", "");
  const answer = await call(
    `/api/approvals/${encodeURIComponent(view.approvalId)}/assertions`,
    token,
    { response: assertion },
  );
  if (!answer.ok) {
    say(result, refusalText(answer.code), "refusal");
    button.disabled = !Object.hasOwn(RETRYABLE, answer.code);
    return;
  }
  const done = /** @type {SubmitConfirmationResponse} */ (answer.body);
  button.hidden = true;
  say(
    result,
    `The signer recorded your approval: ${done.collected} of ${done.required}. Taking you back to the request…`,
    "success",
  );
  const back = new URL(done.returnUrl);
  if (back.protocol === "https:" || back.protocol === "http:") {
    setTimeout(() => location.assign(back.href), RETURN_DELAY_MS);
  }
}

/**
 * @param {HTMLElement} main
 * @param {ConfirmationView} view
 * @param {string} token
 */
function render(main, view, token) {
  const { collected, required } = view.approvals;
  const state = element(
    "p",
    `state state-${view.state}`,
    view.state === "open"
      ? `${STATE_TEXT.open} ${collected} of ${required} so far.`
      : STATE_TEXT[view.state],
  );
  /** @type {HTMLElement[]} */
  const parts = [element("h1", "title", view.title), state];
  if (view.warnings.length > 0) {
    const warnings = element("ul", "warnings");
    warnings.setAttribute("aria-label", "Warnings");
    for (const warning of view.warnings) warnings.append(element("li", "", WARNING_TEXT[warning]));
    parts.push(warnings);
  }
  parts.push(lines(view));
  const possession = possessionOf(view);
  /** What the possession step enables once done on this page. */
  let unlock = () => {};
  /** @type {HTMLElement | null} */
  let decide = null;
  if (view.state === "open") {
    decide = element("section", "decide");
    decide.setAttribute("aria-label", "Decision");
    const button = element("button", "approve", "Approve with passkey");
    button.type = "button";
    const result = element("p", "result");
    result.setAttribute("role", "status");
    button.addEventListener("click", () => void approve(view, token, button, result));
    decide.append(
      element(
        "p",
        "note",
        "Your passkey signs this request's digest. The signer accepts the approval only from this page.",
      ),
    );
    if (possession !== "none") {
      decide.append(
        element(
          "p",
          "note",
          "Before you approve, ask the person being added to read you the fingerprint their page showed them, over a call or in person. Approve only if it matches the key fingerprint above.",
        ),
      );
    }
    if (possession === "unproven") {
      const waiting = element(
        "p",
        "note",
        "Approving opens once the person being added has proven on this page that the passkey is theirs. Reload this page after they have.",
      );
      button.disabled = true;
      decide.append(waiting);
      unlock = () => {
        button.disabled = false;
        waiting.remove();
      };
    }
    decide.append(button, result);
  }
  // Approvals collected before the step existed can leave a request `complete` but unproven;
  // the signer applies it only once the person being added has done the step.
  if (possession === "unproven" && (view.state === "open" || view.state === "complete")) {
    parts.push(possessionStep(view, token, unlock));
  }
  if (decide !== null) parts.push(decide);
  const back = element("p", "back");
  back.append(link(view.returnUrl, "Back to the request"));
  parts.push(back, technicalDetails(view));
  main.replaceChildren(...parts);
  document.title = `${view.title} · Approve`;
}

/**
 * The possession step, for the person being added: the signer's challenge, which only the new
 * passkey may answer, is fetched when the step is shown, so nothing waits between the tap and
 * the passkey prompt, as with approving. After the answer, the page shows the key's fingerprint
 * to read out.
 * @param {ConfirmationView} view
 * @param {string} token
 * @param {() => void} proven called once the signer recorded the proof
 * @returns {HTMLElement}
 */
function possessionStep(view, token, proven) {
  const section = element("section", "possession");
  section.setAttribute("aria-label", "The new passkey");
  const button = element("button", "prove", "This passkey is mine");
  button.type = "button";
  button.disabled = true;
  const result = element("p", "result");
  result.setAttribute("role", "status");
  const path = `/api/approvals/${encodeURIComponent(view.approvalId)}/possession`;
  /** @type {PasskeyRequest | null} */
  let challenge = null;

  /** The signer keeps one challenge until an answer uses it, so fetching again is safe. */
  const load = async () => {
    const answer = await call(path, token);
    if (!answer.ok) {
      say(result, refusalText(answer.code), "refusal");
      return;
    }
    challenge = /** @type {PasskeyRequest} */ (answer.body);
    button.disabled = false;
  };

  const prove = async (/** @type {PasskeyRequest} */ asked) => {
    button.disabled = true;
    const assertion = await askPasskey(asked, result, "Nothing was proven.");
    if (assertion === null) {
      button.disabled = false;
      return;
    }
    say(result, "Sending your answer to the signer…", "");
    const answer = await call(path, token, { response: assertion });
    if (!answer.ok) {
      say(result, refusalText(answer.code), "refusal");
      if (Object.hasOwn(RETRYABLE, answer.code)) await load();
      return;
    }
    const { fingerprint } = /** @type {SubmitPossessionResponse} */ (answer.body);
    button.hidden = true;
    result.replaceChildren(
      element("span", "", "The signer checked that this passkey is yours. Its fingerprint is "),
      element("strong", "fingerprint", fingerprint),
      element(
        "span",
        "",
        ". Read it to the people who approve over a call or in person, not through this site or a message it sent. They approve only if it matches the fingerprint their page shows.",
      ),
    );
    result.className = "result success";
    proven();
  };

  button.addEventListener("click", () => {
    if (challenge !== null) void prove(challenge);
  });
  void load();
  section.append(
    element("h2", "", "Are you the person being added?"),
    element(
      "p",
      "",
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
  const approvalId = /^\/a\/([^/]+)$/.exec(location.pathname)?.[1];
  const token = location.hash.slice(1);
  if (approvalId === undefined || token === "") {
    showRefusal(main, REFUSAL_TEXT.not_found);
    return;
  }
  const answer = await call(`/api/approvals/${approvalId}`, token);
  if (!answer.ok) {
    showRefusal(main, refusalText(answer.code));
    return;
  }
  render(main, /** @type {ConfirmationView} */ (answer.body), token);
}

if (typeof document !== "undefined") void start();
