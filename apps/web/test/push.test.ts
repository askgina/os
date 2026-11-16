import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  type DeviceRecord,
  type DeviceStateInput,
  deviceState,
  type PushEnvironment,
  type PushSupport,
  pushSupport,
  suggestDeviceLabel,
} from "../src/lib/push.ts";

const IPHONE_17 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const IPHONE_16_3 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1";

const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";

/** iPadOS asks for desktop sites: it says Macintosh and names no iOS version. */
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

const MAC_SAFARI = IPAD_DESKTOP;

const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0";

/** A desktop browser with everything push needs, permission not asked yet. */
const capable: PushEnvironment = {
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: "default",
  userAgent: LINUX_FIREFOX,
  maxTouchPoints: 0,
  standalone: false,
};

/** Safari on an iPhone or iPad outside the Home Screen: no push manager, no `Notification`. */
const appleTab = (userAgent: string, maxTouchPoints = 5): PushEnvironment => ({
  ...capable,
  pushManager: false,
  notification: false,
  permission: null,
  userAgent,
  maxTouchPoints,
});

describe("pushSupport", () => {
  it.each<[string, PushEnvironment, PushSupport]>([
    ["a desktop browser with push", capable, "available"],
    [
      "the same after the person allowed notifications",
      { ...capable, permission: "granted" },
      "available",
    ],
    ["the same after the person blocked them", { ...capable, permission: "denied" }, "blocked"],
    [
      "Chrome on Android",
      { ...capable, userAgent: ANDROID_CHROME, maxTouchPoints: 5 },
      "available",
    ],
    ["Safari on a Mac (touch points 0)", { ...capable, userAgent: MAC_SAFARI }, "available"],
    [
      "a page not on HTTPS",
      { ...capable, secureContext: false, serviceWorker: false },
      "unsupported",
    ],
    ["a browser without service workers", { ...capable, serviceWorker: false }, "unsupported"],
    ["a browser without push", { ...capable, pushManager: false }, "unsupported"],
    ["a browser without notifications", { ...capable, notification: false }, "unsupported"],
    ["Safari on an iPhone, in a tab", appleTab(IPHONE_17), "needs-install"],
    ["Chrome on an iPhone, in a tab", appleTab(IPHONE_CHROME), "needs-install"],
    ["an iPad asking for desktop sites, in a tab", appleTab(IPAD_DESKTOP), "needs-install"],
    [
      "an iPhone before iOS 16.4, where installing does not help",
      appleTab(IPHONE_16_3),
      "unsupported",
    ],
    [
      "the Home Screen app on iOS 17",
      { ...capable, userAgent: IPHONE_17, maxTouchPoints: 5, standalone: true },
      "available",
    ],
    [
      "the Home Screen app, notifications blocked",
      {
        ...capable,
        userAgent: IPHONE_17,
        maxTouchPoints: 5,
        standalone: true,
        permission: "denied",
      },
      "blocked",
    ],
    [
      "the Home Screen app on an iOS without web push",
      { ...appleTab(IPHONE_16_3), standalone: true },
      "unsupported",
    ],
  ])("%s", (_name, environment, expected) => {
    expect(pushSupport(environment)).toBe(expected);
  });
});

describe("suggestDeviceLabel", () => {
  it.each([
    [IPHONE_17, 5, "Safari on iPhone"],
    [IPHONE_CHROME, 5, "Chrome on iPhone"],
    [IPAD_DESKTOP, 5, "Safari on iPad"],
    [MAC_SAFARI, 0, "Safari on Mac"],
    [ANDROID_CHROME, 5, "Chrome on Android phone"],
    [WINDOWS_EDGE, 0, "Edge on Windows computer"],
    [LINUX_FIREFOX, 0, "Firefox on Linux computer"],
    ["curl/8.0", 0, "This browser"],
  ])("names %s (%i touch points) %j", (userAgent, touch, label) => {
    expect(suggestDeviceLabel(userAgent, touch)).toBe(label);
    expect(label.length).toBeLessThanOrEqual(40);
  });
});

describe("base64url", () => {
  it("round-trips a 65-byte key without padding", () => {
    const key = new Uint8Array(65).map((_, index) => (index * 37 + 4) % 256);
    const text = bytesToBase64Url(key);
    expect(text).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect([...base64UrlToBytes(text)]).toEqual([...key]);
  });

  it("reads `-` and `_` as base64url, padded or not", () => {
    expect([...base64UrlToBytes("-_8")]).toEqual([0xfb, 0xff]);
    expect([...base64UrlToBytes("-_8=")]).toEqual([0xfb, 0xff]);
  });
});

describe("deviceState", () => {
  const userId = "usr_ada";
  const record: DeviceRecord = { userId, subscriptionId: "psb_1", endpoint: "https://push/1" };
  const browser = { endpoint: "https://push/1", applicationServerKey: "KEY" };
  const devices = [{ id: "psb_1" }, { id: "psb_2" }];

  const state = (changes: Partial<DeviceStateInput> = {}) =>
    deviceState({ userId, record, browser, serverKey: "KEY", devices, ...changes });

  it("is on when browser, record and server agree", () => {
    expect(state()).toEqual({ kind: "on", subscriptionId: "psb_1" });
  });

  it("is on when the browser does not say which key it used", () => {
    expect(state({ browser: { ...browser, applicationServerKey: null } }).kind).toBe("on");
  });

  it("is off with no record, or a record of someone else who used this browser", () => {
    expect(state({ record: null })).toEqual({ kind: "off" });
    expect(state({ record: { ...record, userId: "usr_grace" } })).toEqual({ kind: "off" });
  });

  it.each<[string, Partial<DeviceStateInput>, string]>([
    ["the browser lost its subscription", { browser: null }, "ended"],
    [
      "the browser holds another subscription",
      { browser: { ...browser, endpoint: "https://push/9" } },
      "replaced",
    ],
    ["the server's key changed", { serverKey: "NEW" }, "key-changed"],
    ["the device left the server's list", { devices: [{ id: "psb_2" }] }, "removed"],
  ])("has stopped when %s", (_name, changes, reason) => {
    expect(state(changes)).toEqual({ kind: "stopped", reason, subscriptionId: "psb_1" });
  });
});
