import type { PushSubscriptionInput } from "@askgina/os-api";

/**
 * Notifications on this device: whether the browser can get them, its push subscription, and
 * which of the person's devices on the server is this one. Nothing here talks to the server;
 * the settings page sends what these return.
 *
 * The browser's push subscription belongs to the site, not to a person, and the server's list
 * of devices names no endpoint. So the page remembers, in this browser, which device on the
 * server this subscription became and for whom (`DeviceRecord`), and compares that with the
 * browser and the server each time it opens. The worker does not resubscribe by itself when the
 * browser replaces a subscription (it handles no `pushsubscriptionchange`); the page notices and
 * asks to turn notifications on again.
 */

/**
 * - `available`: this browser can get notifications; asking for permission comes next.
 * - `needs-install`: an iPhone or iPad, outside the Home Screen. Safari there has no push for a
 *   web page; the same site added to the Home Screen and opened from there has (iOS 16.4 on).
 * - `blocked`: the person blocked notifications for this site in the browser.
 * - `unsupported`: no service workers or no push here (an old browser, or a page not on HTTPS).
 */
export type PushSupport = "unsupported" | "needs-install" | "blocked" | "available";

/** What `pushSupport` decides from: the browser's features, its permission and what it is. */
export interface PushEnvironment {
  /** HTTPS, or `localhost`. Service workers exist only there. */
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  /** `Notification.permission`; null where there is no `Notification`. */
  permission: NotificationPermission | null;
  userAgent: string;
  maxTouchPoints: number;
  /** Opened as an installed app (from the Home Screen on iOS) rather than in a browser tab. */
  standalone: boolean;
}

/** The first iOS and iPadOS release that gives a Home Screen web app push: 16.4. */
const FIRST_APPLE_PUSH: readonly [number, number] = [16, 4];

/** An iPhone, iPod or iPad. iPadOS asks for desktop sites, so it names itself a Mac with touch. */
function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  return (
    /\b(iPhone|iPad|iPod)\b/.test(userAgent) ||
    (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1)
  );
}

export function readPushEnvironment(): PushEnvironment {
  const hasNotification = "Notification" in window;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;

  return {
    secureContext: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: hasNotification,
    permission: hasNotification ? Notification.permission : null,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: window.matchMedia("(display-mode: standalone)").matches || iosStandalone,
  };
}

/** Whether this browser can get notifications, and if not, whether installing would help. */
export function pushSupport(environment: PushEnvironment = readPushEnvironment()): PushSupport {
  if (isAppleMobile(environment.userAgent, environment.maxTouchPoints) && !environment.standalone) {
    // "CPU iPhone OS 16_3 like Mac OS X". iPadOS in desktop mode names no version.
    const version = /\bOS (\d+)_(\d+)/.exec(environment.userAgent);
    const [major, minor] = FIRST_APPLE_PUSH;

    if (version) {
      const [found, foundMinor] = [Number(version[1]), Number(version[2])];

      if (found < major || (found === major && foundMinor < minor)) return "unsupported";
    }

    return "needs-install";
  }

  const { secureContext, serviceWorker, pushManager, notification } = environment;

  if (!secureContext || !serviceWorker || !pushManager || !notification) return "unsupported";

  return environment.permission === "denied" ? "blocked" : "available";
}

