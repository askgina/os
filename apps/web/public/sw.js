// @ts-check
/**
 * The service worker, at `/sw.js` with scope `/`. It does two things only: show a push message
 * as a notification, and open the page that notification names when it is pressed.
 *
 * It has no `fetch` handler and uses no Cache Storage, so it never sees, changes or serves a
 * request of the app: a worker left on a device cannot alter what the app shows. Browsers check
 * `/sw.js` again at least once a day, so a fixed server replaces a bad one. It never calls the
 * API either: a notification offers no buttons and no action happens from one; approving still
 * needs the passkey, on the signer's page, which the approval page links to.
 *
 * A message is the Declarative Web Push JSON the server sends (`web_push: 8030`, see
 * `apps/server/src/notify/content.ts`). Safari 18.4 and later shows such a message by itself,
 * without this worker; every other browser hands it to the `push` event here. This worker shows
 * a notification for every message, because Safari revokes a subscription whose messages show
 * nothing. It takes the title, body and tag only as plain short text, and opens only a page of
 * this site: the approval page (`/w/<workspace>/approvals/<approval>`) or the workspace list.
 * Anything else, or a message it cannot read, becomes the generic "Approval waiting" that opens
 * the workspace list. Links carry no token and opening one creates no session: a signed-out
 * device lands on sign-in, which returns to the page afterwards.
 *
 * Hand-written, a classic script with no imports, served as it is (Vite copies `public/` into
 * the build): the file browsers run is the file `test/sw.test.ts` runs in a stand-in worker
 * scope, where the top-level functions below are its pure helpers.
 */

/**
 * @typedef {object} Shown A notification, as this worker shows it.
 * @property {string} title
 * @property {string} body
 * @property {string} tag Replaces an earlier notification with the same tag (a reminder does).
 * @property {string} path The page to open, on this site.
 * @property {number | null} badge The number for the app's icon, when the message has one.
 */

/**
 * @typedef {object} ShowOptions
 * @property {string} body
 * @property {string} tag
 * @property {string} lang
 * @property {boolean} renotify
 * @property {string} icon
 * @property {{ path: string }} data
 */

/**
 * @typedef {object} WindowClientLike
 * @property {() => Promise<unknown>} focus
 * @property {(url: string) => Promise<unknown>} navigate
 */

/**
 * @typedef {object} PushEventLike
 * @property {{ json(): unknown } | null} data
 * @property {(promise: Promise<unknown>) => void} waitUntil
 */

/**
 * @typedef {object} NotificationClickLike
 * @property {{ data: unknown, close(): void }} notification
 * @property {(promise: Promise<unknown>) => void} waitUntil
 */

/**
 * The parts of `ServiceWorkerGlobalScope` this worker uses. The web app's types are the DOM's,
 * which name `self` a window, so the worker states its own.
 * @typedef {object} WorkerScope
 * @property {{ origin: string }} location
 * @property {{
 *   showNotification(title: string, options: ShowOptions): Promise<void>,
 *   getNotifications(): Promise<unknown[]>,
 * }} registration
 * @property {{
 *   matchAll(options: { type: "window" }): Promise<readonly WindowClientLike[]>,
 *   openWindow(url: string): Promise<unknown>,
 * }} clients
 * @property {{ setAppBadge?(count: number): Promise<void>, clearAppBadge?(): Promise<void> }} navigator
 * @property {{
 *   (type: "push", listener: (event: PushEventLike) => void): void,
 *   (type: "notificationclick", listener: (event: NotificationClickLike) => void): void,
 * }} addEventListener
 */

/** The longest title or body shown, in characters, as the server cuts them. */
const TEXT_MAX_CHARACTERS = 60;

/** The approval page, as the server builds its links (`approvalLink`). */
const APPROVAL_PAGE = /^\/w\/[A-Za-z0-9_]+\/approvals\/[A-Za-z0-9_]+$/;

const GENERIC_TITLE = "Approval waiting";

const GENERIC_BODY = "Open the app to see what waits for you.";

const GENERIC_TAG = "approval";

/**
 * The page `link` names, if it is the approval page or the workspace list on `origin`; null
 * otherwise. Search and fragment are dropped: the page needs neither, and a link carries no token.
 * @param {unknown} link
 * @param {string} origin
 * @returns {string | null}
 */
function pagePath(link, origin) {
  if (typeof link !== "string" || link.length > 2048) return null;
  let url;

  try {
    url = new URL(link, origin);
  } catch {
    return null;
  }

  if (url.origin !== origin) return null;

  return url.pathname === "/" || APPROVAL_PAGE.test(url.pathname) ? url.pathname : null;
}

