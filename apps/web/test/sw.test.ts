import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

/**
 * Runs the real `public/sw.js`, unchanged, in a stand-in for a service worker's global scope:
 * the listeners it adds are kept, and its top-level functions are its pure helpers.
 */

const ORIGIN = "https://os.example";

const APPROVAL = "/w/ws_01HZY/approvals/apr_01HZY";

interface Shown {
  title: string;
  body: string;
  tag: string;
  path: string;
  badge: number | null;
}

interface WorkerHelpers {
  notificationFor(message: unknown, origin: string): Shown;
  pagePath(link: unknown, origin: string): string | null;
  clickPath(data: unknown, origin: string): string;
}

type Listener = (event: unknown) => void;

/** What the worker finds as `self`: the parts of a service worker's scope it uses. */
interface WorkerStandIn {
  location: { origin: string };
  registration: {
    showNotification: Mock<(title: string, options: unknown) => Promise<void>>;
    getNotifications: Mock<() => Promise<unknown[]>>;
  };
  clients: {
    matchAll: Mock<(options: unknown) => Promise<unknown[]>>;
    openWindow: Mock<(url: string) => Promise<null>>;
  };
  navigator: {
    setAppBadge: Mock<(count: number) => Promise<void>>;
    clearAppBadge: Mock<() => Promise<void>>;
  };
  addEventListener(type: string, listener: Listener): void;
}

interface LoadedWorker {
  scope: WorkerStandIn;
  listeners: Map<string, Listener>;
  helpers: WorkerHelpers;
  /** Fires an event at the worker and waits for everything it handed to `waitUntil`. */
  fire(type: string, event: Record<string, unknown>): Promise<void>;
  /** Presses a notification shown with `data`; returns its `close`. */
  click(data: unknown): Promise<Mock<() => void>>;
}

function loadWorker(): LoadedWorker {
  const listeners = new Map<string, Listener>();
  const notifications: unknown[] = [];

  const scope: WorkerStandIn = {
    location: { origin: ORIGIN },
    registration: {
      showNotification: vi.fn<(title: string, options: unknown) => Promise<void>>(
        async (title, options) => {
          notifications.push({ title, options });
        },
      ),
      getNotifications: vi.fn<() => Promise<unknown[]>>(async () => notifications),
    },
    clients: {
      matchAll: vi.fn<(options: unknown) => Promise<unknown[]>>(async () => []),
      openWindow: vi.fn<(url: string) => Promise<null>>(async () => null),
    },
    navigator: {
      setAppBadge: vi.fn<(count: number) => Promise<void>>(async () => undefined),
      clearAppBadge: vi.fn<() => Promise<void>>(async () => undefined),
    },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };

  const context = createContext({ self: scope, URL });
  runInContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);
  const helpers = context as unknown as WorkerHelpers;

  async function fire(type: string, event: Record<string, unknown>): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const listener = listeners.get(type);

    if (!listener) throw new Error(`the worker has no ${type} listener`);
    listener({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }

  async function click(data: unknown): Promise<Mock<() => void>> {
    const close = vi.fn<() => void>();
    await fire("notificationclick", { notification: { data, close } });

    return close;
  }

  return { scope, listeners, helpers, fire, click };
}

/** The message the server sends at the `count` level (`pushMessage` in the server). */
function declarative(fields: Record<string, unknown> = {}) {
  return {
    web_push: 8030,
    notification: {
      title: "Approval waiting",
      body: "1 request needs your passkey",
      navigate: `${ORIGIN}${APPROVAL}`,
      tag: "approval-apr_01HZY",
      lang: "en",
      silent: false,
      app_badge: "1",
      ...fields,
    },
  };
}

const GENERIC = {
  title: "Approval waiting",
  body: "Open the app to see what waits for you.",
  tag: "approval",
  path: "/",
  badge: null,
};

let worker: LoadedWorker;

beforeEach(() => {
  worker = loadWorker();
});