/** A name for this device to start the label field with, such as "Chrome on Android phone". */
export function suggestDeviceLabel(userAgent: string, maxTouchPoints: number): string {
  let device: string | null = null;

  if (/\biPhone\b/.test(userAgent)) device = "iPhone";
  else if (/\biPad\b/.test(userAgent) || isAppleMobile(userAgent, maxTouchPoints)) device = "iPad";
  else if (/\bAndroid\b/.test(userAgent)) {
    device = /\bMobile\b/.test(userAgent) ? "Android phone" : "Android tablet";
  } else if (/\bMacintosh\b/.test(userAgent)) device = "Mac";
  else if (/\bWindows\b/.test(userAgent)) device = "Windows computer";
  else if (/\bCrOS\b/.test(userAgent)) device = "Chromebook";
  else if (/\bLinux\b/.test(userAgent)) device = "Linux computer";
  let browser: string | null = null;

  if (/\bEdg(e|A|iOS)?\//.test(userAgent)) browser = "Edge";
  else if (/\b(Firefox|FxiOS)\//.test(userAgent)) browser = "Firefox";
  else if (/\b(Chrome|CriOS)\//.test(userAgent)) browser = "Chrome";
  else if (/\bSafari\//.test(userAgent)) browser = "Safari";

  if (device && browser) return `${browser} on ${device}`;

  return device ?? browser ?? "This browser";
}

/** Unpadded base64url, as the server and `PushSubscription.toJSON()` write keys. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Which of the person's devices on the server this browser's subscription became. */
export interface DeviceRecord {
  userId: string;
  subscriptionId: string;
  endpoint: string;
}

const RECORD_KEY = "os.push.device";

export function readDeviceRecord(): DeviceRecord | null {
  let value: unknown;

  try {
    value = JSON.parse(localStorage.getItem(RECORD_KEY) ?? "null");
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const { userId, subscriptionId, endpoint } = value as Record<string, unknown>;

  if (typeof userId !== "string" || typeof subscriptionId !== "string") return null;

  return typeof endpoint === "string" ? { userId, subscriptionId, endpoint } : null;
}

export function writeDeviceRecord(record: DeviceRecord | null): void {
  if (record === null) localStorage.removeItem(RECORD_KEY);
  else localStorage.setItem(RECORD_KEY, JSON.stringify(record));
}

/** This browser's push subscription as the page compares it: its endpoint and server key. */
export interface BrowserSubscription {
  endpoint: string;
  /** The key it was made with, base64url; null where the browser does not say. */
  applicationServerKey: string | null;
}

function describeSubscription(subscription: PushSubscription): BrowserSubscription {
  const key = subscription.options?.applicationServerKey;

  return {
    endpoint: subscription.endpoint,
    applicationServerKey: key ? bytesToBase64Url(new Uint8Array(key)) : null,
  };
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");

  return registration && "pushManager" in registration ? registration : null;
}

/** This browser's push subscription for this site, if it has one. */
export async function browserSubscription(): Promise<BrowserSubscription | null> {
  const registration = await currentRegistration();
  const subscription = await registration?.pushManager.getSubscription();

  return subscription ? describeSubscription(subscription) : null;
}

/**
 * Notifications on this device, as the page shows them:
 * - `off`: this browser holds no subscription for this person.
 * - `on`: its subscription is the device `subscriptionId` on the server, made with the server's
 *   current key.
 * - `stopped`: it was on for this person but no longer reaches them (`StoppedReason`); turning it
 *   on again fixes it.
 */
export type DeviceState =
  | { kind: "off" }
  | { kind: "on"; subscriptionId: string }
  | { kind: "stopped"; reason: StoppedReason; subscriptionId: string };

/**
 * - `ended`: the browser no longer has the subscription (notifications were blocked, the site's
 *   data was cleared, or the browser let it expire).
 * - `replaced`: the browser holds a different subscription than the one the server knows.
 * - `key-changed`: the server's key changed (its operator rotated it), and a subscription works
 *   only with the key it was made with.
 * - `removed`: the device is no longer on the server's list: removed here or on another device,
 *   or its push service said it was gone.
 */
export type StoppedReason = "ended" | "replaced" | "key-changed" | "removed";

/** What `deviceState` compares: the signed-in person, this browser, and the server's view. */
export interface DeviceStateInput {
  userId: string;
  record: DeviceRecord | null;
  browser: BrowserSubscription | null;
  /** The server's key now (`PushConfig.applicationServerKey`). */
  serverKey: string | null;
  /** The person's devices on the server (`listPushSubscriptions`). */
  devices: readonly { id: string }[];
}

export function deviceState(input: DeviceStateInput): DeviceState {
  const { record, browser } = input;

  if (record === null || record.userId !== input.userId) return { kind: "off" };

  const stopped = (reason: StoppedReason): DeviceState => ({
    kind: "stopped",
    reason,
    subscriptionId: record.subscriptionId,
  });

  if (browser === null) return stopped("ended");

  if (browser.endpoint !== record.endpoint) return stopped("replaced");

  if (browser.applicationServerKey !== null && browser.applicationServerKey !== input.serverKey) {
    return stopped("key-changed");
  }

  if (!input.devices.some((device) => device.id === record.subscriptionId)) {
    return stopped("removed");
  }

  return { kind: "on", subscriptionId: record.subscriptionId };
}

/** Why this browser could not be set up for notifications, before the server was asked. */
export type PushSetupFailure =
  | "permission_denied"
  | "permission_dismissed"
  | "worker_failed"
  | "subscribe_failed";

export class PushSetupError extends Error {
  override readonly name = "PushSetupError";
  readonly failure: PushSetupFailure;

  constructor(failure: PushSetupFailure) {
    super(failure);
    this.failure = failure;
  }
}

/**
 * Installs the worker and subscribes this browser with the server's key, keeping a subscription
 * it already has with that key. `permission` is `Notification.requestPermission()`, called by
 * the press of a button before anything else: browsers, iOS above all, ask only then. Returns
 * what the server takes (`addPushSubscription`).
 */
export async function subscribeThisBrowser(input: {
  permission: Promise<NotificationPermission>;
  applicationServerKey: string;
  label: string | undefined;
}): Promise<PushSubscriptionInput> {
  const permission = await input.permission;

  if (permission !== "granted") {
    throw new PushSetupError(
      permission === "denied" ? "permission_denied" : "permission_dismissed",
    );
  }

  let registration: ServiceWorkerRegistration;

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    registration = await navigator.serviceWorker.ready;
  } catch {
    throw new PushSetupError("worker_failed");
  }

  let subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    const made = describeSubscription(subscription).applicationServerKey;

    if (made !== null && made !== input.applicationServerKey) {
      // Made with a key the server no longer has: nothing it sends could arrive.
      await subscription.unsubscribe();
      subscription = null;
    }
  }

  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(input.applicationServerKey),
      });
    } catch (error) {
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      throw new PushSetupError(denied ? "permission_denied" : "subscribe_failed");
    }
  }

  const keys = subscription.toJSON().keys ?? {};

  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" },
    ...(input.label ? { label: input.label } : {}),
  };
}

/**
 * Ends this browser's subscription and removes the worker, which has nothing left to do, and
 * forgets which device it was.
 */
export async function unsubscribeThisBrowser(): Promise<void> {
  const registration = await currentRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
  await registration?.unregister();
  writeDeviceRecord(null);
}