/**
 * One line of plain text of at most {@link TEXT_MAX_CHARACTERS}: control, format and separator
 * characters become spaces. Null for anything that is not a non-empty string.
 * @param {unknown} value
 * @returns {string | null}
 */
function plainLine(value) {
  if (typeof value !== "string") return null;

  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (flat === "") return null;
  const characters = Array.from(flat);

  if (characters.length <= TEXT_MAX_CHARACTERS) return flat;

  return `${characters.slice(0, TEXT_MAX_CHARACTERS - 1).join("")}…`;
}

/**
 * What to show for a push message, given its data read as JSON (null when it was not JSON).
 * A Declarative Web Push message with a title and a link to a page of this site shows as sent;
 * anything else shows as the generic notification, which opens the workspace list.
 * @param {unknown} message
 * @param {string} origin
 * @returns {Shown}
 */
function notificationFor(message, origin) {
  /** @type {Shown} */
  const generic = {
    title: GENERIC_TITLE,
    body: GENERIC_BODY,
    tag: GENERIC_TAG,
    path: "/",
    badge: null,
  };

  if (typeof message !== "object" || message === null) return generic;
  const { web_push: version, notification } = /** @type {Record<string, unknown>} */ (message);

  if (version !== 8030 || typeof notification !== "object" || notification === null) return generic;
  const fields = /** @type {Record<string, unknown>} */ (notification);
  const title = plainLine(fields.title);
  const path = pagePath(fields.navigate, origin);

  if (title === null || path === null) return generic;

  const tag =
    typeof fields.tag === "string" && /^approval-[A-Za-z0-9_]+$/.test(fields.tag)
      ? fields.tag
      : GENERIC_TAG;

  const badge =
    typeof fields.app_badge === "string" && /^[0-9]{1,3}$/.test(fields.app_badge)
      ? Number(fields.app_badge)
      : null;

  return { title, body: plainLine(fields.body) ?? "", tag, path, badge };
}

/**
 * The message's data as JSON, or null when there is none or it is not JSON.
 * @param {PushEventLike["data"]} data
 * @returns {unknown}
 */
function readMessage(data) {
  if (data === null) return null;

  try {
    return data.json();
  } catch {
    return null;
  }
}

/**
 * The page a pressed notification opens: the path it was shown with, checked again, or the
 * workspace list.
 * @param {unknown} data
 * @param {string} origin
 * @returns {string}
 */
function clickPath(data, origin) {
  const path =
    typeof data === "object" && data !== null
      ? /** @type {Record<string, unknown>} */ (data).path
      : null;

  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//")
    ? (pagePath(path, origin) ?? "/")
    : "/";
}

const worker = /** @type {WorkerScope} */ (/** @type {unknown} */ (self));

/**
 * @param {Shown} shown
 * @returns {Promise<void>}
 */
async function show(shown) {
  await worker.registration.showNotification(shown.title, {
    body: shown.body,
    tag: shown.tag,
    lang: "en",
    // A reminder has the first notification's tag: it replaces it and alerts again.
    renotify: true,
    icon: "/icons/icon-192.png",
    data: { path: shown.path },
  });

  if (shown.badge !== null && worker.navigator.setAppBadge) {
    // The badge is a hint; a browser that refuses it still shows the notification.
    await worker.navigator.setAppBadge(shown.badge).catch(() => undefined);
  }
}

/**
 * Brings a window of this app to `path`: one this worker controls, navigated there, or a new one.
 * @param {string} path
 * @returns {Promise<void>}
 */
async function openPage(path) {
  const url = new URL(path, worker.location.origin).href;
  let opened = false;

  // Without `includeUncontrolled`, only windows this worker controls, which are the only ones
  // it may navigate.
  for (const client of await worker.clients.matchAll({ type: "window" })) {
    try {
      await client.focus();
      await client.navigate(url);
      opened = true;
      break;
    } catch {
      // That window could not be used; try the next one, then a new window.
    }
  }

  if (!opened) await worker.clients.openWindow(url);

  if (
    worker.navigator.clearAppBadge &&
    (await worker.registration.getNotifications()).length === 0
  ) {
    await worker.navigator.clearAppBadge().catch(() => undefined);
  }
}

worker.addEventListener("push", (event) => {
  event.waitUntil(show(notificationFor(readMessage(event.data), worker.location.origin)));
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openPage(clickPath(event.notification.data, worker.location.origin)));
});