describe("the worker's handlers", () => {
  it("listens for push and notification presses only: no fetch handler, nothing cached", () => {
    expect([...worker.listeners.keys()].sort()).toEqual(["notificationclick", "push"]);
    const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bcaches\b|addEventListener\(\s*["']fetch/);
    expect(source).not.toMatch(/^\s*(import|export)\b/m);
  });

  it("shows a declarative message once, with its title, body, tag and path, and sets the badge", async () => {
    const message = declarative({ app_badge: "3" });
    await worker.fire("push", { data: { json: () => message } });
    expect(worker.scope.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.scope.registration.showNotification).toHaveBeenCalledWith("Approval waiting", {
      body: "1 request needs your passkey",
      tag: "approval-apr_01HZY",
      lang: "en",
      renotify: true,
      icon: "/icons/icon-192.png",
      data: { path: APPROVAL },
    });
    expect(worker.scope.navigator.setAppBadge).toHaveBeenCalledWith(3);
  });

  it("shows the generic notification for a link to another site, opening the workspace list", async () => {
    const message = declarative({ navigate: `https://evil.example${APPROVAL}` });
    await worker.fire("push", { data: { json: () => message } });
    expect(worker.scope.registration.showNotification).toHaveBeenCalledWith(
      GENERIC.title,
      expect.objectContaining({ body: GENERIC.body, tag: "approval", data: { path: "/" } }),
    );
    expect(worker.scope.navigator.setAppBadge).not.toHaveBeenCalled();
  });

  it.each([
    ["no data at all", null],
    ["data that is not JSON", { json: () => JSON.parse("Approval waiting") }],
  ])("still shows a notification for %s", async (_name, data) => {
    await worker.fire("push", { data });
    expect(worker.scope.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(worker.scope.registration.showNotification).toHaveBeenCalledWith(
      GENERIC.title,
      expect.objectContaining({ data: { path: "/" } }),
    );
  });

  it("opens a new window on the path when it controls none, and closes the notification", async () => {
    const close = await worker.click({ path: APPROVAL });
    expect(close).toHaveBeenCalledTimes(1);
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}${APPROVAL}`);
    expect(worker.scope.navigator.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("brings a window it controls to the path instead of opening another", async () => {
    const window = { focus: vi.fn(async () => undefined), navigate: vi.fn(async () => null) };
    worker.scope.clients.matchAll.mockResolvedValue([window]);
    await worker.click({ path: APPROVAL });
    expect(worker.scope.clients.matchAll).toHaveBeenCalledWith({ type: "window" });
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.navigate).toHaveBeenCalledWith(`${ORIGIN}${APPROVAL}`);
    expect(worker.scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when the one it controls refuses to navigate", async () => {
    const window = {
      focus: vi.fn(async () => undefined),
      navigate: vi.fn(async () => Promise.reject(new TypeError("not controlled"))),
    };

    worker.scope.clients.matchAll.mockResolvedValue([window]);
    await worker.click({ path: APPROVAL });
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}${APPROVAL}`);
  });

  it.each([
    [{ path: "https://evil.example/" }],
    [{ path: `${ORIGIN}${APPROVAL}` }],
    [{ path: "//evil.example/w/ws_1/approvals/apr_1" }],
    [{ path: "/\\evil.example" }],
    [{ path: "/w/ws_01HZY/wallets/wal_1" }],
    [{ path: "javascript:alert(1)" }],
    [null],
    ["/w/ws_01HZY/approvals/apr_01HZY"],
  ])("opens only a page of this site, the workspace list for %j", async (data) => {
    await worker.click(data);
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});

describe("notificationFor", () => {
  const show = (message: unknown) => worker.helpers.notificationFor(message, ORIGIN);

  it("keeps a summary message's text and the reminder's shared tag", () => {
    expect(
      show(
        declarative({
          title: "Expiring soon: Payment waiting",
          body: "Invoice payer in Research team",
        }),
      ),
    ).toEqual({
      title: "Expiring soon: Payment waiting",
      body: "Invoice payer in Research team",
      tag: "approval-apr_01HZY",
      path: APPROVAL,
      badge: 1,
    });
  });

  it("drops the query and fragment of the link", () => {
    expect(show(declarative({ navigate: `${ORIGIN}${APPROVAL}?token=x#y` })).path).toBe(APPROVAL);
  });

  it("flattens control and direction characters and cuts long text to 60 characters", () => {
    const shown = show(
      declarative({ title: "Pay\u202e now\nURGENT", body: `${"long ".repeat(30)}end` }),
    );

    expect(shown.title).toBe("Pay now URGENT");
    expect(Array.from(shown.body)).toHaveLength(60);
    expect(shown.body.endsWith("…")).toBe(true);
  });

  it("uses a default tag and no badge when those fields are odd", () => {
    const shown = show(declarative({ tag: "x<script>", app_badge: "lots" }));
    expect(shown.tag).toBe("approval");
    expect(shown.badge).toBeNull();
  });

  it.each([
    ["a message that is not declarative", { title: "Approval waiting" }],
    ["another version", { ...declarative(), web_push: 1 }],
    ["no title", declarative({ title: "  " })],
    ["a title that is not text", declarative({ title: 42 })],
    ["no link", declarative({ navigate: undefined })],
    ["a link to a page that is not an approval", declarative({ navigate: `${ORIGIN}/settings` })],
    ["an http link to this host", declarative({ navigate: `http://os.example${APPROVAL}` })],
    ["a protocol-relative link", declarative({ navigate: `//evil.example${APPROVAL}` })],
    ["a backslash link", declarative({ navigate: `/\\evil.example${APPROVAL}` })],
    ["a javascript: link", declarative({ navigate: "javascript:alert(1)" })],
    [
      "dot segments that leave the approval page",
      declarative({ navigate: `${ORIGIN}${APPROVAL}/../../../../settings` }),
    ],
    ["text", "Approval waiting"],
    ["null", null],
  ])("falls back to the generic notification for %s", (_name, message) => {
    expect(show(message)).toEqual(GENERIC);
  });

  it("accepts a link to the workspace list", () => {
    expect(show(declarative({ navigate: `${ORIGIN}/` })).path).toBe("/");
  });
});

describe("pagePath", () => {
  it.each([
    [`${ORIGIN}${APPROVAL}`, APPROVAL],
    [APPROVAL, APPROVAL],
    [`${ORIGIN}/`, "/"],
    [`${ORIGIN}/w/ws_1/approvals/apr_1/../../approvals/apr_2`, "/w/ws_1/approvals/apr_2"],
    [`${ORIGIN}/%2F%2Fevil.example`, null],
    [`${ORIGIN}/w/ws_1/approvals/apr%2F1`, null],
    [`${ORIGIN}/login`, null],
    ["https://os.example.evil.example/", null],
    [42, null],
  ])("maps %j to %j", (link, path) => {
    expect(worker.helpers.pagePath(link, ORIGIN)).toBe(path);
  });
});
