/**
 * Stands in for the browser's push subscription in the journey, where Chromium has no push
 * service to subscribe with (a headless browser reaches none, so `pushManager.subscribe` fails
 * there). Installed with `context.addInitScript`, it replaces only
 * `PushManager.prototype.subscribe` and `getSubscription`:
 *
 * - `subscribe` refuses, as the real one does, unless notifications are allowed (the journey
 *   grants that permission through Playwright), and refuses a different server key while a
 *   subscription exists. Otherwise it makes a real P-256 key pair and a random 16-byte secret,
 *   and an endpoint under `fcm.googleapis.com` that no push service ever issued.
 * - The subscription lives in the page's `localStorage`, so it survives reloads like a real one,
 *   and `unsubscribe` removes it.
 *
 * Everything else is the browser's own: the permission, the service worker's registration at
 * `/sw.js` under the production Content-Security-Policy, and the worker itself. Nothing is ever
 * sent to a push service; the journey hands messages to the worker through the DevTools
 * protocol instead (`ServiceWorker.deliverPushMessage`), unencrypted.
 *
 * Playwright sends this function's source to the browser, so it uses nothing from outside it.
 */
export function standInPushManager(): void {
  if (!("PushManager" in window)) return;
  const storageKey = "fixture.push-subscription";

  interface Stored {
    endpoint: string;
    p256dh: string;
    auth: string;
    serverKey: string;
  }

  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const decode = (text: string) =>
    Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

  const read = (): Stored | null => {
    const raw = localStorage.getItem(storageKey);

    // SAFETY: only `subscribe` below writes `storageKey`, and it stores `JSON.stringify` of a
    // `Stored`; the page never writes that key.
    return raw === null ? null : (JSON.parse(raw) as Stored);
  };

  const asSubscription = (stored: Stored): PushSubscription => {
    const subscription: PushSubscription = {
      endpoint: stored.endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: decode(stored.serverKey).buffer },
      getKey: (name: PushEncryptionKeyName) =>
        decode(name === "p256dh" ? stored.p256dh : stored.auth).buffer,
      toJSON: () => ({
        endpoint: stored.endpoint,
        expirationTime: null,
        keys: { p256dh: stored.p256dh, auth: stored.auth },
      }),
      unsubscribe: async () => {
        localStorage.removeItem(storageKey);

        return true;
      },
    };

    return subscription;
  };

  PushManager.prototype.getSubscription = async function getSubscription() {
    const stored = read();

    return stored === null ? null : asSubscription(stored);
  };

  PushManager.prototype.subscribe = async function subscribe(options) {
    if (Notification.permission !== "granted") {
      throw new DOMException("Registration failed - permission denied", "NotAllowedError");
    }

    const key = options?.applicationServerKey;

    if (!(key instanceof ArrayBuffer || ArrayBuffer.isView(key))) {
      throw new TypeError("the stand-in takes a key's bytes");
    }

    const serverKey = encode(
      ArrayBuffer.isView(key)
        ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength)
        : new Uint8Array(key),
    );

    const existing = read();

    if (existing !== null) {
      if (existing.serverKey === serverKey) return asSubscription(existing);
      throw new DOMException("A subscription with a different key exists.", "InvalidStateError");
    }

    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);

    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    const stored: Stored = {
      endpoint: `https://fcm.googleapis.com/fcm/send/stand-in-${crypto.randomUUID()}`,
      p256dh: encode(publicKey),
      auth: encode(crypto.getRandomValues(new Uint8Array(16))),
      serverKey,
    };

    localStorage.setItem(storageKey, JSON.stringify(stored));

    return asSubscription(stored);
  };
}
