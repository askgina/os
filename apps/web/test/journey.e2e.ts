import { readFile } from "node:fs/promises";
import {
  type APIRequestContext,
  test as baseTest,
  type CDPSession,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { expectNoSidewaysOverflow, type LayoutOptions, widenText } from "./layout.ts";
import { standInPushManager } from "./push-stand-in.ts";

/**
 * One person's whole first day, through the UI only: set up the server, create a workspace and
 * an agent, set and approve the wallet's limits, then approve one payment and reject one raw
 * contract call. Passkeys come from Chromium's virtual authenticator. Every approval is made
 * where approvals are made: on the signer's confirmation page, on its own origin. Against the
 * fixture that page is its stand-in (`dev/confirm/`).
 *
 * Some steps act as the agent instead of a person (proposing payments). Against the fixture they
 * use its `/__fixture/propose` endpoint; against a real server, point OS_WEB_PROPOSE_URL at an
 * equivalent helper that proposes over MCP with the agent's token.
 *
 * Payments the fixture holds back from the chain (`/__fixture/settle`) show their attempts and
 * why they are not mined: one is sped up, with no passkey, and is mined; another is cancelled
 * through a cancel request approved on the confirmation page, and ends cancelled on chain. A
 * viewer later reads a stuck one with no action.
 *
 * Every captured screen is checked for content wider than the screen (`shot`).
 *
 * A second person joins as an approver. Before anyone can approve the change that adds them,
 * they prove on the confirmation page that the new passkey is theirs and read its fingerprint,
 * which the owner compares before approving there.
 *
 * The owner then approves payments in advance (a mandate): the editor shows the worst case before
 * submitting, the grant card shows the sentence, the worst case, every recipient and the end
 * time, and it is approved on the confirmation page. The agent pays a listed recipient under it
 * with nobody asked, a payment over its cap still waits in the inbox, and revoking it asks for a
 * confirmation, not a passkey.
 *
 * Notifications: with Web Push off at the server the settings page says so and names the
 * webhook instead; with it on, the owner turns notifications on for this device, which registers
 * the real service worker at `/sw.js` under the production Content-Security-Policy. The browser's
 * push subscription is a stand-in (`push-stand-in.ts`: headless Chromium reaches no push
 * service), and push messages reach the worker through the DevTools protocol, unencrypted, as a
 * push service would hand them over after decryption. The owner removes another device, turns a
 * reminder off, sets quiet hours and lets notifications name the request; a viewer sees that
 * choice but cannot change it. After signing out, the path of a notification the worker showed
 * leads through sign-in back to its approval.
 */

const test = baseTest.extend<LayoutOptions>({ widerText: [false, { option: true }] });

const SETUP_TOKEN = process.env.OS_WEB_SETUP_TOKEN ?? "fixture-setup-token-0123456789";
const SCREENSHOTS = new URL("../dev/screenshots/", import.meta.url).pathname;
const RECIPIENT = "0x52908400098527886e0f7030069857d2e4169ee7";
/** A second recipient an approval in advance lists. */
const PAYEE = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
/** A key fingerprint as the pages show it: four groups of four Crockford base32 letters. */
const FINGERPRINT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
/**
 * The projects whose phone screen height means something: real fonts at a real size. The
 * `phone-wide-font` project widens every letter beyond any real font to find sideways overflow
 * and wrapping, so its text runs taller than on any phone; it skips the one-screen height rule
 * and keeps the sideways check on every screen.
 */
const ONE_SCREEN_PROJECTS = new Set(["phone-light", "phone-dark"]);

async function addAuthenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/**
 * Every console error, uncaught exception or failed request fails the journey. A step that
 * provokes a refusal on purpose removes exactly that entry.
 */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console: ${message.text()} at ${message.location().url} (${page.url()})`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400)
      problems.push(
        `response ${response.status()} ${response.request().method()} ${response.url()}`,
      );
  });
  return problems;
}

/**
 * Approves the open request on the signer's confirmation page, with this page's passkey. The link
 * opens it in the same tab, and the confirmation page comes back to the request when done.
 */
async function approveOnSignerPage(page: Page): Promise<void> {
  const request = page.url();
  const link = page.getByRole("link", { name: "Review and approve on the signer's page" });
  const confirmation = new URL((await link.getAttribute("href")) ?? "");
  await link.click();
  await expect(page).toHaveURL((url) => url.origin === confirmation.origin);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page).toHaveURL(request, { timeout: 15_000 });
}

/** A service worker registration, as the DevTools protocol reports it. */
interface ServiceWorkerRegistrationInfo {
  registrationId: string;
  scopeURL: string;
  isDeleted: boolean;
}

/** A notification the page's service worker shows, as the browser lists it. */
interface ShownNotification {
  title: string;
  body: string;
  tag: string;
  path: unknown;
}

async function shownNotifications(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const shown = (await registration?.getNotifications()) ?? [];
    return shown.map((item) => ({
      title: item.title,
      body: item.body,
      tag: item.tag,
      path: (item.data as { path?: unknown } | null)?.path ?? null,
    }));
  });
}

/**
 * Hands a push message to the page's service worker as a push service would after decrypting
 * it: through the DevTools protocol, so the worker's own `push` handler shows it. `cdp` is the
 * page's session that holds its virtual authenticator.
 */
async function deliverPush(page: Page, cdp: CDPSession, message: unknown): Promise<void> {
  const origin = new URL(page.url()).origin;
  const registered = Promise.withResolvers<string>();
  const timer = setTimeout(
    () => registered.reject(new Error("no service worker registered")),
    10_000,
  );
  const listener = ({ registrations }: { registrations: ServiceWorkerRegistrationInfo[] }) => {
    const found = registrations.find((item) => !item.isDeleted && item.scopeURL === `${origin}/`);
    if (found) registered.resolve(found.registrationId);
  };
  cdp.on("ServiceWorker.workerRegistrationUpdated", listener);
  await cdp.send("ServiceWorker.enable");
  const registrationId = await registered.promise.finally(() => clearTimeout(timer));
  cdp.off("ServiceWorker.workerRegistrationUpdated", listener);
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin,
    registrationId,
    data: JSON.stringify(message),
  });
  await cdp.send("ServiceWorker.disable");
}

/** The message the server sends for a waiting request, at the `count` level. */
function approvalMessage(link: string, pending: number) {
  return {
    web_push: 8030,
    notification: {
      title: "Approval waiting",
      body:
        pending === 1 ? "1 request needs your passkey" : `${pending} requests need your passkey`,
      navigate: link,
      tag: `approval-${link.split("/").pop()}`,
      lang: "en",
      silent: false,
      app_badge: String(pending),
    },
  };
}

/**
 * Checks the screen for content wider than it, then captures the page, a part or the view, under
 * the project's name.
 */
async function capture(
  on: Page,
  testInfo: TestInfo,
  name: string,
  target: { element?: Locator; viewport?: true } = {},
): Promise<void> {
  await expectNoSidewaysOverflow(on, name);
  const path = `${SCREENSHOTS}${testInfo.project.name}-${name}.png`;
  await (target.element
    ? target.element.screenshot({ path })
    : on.screenshot({ path, fullPage: !target.viewport }));
}

/**
 * On a phone, a request's decision fits on the first screen, without scrolling. Only with real
 * fonts: see ONE_SCREEN_PROJECTS.
 */
async function expectOnFirstScreen(page: Page, testInfo: TestInfo, decision: Locator) {
  const viewport = page.viewportSize();
  const box = await decision.boundingBox();
  if (ONE_SCREEN_PROJECTS.has(testInfo.project.name) && viewport && box) {
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
}

/** Sets up the server through the UI: its first owner, with this page's passkey. */
async function setUpServer(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create owner passkey" }).click();
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
}

/** Acts as the agent: proposes a native transfer and returns its intent and approval ids. */
async function proposePayment(
  request: APIRequestContext,
  url: string,
  token: string,
  amount: string,
) {
  const proposed = await request.post(url, {
    headers: { authorization: `Bearer ${token}` },
    data: { kind: "transfer", to: RECIPIENT, amount, memo: "Pay invoice" },
  });
  expect(proposed.ok()).toBe(true);
  return (await proposed.json()) as { id: string; approvalId: string };
}

test("first day: setup, agent, limits, one approved payment, one rejected call", async ({
  page,
  request,
  baseURL,
  browser,
  widerText,
}, testInfo) => {
  test.setTimeout(360_000);
  /** `capture` on the owner's page unless `on` names another person's. */
  const shot = (
    name: string,
    target: { element?: Locator; viewport?: true } = {},
    on: Page = page,
  ) => capture(on, testInfo, name, target);
  const expectDecisionOnFirstScreen = (decision: Locator) =>
    expectOnFirstScreen(page, testInfo, decision);
  /** Another person's browser, on the same kind of screen as the owner's, with a passkey. */
  const personPage = async (): Promise<{ person: Page; personProblems: string[] }> => {
    const { viewport, deviceScaleFactor, isMobile, hasTouch, colorScheme } = testInfo.project.use;
    const context = await browser.newContext({
      baseURL,
      viewport,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      colorScheme: colorScheme ?? "light",
    });
    if (widerText) await widenText(context);
    const person = await context.newPage();
    const personProblems = watchConsole(person);
    await addAuthenticator(person);
    return { person, personProblems };
  };
  const problems = watchConsole(page);
  const proposeUrl = process.env.OS_WEB_PROPOSE_URL ?? `${baseURL}/__fixture/propose`;
  if (!process.env.OS_WEB_BASE_URL) await request.post(`${baseURL}/__fixture/reset`);
  if (widerText) await widenText(page.context());
  const ownerSession = await addAuthenticator(page);

  await test.step("setup creates the first owner with a passkey", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { name: "Set up this server" })).toBeVisible();
    if (widerText) {
      // The project proves nothing unless the wider letters really reached the page.
      const body = page.locator("body");
      expect(await body.evaluate((node) => getComputedStyle(node).letterSpacing)).toBe("1.28px");
    }
    await shot("01-setup");
    await page.getByLabel("Setup token").fill(SETUP_TOKEN);
    await page.getByLabel("Your name").fill("Ada Owner");
    await page.getByRole("button", { name: "Create owner passkey" }).click();
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(page.getByText("No workspaces yet")).toBeVisible();
    await shot("02-workspaces-empty");
  });

  await test.step("a workspace leads to adding an agent", async () => {
    await page.getByLabel("New workspace").fill("Research team");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByText("Next: add an agent")).toBeVisible();
    await shot("03-overview-new");
  });

  let token = "";
  await test.step("adding an agent shows its token once", async () => {
    await page.getByLabel("Agent name").fill("Invoice payer");
    await page.getByRole("button", { name: "Add an agent" }).click();
    await expect(page.getByText("Copy this token now. It is shown only this once.")).toBeVisible();
    token = (await page.locator("code", { hasText: /^osa_/ }).first().textContent()) ?? "";
    expect(token).toMatch(/^osa_/);
    await shot("04-agent-token");
    // Coming back to the page later must not show the token again.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Invoice payer" })).toBeVisible();
    await expect(page.getByText("Copy this token now")).toHaveCount(0);
    await expect(page.locator("code", { hasText: token })).toHaveCount(0);
  });

  await test.step("the wallet's first limits are set and approved", async () => {
    await page.getByRole("link", { name: "Overview" }).click();
    await expect(page.getByText("Next: set this wallet's limits")).toBeVisible();
    await shot("05-overview-needs-policy");
    await page.getByRole("link", { name: "Set this wallet's policy" }).click();
    await expect(page.getByRole("heading", { name: "Set this wallet's limits" })).toBeVisible();
    await page.getByLabel("Most per transaction ETH").fill("0.05");
    await page.getByLabel("Most per 24 hours ETH").fill("0.2");
    // The editor says the rule up front, and the server's refusal lands next to the field.
    const threshold = page.getByLabel("Approvals needed per payment");
    await expect(page.getByText("At most 1, the number needed for admin changes.")).toBeVisible();
    await threshold.fill("2");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    const fieldError = threshold.locator("xpath=..").getByRole("alert");
    await expect(fieldError).toHaveText(/at most 1, the number needed for admin changes/);
    // The browser reports the refused request twice: as a response and as a console line.
    const expected = (line: string) =>
      /^response 400 POST .*\/policy$/.test(line) || /status of 400 .* at \S+\/policy /.test(line);
    expect(problems.filter(expected)).toHaveLength(2);
    problems.splice(0, problems.length, ...problems.filter((line) => !expected(line)));
    await threshold.fill("1");
    await shot("06-wallet-editor");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByRole("heading", { name: /Change the limits of/ })).toBeVisible();
    await expect(page.getByText("This is the wallet's first policy.")).toBeVisible();
    await shot("07-approval-policy");
    await approveOnSignerPage(page);
    await expect(page.getByText("Done. The change is in effect.")).toBeVisible();
    await shot("08-approval-policy-done");
  });

  let approvalUrl = "";
  await test.step("a payment shows everything needed to decide, on one phone screen", async () => {
    const proposed = await request.post(proposeUrl, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        kind: "transfer",
        to: RECIPIENT,
        amount: "15000000000000000",
        memo: "Pay invoice #4411 to Northwind <b>not bold</b>",
      },
    });
    expect(proposed.ok()).toBe(true);
    const intent = (await proposed.json()) as { approvalId: string };
    const workspacePath = new URL(page.url()).pathname.replace(/\/approvals\/.*$/, "");
    await page.goto(`${workspacePath}/approvals`);
    await expect(page.getByRole("link", { name: /Send 0\.015 ETH/ })).toBeVisible();
    await shot("09-inbox");
    approvalUrl = `${workspacePath}/approvals/${intent.approvalId}`;
    await page.goto(approvalUrl);

    await expect(page.getByRole("heading", { name: /^Send 0\.015 ETH to 0x5290/ })).toBeVisible();
    // The memo is the agent's text, shown literally, never as HTML.
    await expect(page.locator("blockquote")).toHaveText(
      "Pay invoice #4411 to Northwind <b>not bold</b>",
    );
    await expect(page.locator("blockquote b")).toHaveCount(0);
    await expect(page.getByText("15000000000000000 base units")).toBeVisible();
    await expect(page.getByText("0 of 1 approvals")).toBeVisible();
    // The full recipient, checksummed and grouped: 5290 8400 0985 …
    await expect(page.getByText("5290").first()).toBeVisible();
    // The signer's own page for this request: another origin, the token after `#`, its host
    // named in words, and a link to copy for another device.
    const confirm = page.getByRole("link", { name: "Review and approve on the signer's page" });
    const confirmUrl = new URL((await confirm.getAttribute("href")) ?? "");
    expect(confirmUrl.origin).not.toBe(new URL(page.url()).origin);
    expect(`${confirmUrl.pathname}${confirmUrl.hash}`).toMatch(
      new RegExp(`^/a/${intent.approvalId}#[A-Za-z0-9_-]{22}$`),
    );
    await expect(confirm).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByText(confirmUrl.host, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
    // Approving happens only on the signer's page: nothing here asks for a passkey.
    await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
    await expectDecisionOnFirstScreen(confirm);
    await shot("10-approval-payment-viewport", { viewport: true });
    await page.getByText("Technical details").click();
    await expect(page.getByText("Intent hash (SHA-256)")).toBeVisible();
    await expect(page.getByText(/challenge/i)).toHaveCount(0);
    await shot("11-approval-payment-details");
    await page.getByText("Technical details").click();

    await approveOnSignerPage(page);
    await expect(page.getByText("Approved.", { exact: true })).toBeVisible();
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Included in a block. The payment went through.")).toBeVisible();
    await shot("12-approval-payment-confirmed");
  });

  await test.step("a raw contract call carries its warning and can be rejected without a passkey", async () => {
    const proposed = await request.post(proposeUrl, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        kind: "call",
        to: "0x1111111111111111111111111111111111111111",
        memo: "Approve router",
      },
    });
    expect(proposed.ok()).toBe(true);
    const { approvalId } = (await proposed.json()) as { approvalId: string };
    await page.goto(approvalUrl.replace(/[^/]+$/, approvalId));
    await expect(page.getByText("Raw contract call.")).toBeVisible();
    await shot("13-approval-raw-call", { viewport: true });
    await page.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByRole("dialog", { name: "Reject this request?" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
    await expect(page.getByText("This request was rejected. Nothing was signed.")).toBeVisible();
    await shot("14-approval-rejected");
  });

  /** The payment left stuck for good, which a viewer reads later. */
  let stuckUrl = "";
  await test.step("a stuck and a chain-rejected payment each say what happened in words", async () => {
    const settleUrl = `${baseURL}/__fixture/settle`;
    for (const [status, sentence, picture] of [
      [
        "stuck",
        /Later payments from this wallet on this network wait behind it\./,
        "23-approval-stuck",
      ],
      [
        "rejected",
        /The network never accepted it, and it will not be sent again\./,
        "24-approval-chain-rejected",
      ],
    ] as const) {
      const { id, approvalId } = await proposePayment(
        request,
        proposeUrl,
        token,
        "1000000000000000",
      );
      await page.goto(approvalUrl.replace(/[^/]+$/, approvalId));
      await approveOnSignerPage(page);
      await expect(page.getByText("Approved.", { exact: true })).toBeVisible();
      if (process.env.OS_WEB_BASE_URL) continue;
      expect((await request.post(settleUrl, { data: { intentId: id, status } })).ok()).toBe(true);
      await page.reload();
      await expect(page.getByText(sentence)).toBeVisible();
      if (status === "stuck") stuckUrl = new URL(page.url()).pathname;
      await shot(picture);
    }
  });

  await test.step("a stuck payment shows its attempts, speeds up, and a cancel goes through a passkey", async () => {
    // Only the fixture can hold a payment back from the chain.
    if (process.env.OS_WEB_BASE_URL) return;
    const attempts = page.getByRole("list", { name: "Attempts" });
    /** A payment approved, sent, and then held back by the network: its page, reloaded. */
    const stuckPayment = async (amount: string) => {
      const { id, approvalId } = await proposePayment(request, proposeUrl, token, amount);
      await page.goto(approvalUrl.replace(/[^/]+$/, approvalId));
      await approveOnSignerPage(page);
      await expect(page.getByText("Approved.", { exact: true })).toBeVisible();
      const settled = await request.post(`${baseURL}/__fixture/settle`, {
        data: { intentId: id, status: "stuck" },
      });
      expect(settled.ok()).toBe(true);
      await page.reload();
      await expect(page.getByText("Not mined yet", { exact: true })).toBeVisible();
      await expect(attempts.getByRole("listitem")).toHaveCount(1);
    };

    // Speeding up adds an attempt with a higher fee, with no passkey; the network includes it.
    await stuckPayment("1100000000000000");
    await expect(
      page.getByText(/Its network fee is too low for the network right now\./),
    ).toBeVisible();
    await page.getByRole("button", { name: "Speed up" }).click();
    await expect(attempts.getByText("Attempt 2: Same payment, higher fee")).toBeVisible();
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(attempts.getByText("Mined", { exact: true })).toHaveCount(1);
    await shot("44-approval-sped-up");

    // Cancelling is a request, approved with a passkey on the signer's page, and an attempt that
    // takes the payment's place only if the network includes it first. Here it does.
    await stuckPayment("1200000000000000");
    await page.getByRole("button", { name: "Cancel payment" }).click();
    await expect(
      page.getByRole("heading", { name: /^Cancel payment: Send 0\.0012 ETH to 0x5290/ }),
    ).toBeVisible();
    await expect(page.getByText("An attempt, not a guarantee.")).toBeVisible();
    const confirm = page.getByRole("link", { name: "Review and approve on the signer's page" });
    await expectDecisionOnFirstScreen(confirm);
    await shot("45-approval-cancel", { viewport: true });
    await approveOnSignerPage(page);
    await expect(page.getByText("Approved.", { exact: true })).toBeVisible();
    await expect(page.getByText("Cancelled on chain", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await shot("46-approval-cancel-done");
    await page.getByRole("link", { name: "Open the payment" }).click();
    await expect(page.getByText("Cancelled on chain", { exact: true })).toBeVisible();
    await expect(attempts.getByText("Attempt 2: Cancel: nothing sent to itself")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel payment" })).toHaveCount(0);
    await shot("47-approval-cancelled");
  });

  const workspacePath = () => new URL(page.url()).pathname.replace(/\/approvals\/.*$/, "");

  await test.step("a wallet is emptied to the treasury with an admin approval", async () => {
    await page.goto(workspacePath());
    await expect(page.getByRole("heading", { name: "Treasury" })).toBeVisible();
    await page.getByRole("button", { name: "Create treasury" }).click();
    await expect(page.getByRole("button", { name: "Create treasury" })).toHaveCount(0);
    await page.getByRole("link", { name: /Invoice payer/ }).click();
    await page.getByRole("link", { name: "Open wallet" }).click();
    const card = page.locator("#sweep");
    await expect(card.getByText("Empty this wallet")).toBeVisible();
    // Only destinations the signer accepts are offered: here, the treasury.
    await expect(card.getByLabel("Send it to")).toContainText("Treasury ·");
    await expect(card.getByLabel("Asset")).toContainText("ETH on");
    await shot("25-wallet-sweep", { element: card });
    await card.getByRole("button", { name: "Ask for approval" }).click();

    await expect(page.getByRole("heading", { name: /^Empty [0-9.]+ ETH to 0x/ })).toBeVisible();
    await expect(page.getByText("No limits apply.")).toBeVisible();
    await expect(page.getByText("The workspace's treasury.")).toBeVisible();
    await expect(page.getByText("None: a person asked for this")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Review and approve on the signer's page" }),
    ).toBeVisible();
    await shot("26-approval-sweep");
    await approveOnSignerPage(page);
    await expect(page.getByText("Approved.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Review and approve on the signer's page" }),
    ).toHaveCount(0);
    await shot("27-approval-sweep-done");
  });

  await test.step("a payment asked for under limits that changed since cannot be approved", async () => {
    const { approvalId } = await proposePayment(request, proposeUrl, token, "2000000000000000");
    // The limits change before anyone opens the payment, so the signer will not open it.
    await page.goto(workspacePath());
    await page.getByRole("link", { name: /Invoice payer/ }).click();
    await page.getByRole("link", { name: "Open wallet" }).click();
    await page.getByLabel("Most per 24 hours ETH").fill("0.3");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByRole("heading", { name: /Change the limits of/ })).toBeVisible();
    await approveOnSignerPage(page);
    await expect(page.getByText("Done. The change is in effect.")).toBeVisible();

    await page.goto(approvalUrl.replace(/[^/]+$/, approvalId));
    await expect(page.getByText("This request cannot be approved.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Review and approve on the signer's page" }),
    ).toHaveCount(0);
    await shot("28-approval-cannot-approve");
    await page.getByRole("button", { name: "Reject" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
    await expect(page.getByText("This request was rejected. Nothing was signed.")).toBeVisible();
  });

  let base = "";
  let joiner: Page | undefined;
  let joinerProblems: string[] = [];
  await test.step("the other pages render, and a second person joins as an approver", async () => {
    base = workspacePath();
    await page.goto(base);
    await expect(page.getByText("Invoice payer", { exact: true })).toBeVisible();
    await shot("15-overview");
    await page.getByRole("link", { name: /Invoice payer/ }).click();
    await expect(page.getByText("Recent requests")).toBeVisible();
    await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
    await shot("16-agent");
    await page.getByRole("link", { name: "Open wallet" }).click();
    await expect(page.getByText("ETH spent in the last 24 hours")).toBeVisible();
    await shot("17-wallet");
    await page.goto(`${base}/members`);
    const openInvites = page.getByRole("list", { name: "Open invites" });
    // A viewer invite that is revoked at once: its link must stop working.
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Create invite link" }).click();
    const revokedUrl = await page.getByLabel(/Invite link/).inputValue();
    await expect(openInvites.getByRole("listitem")).toHaveCount(1);
    await openInvites.getByRole("button", { name: /Revoke/ }).click();
    await expect(page.getByText("No open invites.")).toBeVisible();
    // A revoked link is dead, so the page stops offering it.
    await expect(page.getByLabel(/Invite link/)).toHaveCount(0);
    const revokedCheck = await request.get(
      `${baseURL}/api/v1/invites/${new URL(revokedUrl).pathname.split("/").pop()}`,
    );
    expect(revokedCheck.status()).toBe(404);

    await page.getByLabel("Role", { exact: true }).selectOption("approver");
    await page.getByRole("button", { name: "Create invite link" }).click();
    await expect(page.getByLabel(/Invite link/)).toBeVisible();
    const inviteUrl = await page.getByLabel(/Invite link/).inputValue();
    expect(new URL(inviteUrl).pathname).toMatch(/^\/join\/[A-Za-z0-9_-]+$/);
    await expect(openInvites.getByRole("listitem")).toHaveCount(1);

    // A second person joins with their own passkey, on the same kind of screen as the owner;
    // it waits to become an approver.
    ({ person: joiner, personProblems: joinerProblems } = await personPage());
    await joiner.goto(new URL(inviteUrl).pathname);
    await joiner.getByLabel("Your name").fill("Grace Approver");
    await joiner.getByRole("button", { name: "Create passkey and join" }).click();
    await expect(joiner.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(joiner.getByText("Research team")).toBeVisible();
    expect(joinerProblems).toEqual([]);

    await page.reload();
    await expect(page.getByText("No open invites.")).toBeVisible();
    await expect(page.getByText(/is waiting to become an approver/)).toBeVisible();
    const workspaceId = base.split("/").pop() ?? "";
    await expect(page.getByLabel("Command to enroll this passkey at the signer")).toHaveValue(
      new RegExp(
        `^docker compose exec signer node src/admin\\.ts enroll-approver --workspace ${workspaceId} --user usr_[A-Za-z0-9_-]+ --credential-id=[A-Za-z0-9_-]+ --public-key=[A-Za-z0-9_-]+$`,
      ),
    );
    await expect(page.getByRole("link", { name: "approval inbox" })).toHaveAttribute(
      "href",
      `${base}/approvals`,
    );
    await shot("18-members");
  });

  await test.step("the new person proves the passkey is theirs, then the owner compares and approves", async () => {
    if (!joiner) throw new Error("the second person never joined");
    const grace = joiner;
    // Grace finds the change that would let her approve in her own inbox. She cannot approve it,
    // but she is the one who has to act first.
    await grace.goto(`${base}/approvals`);
    await grace.getByRole("link", { name: /^Let Grace Approver/ }).click();
    await expect(
      grace.getByRole("heading", { name: "Let Grace Approver approve with a new passkey" }),
    ).toBeVisible();
    const approvalPath = new URL(grace.url()).pathname;
    const fingerprint =
      (await grace.locator("dd code", { hasText: FINGERPRINT }).textContent()) ?? "";
    expect(fingerprint).toMatch(FINGERPRINT);
    await expect(grace.getByText("Prove that this passkey is yours")).toBeVisible();
    await expect(
      grace.getByRole("link", { name: "Review and approve on the signer's page" }),
    ).toHaveCount(0);
    const prove = grace.getByRole("link", {
      name: "Prove the passkey is yours on the signer's page",
    });
    const proveUrl = new URL((await prove.getAttribute("href")) ?? "");
    expect(proveUrl.origin).not.toBe(new URL(grace.url()).origin);
    expect(proveUrl.pathname).toBe(`/a/${approvalPath.split("/").pop()}`);
    await shot("29-approval-new-approver", {}, grace);

    // The owner sees the same fingerprint and is told to compare it; the signer's page will not
    // take an approval before Grace's proof.
    await page.goto(approvalPath);
    await expect(page.locator("dd code", { hasText: FINGERPRINT })).toHaveText(fingerprint);
    await expect(
      page.getByText("Compare the fingerprint with Grace Approver before you approve"),
    ).toBeVisible();
    await expect(page.getByText("Prove that this passkey is yours")).toHaveCount(0);
    await shot("30-approval-add-approver");
    const review = page.getByRole("link", { name: "Review and approve on the signer's page" });
    expect(await review.getAttribute("href")).toBe(proveUrl.href);
    await review.click();
    await expect(page).toHaveURL((url) => url.origin === proveUrl.origin);
    await expect(page.getByRole("button", { name: "Approve with passkey" })).toBeDisabled();
    await expect(page.getByText(fingerprint, { exact: true })).toBeVisible();

    // Grace proves it with the new passkey; the page shows her the same fingerprint.
    await prove.click();
    await expect(grace).toHaveURL((url) => url.origin === proveUrl.origin);
    await grace.getByRole("button", { name: "This passkey is mine" }).click();
    await expect(grace.locator(".fingerprint")).toHaveText(fingerprint);
    await expect(grace.getByRole("button", { name: "This passkey is mine" })).toHaveCount(0);

    // Now the owner can approve, and Grace can approve from then on.
    await page.reload();
    await expect(page.getByText(fingerprint, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page).toHaveURL(`${baseURL}${approvalPath}`, { timeout: 15_000 });
    await expect(page.getByText("Done. The change is in effect.")).toBeVisible();
    await page.goto(`${base}/members`);
    await expect(page.getByText(/is waiting to become an approver/)).toHaveCount(0);
    await expect(page.getByText("Can approve", { exact: true })).toHaveCount(2);
    expect(joinerProblems).toEqual([]);
    await grace.context().close();
  });

  await test.step("an owner approves payments in advance, the agent pays under it, and it is revoked without a passkey", async () => {
    await page.goto(base);
    await page.getByRole("link", { name: /Invoice payer/ }).click();
    await page.getByRole("link", { name: "Open wallet" }).click();
    const card = page.locator("#mandates");
    await expect(card.getByText("Nothing is approved in advance.")).toBeVisible();
    await card.getByRole("button", { name: "Approve in advance…" }).click();
    const editor = card.getByRole("form", { name: "New approval in advance" });
    await editor.getByLabel("Recipients, one address per line").fill(`${RECIPIENT}\n${PAYEE}`);
    // Over the wallet's 0.05 ETH per transaction: the server refuses and says why, in words.
    await editor.getByLabel("Most per payment").fill("0.06");
    await editor.getByLabel("Most in any 24 hours").fill("0.1");
    await editor.getByLabel("Most in total").fill("0.2");
    await editor.getByLabel("Payments, at most").fill("3");
    await expect(editor.getByLabel(/^Network fee per payment, at most/)).toHaveValue("0.01");
    await editor.getByRole("radio", { name: /^In 7 days/ }).check();
    await editor
      .getByLabel("Purpose, shown to everyone who approves")
      .fill("Pay Northwind invoices");
    await editor.getByRole("button", { name: "Ask for approval" }).click();
    await expect(editor.getByRole("alert")).toHaveText(
      "The most per payment is more than the wallet's limit per transaction.",
    );
    const refused = (line: string) =>
      /^response 400 POST .*\/mandates$/.test(line) ||
      /status of 400 .* at \S+\/mandates /.test(line);
    expect(problems.filter(refused)).toHaveLength(2);
    problems.splice(0, problems.length, ...problems.filter((line) => !refused(line)));

    await editor.getByLabel("Most per payment").fill("0.01");
    await editor.getByLabel("Most in any 24 hours").fill("0.02");
    await editor.getByLabel("Most in total").fill("0.03");
    // The worst case shows before anything is submitted.
    await expect(editor.getByRole("region", { name: "Worst case" })).toHaveText(
      /At most 0\.03 ETH can leave this wallet under this approval, plus network fees of at most 0\.01 ETH per payment \(0\.03 ETH in all\)\./,
    );
    await shot("31-wallet-mandate-editor", { element: card });
    await editor.getByRole("button", { name: "Ask for approval" }).click();

    // The grant card: the sentence, the worst case, every recipient and the end time.
    await expect(
      page.getByRole("heading", {
        name: "Let Invoice payer pay from Invoice payer's wallet without asking",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /^Let Invoice payer pay up to 0\.01 ETH at a time to 2 listed recipients, at most 0\.02 ETH in any 24 hours and 0\.03 ETH in total, at most 3 payments, until .+ \(your time.*\)\.$/,
      ),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Worst case" })).toContainText(
      "At most 0.03 ETH can leave this wallet",
    );
    await expect(page.getByRole("list", { name: "Recipients" }).getByRole("listitem")).toHaveCount(
      2,
    );
    await expect(
      page.getByText("The wallet's limits still apply and count these payments."),
    ).toBeVisible();
    await expect(page.getByText("Pay Northwind invoices", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
    await shot("32-approval-mandate");
    await page.getByText("Technical details").click();
    await expect(page.getByText("Mandate hash (SHA-256)")).toBeVisible();
    await shot("33-approval-mandate-details");
    await page.getByText("Technical details").click();
    await approveOnSignerPage(page);
    await expect(page.getByText("Done. The change is in effect.")).toBeVisible();
    await page.getByRole("link", { name: "Open the approval in advance" }).click();
    await expect(
      page.getByRole("heading", { name: "Approved in advance for Invoice payer" }),
    ).toBeVisible();
    await expect(page.getByText("0 of 3 payments used")).toBeVisible();
    await expect(page.getByText("No payment was made under it yet.")).toBeVisible();
    await shot("34-mandate-new");
    const mandatePath = new URL(page.url()).pathname;

    // The agent pays a listed recipient within the caps: signed with nobody asked.
    const covered = await request.post(proposeUrl, {
      headers: { authorization: `Bearer ${token}` },
      data: { kind: "transfer", to: RECIPIENT, amount: "5000000000000000", memo: "Invoice 4413" },
    });
    expect(covered.ok()).toBe(true);
    const coveredIntent = (await covered.json()) as {
      approvalId: string | null;
      mandateId: string | null;
    };
    expect(coveredIntent.approvalId).toBeNull();
    expect(coveredIntent.mandateId).toBe(mandatePath.split("/").pop());
    // Over its per-payment cap: that one waits for a person, as before.
    const over = await proposePayment(request, proposeUrl, token, "20000000000000000");
    expect(over.approvalId).toMatch(/^apr_/);

    await page.reload();
    await expect(page.getByText("1 of 3 payments used")).toBeVisible();
    await expect(page.getByText(/^Send 0\.005 ETH to /)).toBeVisible();
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 15_000 });
    await shot("35-mandate-used");
    // It has no request of its own: its own page shows its transaction.
    await page.getByRole("link", { name: /^Send 0\.005 ETH to / }).click();
    await expect(page.getByRole("heading", { name: /^Send 0\.005 ETH to 0x5290/ })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Attempts" }).getByText("Mined", { exact: true }),
    ).toBeVisible();
    await shot("48-payment-mandated");
    await page.getByRole("link", { name: "← Approved in advance for Invoice payer" }).click();

    // The wallet's card and the agent's page show it, with its usage.
    await page.getByRole("link", { name: "← Invoice payer's wallet" }).click();
    await expect(
      card.getByRole("link", { name: /^Invoice payer: up to 0\.01 ETH per payment/ }),
    ).toBeVisible();
    await expect(card.getByText("1 of 3 payments used")).toBeVisible();
    await shot("36-wallet-mandates", { element: card });
    await page.goto(base);
    await page.getByRole("link", { name: /Invoice payer/ }).click();
    await expect(page.locator("#mandates").getByText("1 of 3 payments used")).toBeVisible();
    const mandated = page.getByRole("link", { name: "Approved in advance", exact: true });
    await expect(mandated).toHaveCount(1);
    await shot("37-agent-mandates");

    // Revoking asks for confirmation, not a passkey, and the mandate shows as ended.
    await mandated.click();
    await expect(page).toHaveURL(new RegExp(`${mandatePath}$`));
    await page.getByRole("button", { name: "Revoke" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this approval in advance?" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
    await shot("38-mandate-revoke", { viewport: true });
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(page.getByText(/Someone who can approve revoked it\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    await shot("39-mandate-revoked");

    // After that, the same payment waits for a person.
    const after = await proposePayment(request, proposeUrl, token, "4000000000000000");
    expect(after.approvalId).toMatch(/^apr_/);
    await page.goto(`${base}/approvals`);
    await expect(page.getByRole("link", { name: /^Send 0\.004 ETH/ })).toBeVisible();
    await page.goto(`${base}/members`);
  });

  await test.step("notifications: off at the server, then on for this device, with quiet hours, a device removed and what they say", async () => {
    const notifications = page.getByRole("region", { name: "Notifications" });
    if (!process.env.OS_WEB_BASE_URL) {
      // The operator has not turned Web Push on: the page says so and names the webhook.
      const off = await request.post(`${baseURL}/__fixture/web-push`, { data: { enabled: false } });
      expect(off.ok()).toBe(true);
      await page.goto("/settings");
      await expect(
        notifications.getByText("This server does not send notifications to phones or browsers."),
      ).toBeVisible();
      await expect(notifications.getByText(/\(its webhook\)/)).toBeVisible();
      await expect(notifications.getByRole("button")).toHaveCount(0);
      await shot("40-settings-push-off", { element: notifications });
      const on = await request.post(`${baseURL}/__fixture/web-push`, { data: { enabled: true } });
      expect(on.ok()).toBe(true);
    }

    // The browser allows notifications here; its push subscription is the stand-in.
    await page.context().grantPermissions(["notifications"]);
    await page.context().addInitScript(standInPushManager);
    await page.goto("/settings");
    await expect(
      notifications.getByText(
        "Off. Your browser will ask whether this site may show notifications.",
      ),
    ).toBeVisible();
    await notifications.getByLabel("Name for this device").fill("Ada's phone");
    await notifications
      .getByRole("button", { name: "Turn on notifications on this device" })
      .click();
    await expect(
      notifications.getByText(
        "On. This device gets a notification when a request waits for your passkey.",
      ),
    ).toBeVisible();
    const devices = notifications.getByRole("list", { name: "Your devices" });
    await expect(devices.getByRole("listitem")).toHaveCount(1);
    await expect(devices.getByText("Ada's phone")).toBeVisible();
    await expect(devices.getByText("This device", { exact: true })).toBeVisible();
    // The real worker, served at /sw.js under the production Content-Security-Policy.
    const worker = await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.scriptURL ?? null,
    );
    expect(worker).toBe(`${baseURL}/sw.js`);

    // A message for a waiting request shows with its approval's path; one linking elsewhere
    // shows as the generic notification, which opens the workspace list.
    const { approvalId } = await proposePayment(request, proposeUrl, token, "3000000000000000");
    const approvalPath = `${base}/approvals/${approvalId}`;
    // The browser's debugging interface sometimes hands a message to a worker that is still
    // starting and drops it, so the messages are handed over again until both show. A repeat
    // replaces the notification with the same tag: the result is the same.
    await expect(async () => {
      await deliverPush(page, ownerSession, approvalMessage(`${baseURL}${approvalPath}`, 2));
      await deliverPush(
        page,
        ownerSession,
        approvalMessage(`https://evil.example${approvalPath}`, 1),
      );
      await expect
        .poll(() => shownNotifications(page), { timeout: 5_000 })
        .toEqual(
          expect.arrayContaining([
            {
              title: "Approval waiting",
              body: "2 requests need your passkey",
              tag: `approval-${approvalId}`,
              path: approvalPath,
            },
            {
              title: "Approval waiting",
              body: "Open the app to see what waits for you.",
              tag: "approval",
              path: "/",
            },
          ]),
        );
    }).toPass({ timeout: 60_000 });

    // Another of Ada's browsers subscribes, as it would through this page there; she removes
    // it here.
    const added = await page.evaluate(async () => {
      const encode = (bytes: Uint8Array) =>
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ]);
      const response = await fetch("/api/v1/me/push-subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: "https://updates.push.services.mozilla.com/wpush/v2/stand-in-laptop",
          keys: {
            p256dh: encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
            auth: encode(crypto.getRandomValues(new Uint8Array(16))),
          },
          label: "Work laptop",
        }),
      });
      return response.ok;
    });
    expect(added).toBe(true);
    await page.reload();
    await expect(devices.getByRole("listitem")).toHaveCount(2);
    await notifications.getByRole("button", { name: "Remove Work laptop" }).click();
    await expect(devices.getByRole("listitem")).toHaveCount(1);
    await expect(devices.getByText("Ada's phone")).toBeVisible();

    // No reminder before Research team's requests expire, on any device.
    const reminder = notifications.getByRole("switch", {
      name: "Remind me before Research team's requests expire",
    });
    await expect(reminder).toHaveAttribute("aria-checked", "true");
    await reminder.click();
    await expect(reminder).toHaveAttribute("aria-checked", "false");
    await expect(
      notifications.getByRole("switch", { name: "Notify me about Research team" }),
    ).toHaveAttribute("aria-checked", "true");

    // Quiet hours across midnight, in a time zone that is not the device's own; the form says
    // what to fix before anything is sent.
    const quiet = notifications.getByRole("form", { name: "Quiet hours" });
    await quiet.getByLabel("Hold notifications during quiet hours").check();
    await quiet.getByLabel("From", { exact: true }).fill("22:00");
    await quiet.getByLabel("Until", { exact: true }).fill("22:00");
    await quiet.getByLabel("Time zone").selectOption("Europe/London");
    await quiet.getByRole("button", { name: "Save quiet hours" }).click();
    await expect(quiet.getByRole("alert")).toHaveText(
      "Quiet hours must end at another time than they start.",
    );
    await quiet.getByLabel("Until", { exact: true }).fill("07:00");
    await quiet.getByRole("button", { name: "Save quiet hours" }).click();
    await expect(quiet.getByText("Saved.")).toBeVisible();
    await expect(
      quiet.getByText(/^From 22:00 to 07:00 the next morning, Europe\/London time,/),
    ).toBeVisible();
    await page.reload();
    await expect(quiet.getByLabel("Hold notifications during quiet hours")).toBeChecked();
    await expect(quiet.getByLabel("Until", { exact: true })).toHaveValue("07:00");
    await expect(quiet.getByLabel("Time zone")).toHaveValue("Europe/London");
    await expect(reminder).toHaveAttribute("aria-checked", "false");
    await shot("41-settings-notifications");

    // The owner lets this workspace's notifications name the request; it is in the log.
    await page.goto(base);
    const level = page.getByRole("region", { name: "What notifications say" });
    await expect(
      level.getByText(/^Notifications never show amounts or recipients\./),
    ).toBeVisible();
    await level
      .getByRole("radio", { name: /^Also the kind of request, who asked and this workspace/ })
      .check();
    await expect(level.getByText(/Payment waiting · Invoice payer in Research team/)).toBeVisible();
    await level.getByRole("button", { name: "Save" }).click();
    await expect(level.getByText("Saved.")).toBeVisible();
    await shot("42-workspace-notification-level", { element: level });
    await page.goto(`${base}/activity`);
    await expect(page.getByText("workspace.notification_detail_set")).toBeVisible();

    // A viewer sees the choice but cannot change it, here or by asking the server.
    await page.goto(`${base}/members`);
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Create invite link" }).click();
    const viewerInvite = await page.getByLabel(/Invite link/).inputValue();
    const { person: viewer, personProblems: viewerProblems } = await personPage();
    await viewer.goto(new URL(viewerInvite).pathname);
    await viewer.getByLabel("Your name").fill("Lin Viewer");
    await viewer.getByRole("button", { name: "Create passkey and join" }).click();
    await expect(viewer.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await viewer.goto(base);
    const seen = viewer.getByRole("region", { name: "What notifications say" });
    await expect(
      seen.getByText("Also the kind of request, who asked and this workspace."),
    ).toBeVisible();
    await expect(seen.getByText("Only an owner of this workspace can change this.")).toBeVisible();
    await expect(seen.getByRole("radio")).toHaveCount(0);
    await expect(seen.getByRole("button")).toHaveCount(0);
    await shot("43-workspace-notification-level-viewer", { element: seen }, viewer);
    if (!process.env.OS_WEB_BASE_URL) {
      // A viewer reads a stuck payment's attempts and state, with no action.
      await viewer.goto(stuckUrl);
      await expect(viewer.getByText("Not mined yet", { exact: true })).toBeVisible();
      await expect(
        viewer.getByRole("list", { name: "Attempts" }).getByRole("listitem"),
      ).toHaveCount(1);
      await expect(
        viewer.getByText("Owners and approvers can speed it up or cancel it."),
      ).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Speed up" })).toHaveCount(0);
      await expect(viewer.getByRole("button", { name: "Cancel payment" })).toHaveCount(0);
      await shot("49-approval-stuck-viewer", {}, viewer);
    }
    const refused = await viewer.evaluate(async (workspaceId) => {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/notification-detail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detail: "count" }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    }, base.split("/").pop() ?? "");
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    // The browser reports the refused request twice: as a response and as a console line.
    const forbidden = (line: string) =>
      /^response 403 POST .*\/notification-detail$/.test(line) ||
      /status of 403 .* at \S+\/notification-detail /.test(line);
    expect(viewerProblems.filter(forbidden)).toHaveLength(2);
    expect(viewerProblems.filter((line) => !forbidden(line))).toEqual([]);
    await viewer.context().close();
    await page.goto(`${base}/members`);
  });

  await test.step("activity, settings, sign-in and the join page render", async () => {
    const openInvites = page.getByRole("list", { name: "Open invites" });
    // A fresh link for the signed-out join page below; the first one was used.
    await page.getByRole("button", { name: "Create invite link" }).click();
    await expect(openInvites.getByRole("listitem")).toHaveCount(1);
    const joinPageUrl = await page.getByLabel(/Invite link/).inputValue();
    await page.goto(`${base}/activity`);
    await page.getByRole("button", { name: "Verify log" }).click();
    await expect(page.getByText(/The log is intact/)).toBeVisible();
    await shot("19-activity");
    await page.goto("/settings");
    await expect(page.getByText("First passkey", { exact: true })).toBeVisible();
    await shot("20-settings");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
    await shot("21-login");
    await page.goto(new URL(joinPageUrl).pathname);
    await expect(page.getByRole("heading", { name: "Join Research team" })).toBeVisible();
    await shot("22-join");
    // A notification pressed on this signed-out device: the worker shows it with the approval's
    // path (pressing it opens that path), which goes through sign-in and back to the approval.
    const pressed = `approval-${approvalUrl.split("/").pop()}`;
    await expect(async () => {
      await deliverPush(page, ownerSession, approvalMessage(`${baseURL}${approvalUrl}`, 1));
      await expect
        .poll(
          async () => (await shownNotifications(page)).find((item) => item.tag === pressed)?.path,
          { timeout: 5_000 },
        )
        .toBe(approvalUrl);
    }).toPass({ timeout: 60_000 });
    await page.goto(approvalUrl);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(page.getByRole("heading", { name: /^Send 0\.015 ETH to 0x5290/ })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(approvalUrl);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(page.getByText("Research team")).toBeVisible();
  });

  expect(problems).toEqual([]);
});

/**
 * The end of an agent, a wallet and a workspace, on a fresh server. Removing the agent says its
 * waiting payment requests end too. Retiring a wallet shows what the server reads is still in
 * it and when the key goes; it is approved on the signer's page, which warns that the key is
 * destroyed and that it cannot see balances; the retirement is cancelled during the delay, which
 * leaves the wallet stopped. A second wallet is retired to the end and shows its key destroyed.
 * Deleting the workspace needs it paused, shows what would be lost, waits with a countdown, is
 * cancelled, asked again, and finishes: the page then says the workspace was deleted.
 *
 * The 7-day delay is skipped with the fixture's `/__fixture/due`, so this runs against the
 * fixture only.
 */
test("the end of a wallet and of a workspace: retire, cancel, destroy, delete", async ({
  page,
  request,
  baseURL,
  widerText,
}, testInfo) => {
  test.skip(Boolean(process.env.OS_WEB_BASE_URL), "the delay is skipped with the fixture only");
  test.setTimeout(240_000);
  const shot = (name: string, target: { element?: Locator; viewport?: true } = {}) =>
    capture(page, testInfo, `lifecycle-${name}`, target);
  const problems = watchConsole(page);
  await request.post(`${baseURL}/__fixture/reset`);
  if (widerText) await widenText(page.context());
  await addAuthenticator(page);
  const due = async (data: { workspaceId: string; walletId?: string }) => {
    const response = await request.post(`${baseURL}/__fixture/due`, { data });
    expect(response.ok()).toBe(true);
  };

  /** Approves on the signer's page after checking its title and both warnings. */
  const approveDestruction = async (title: string) => {
    const review = page.getByRole("link", { name: "Review and approve on the signer's page" });
    await expect(review).toBeVisible();
    const back = page.url();
    await review.click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const warnings = page.getByRole("list", { name: "Warnings" });
    await expect(warnings.getByRole("listitem")).toHaveText([
      /destroys the keys of the wallets listed.*lost for good/,
      /^The signer cannot see balances/,
    ]);
    await page.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page).toHaveURL(back, { timeout: 15_000 });
  };

  let workspaceId = "";
  let overview = "";
  await test.step("removing an agent says its waiting payment requests end with it", async () => {
    await setUpServer(page, "Ada Owner");
    await page.getByLabel("New workspace").fill("Wind-down team");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByText("Next: add an agent")).toBeVisible();
    overview = new URL(page.url()).pathname;
    workspaceId = overview.split("/").pop() ?? "";
    await page.getByLabel("Agent name").fill("Invoice payer");
    await page.getByRole("button", { name: "Add an agent" }).click();
    await expect(page.getByRole("heading", { name: "Invoice payer" })).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove this agent?" });
    await expect(
      dialog.getByText(/Payments it asked for that still wait for approval are cancelled/),
    ).toBeVisible();
    await expect(dialog.getByText(/A removed agent cannot be added back/)).toBeVisible();
    await shot("01-remove-agent", { viewport: true });
    await dialog.getByRole("button", { name: "Remove agent" }).click();
    await expect(page.getByText("Removed", { exact: true })).toBeVisible();
  });

  await test.step("a wallet is retired, approved on the signer's page, and the retirement cancelled", async () => {
    await page.getByRole("link", { name: "Set this wallet's policy" }).click();
    await expect(page.getByRole("heading", { name: "Invoice payer's wallet" })).toBeVisible();
    await page.getByRole("button", { name: "Retire this wallet…" }).click();
    const card = page.locator("#retire");
    await expect(card.getByText("1.25 ETH")).toBeVisible();
    await expect(
      card.getByText(/^Read by the server; the signer cannot check balances/),
    ).toBeVisible();
    await expect(
      card.getByRole("radio", { name: /^In 7 days, the shortest the signer allows/ }),
    ).toBeChecked();
    await shot("02-retire-form", { element: card });
    await card.getByRole("button", { name: "Ask for approval to retire" }).click();

    await expect(
      page.getByRole("heading", { name: "Retire Invoice payer's wallet and destroy its key" }),
    ).toBeVisible();
    await expect(page.getByText("7 days from the request")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Still in the wallet" })).toBeVisible();
    await expect(page.getByText("1.25 ETH")).toBeVisible();
    await expectOnFirstScreen(page, testInfo, page.getByRole("region", { name: "Decision" }));
    await shot("03-approval-retire");
    // Until it is decided, the wallet's own page links the waiting request.
    const retireRequest = page.url();
    await page.goBack();
    await expect(page.getByText("Retiring this wallet is waiting for approval.")).toBeVisible();
    await shot("03b-wallet-retire-waiting");
    await page.getByRole("link", { name: "Open the request" }).click();
    await expect(page).toHaveURL(retireRequest);
    await approveDestruction("Retire a wallet");
    await expect(page.getByText("The wallet signs nothing more.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Open the wallet" }).click();

    await expect(page.getByText("This wallet is being retired")).toBeVisible();
    await expect(page.getByText(/left to cancel$/)).toBeVisible();
    await expect(page.getByText(/^Do not send anything here/)).toBeVisible();
    await shot("04-wallet-retiring");
    await page.getByRole("button", { name: "Cancel retirement" }).click();
    await page
      .getByRole("dialog", { name: "Cancel the retirement?" })
      .getByRole("button", { name: "Cancel retirement" })
      .click();
    await expect(page.getByText("Stopped: its retirement was cancelled")).toBeVisible();
    await expect(page.getByText("This wallet is being retired")).toHaveCount(0);
    await shot("05-wallet-stopped");
  });

  await test.step("a second wallet is retired to the end, and its key is destroyed", async () => {
    await page.goto(overview);
    await page.getByLabel("Treasury name").fill("Reserve");
    await page.getByRole("button", { name: "Create treasury" }).click();
    await page.getByRole("link", { name: /Reserve/ }).click();
    const walletId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await page.getByRole("button", { name: "Retire this wallet…" }).click();
    await page.getByRole("button", { name: "Ask for approval to retire" }).click();
    await expect(
      page.getByRole("heading", { name: "Retire Reserve and destroy its key" }),
    ).toBeVisible();
    await approveDestruction("Retire a wallet");
    await page.getByRole("link", { name: "Open the wallet" }).click();
    await expect(page.getByText("This wallet is being retired")).toBeVisible();
    await due({ workspaceId, walletId });
    await page.reload();
    await expect(page.getByText("Its key was destroyed")).toBeVisible();
    // Nothing is offered for a wallet without its key.
    await expect(page.getByRole("button", { name: "Retire this wallet…" })).toHaveCount(0);
    await shot("06-wallet-destroyed");
    await page.goto(overview);
    await expect(page.getByText("Key destroyed", { exact: true })).toBeVisible();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  });

  await test.step("deleting waits for a pause, shows what is lost, counts down and is cancelled", async () => {
    await page.getByRole("button", { name: "Delete this workspace…" }).click();
    const card = page.locator("#delete");
    await expect(card.getByText(/^Pause the workspace first/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Ask for approval to delete" })).toBeDisabled();
    await page.getByRole("switch", { name: "Pause all signing" }).click();
    await expect(card.getByText(/^Pause the workspace first/)).toHaveCount(0);
    // The destroyed treasury is gone already; the stopped wallet still holds what the server reads.
    await expect(card.getByText("Invoice payer's wallet")).toBeVisible();
    await expect(card.getByText("Reserve")).toHaveCount(0);
    await expect(card.getByText("1.25 ETH")).toBeVisible();
    await expect(
      card.getByText(/^A wallet still holds something the server can see/),
    ).toBeVisible();
    await shot("07-delete-form", { element: card });
    await card.getByRole("button", { name: "Ask for approval to delete" }).click();

    await expect(
      page.getByRole("heading", { name: "Delete this workspace and destroy 1 wallet key" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Still in the wallet" })).toBeVisible();
    await expectOnFirstScreen(page, testInfo, page.getByRole("region", { name: "Decision" }));
    await shot("08-approval-delete");
    // Until it is decided, the overview links the waiting request.
    const deleteRequest = page.url();
    await page.goBack();
    await expect(page.getByText("Deleting this workspace is waiting for approval.")).toBeVisible();
    await shot("08b-overview-delete-waiting", { viewport: true });
    await page.getByRole("link", { name: "Open the request" }).click();
    await expect(page).toHaveURL(deleteRequest);
    await approveDestruction("Delete this workspace");
    await page.getByRole("link", { name: "Open the workspace" }).click();

    await expect(page.getByText("This workspace is being deleted")).toBeVisible();
    await expect(page.getByText(/left to cancel$/)).toBeVisible();
    await expect(page.getByText("Being deleted", { exact: true })).toBeVisible();
    // Nothing can be added while it waits, and resuming waits for the cancel.
    await expect(page.getByRole("button", { name: "Add an agent" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Pause all signing" })).toBeDisabled();
    await shot("09-deleting");
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    await page
      .getByRole("dialog", { name: "Cancel the deletion?" })
      .getByRole("button", { name: "Cancel deletion" })
      .click();
    await expect(page.getByText("This workspace is being deleted")).toHaveCount(0);
    // The keys stay, and so does the pause: resuming needs its own approval.
    await expect(page.getByText(/^This workspace is paused/)).toBeVisible();
    await expect(page.getByRole("switch", { name: "Pause all signing" })).toBeEnabled();
    await shot("10-deletion-cancelled");
  });

  await test.step("asked again and left to finish, the workspace is gone", async () => {
    await page.getByRole("button", { name: "Delete this workspace…" }).click();
    await page.getByRole("button", { name: "Ask for approval to delete" }).click();
    await approveDestruction("Delete this workspace");
    await page.getByRole("link", { name: "Open the workspace" }).click();
    await expect(page.getByText("This workspace is being deleted")).toBeVisible();
    await due({ workspaceId });
    // The page reads the workspace again on its own and finds it gone.
    await expect(page.getByRole("heading", { name: "Wind-down team was deleted" })).toBeVisible({
      timeout: 15_000,
    });
    await shot("11-deleted");
    // Opened again, the page knows nothing of it, as the server answers anyone.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "This workspace does not exist or was deleted" }),
    ).toBeVisible();
    await shot("12-missing");
    // Those reads were refused as the server refuses its former members: the expected failures.
    const gone = (line: string) =>
      line.includes(`/api/v1/workspaces/${workspaceId}`) && /404|Not Found/.test(line);
    problems.splice(0, problems.length, ...problems.filter((line) => !gone(line)));
    await page.getByRole("link", { name: "← All workspaces" }).click();
    await expect(page.getByText("No workspaces yet")).toBeVisible();
  });

  expect(problems).toEqual([]);
});

/**
 * Taking a workspace elsewhere, and a person leaving the server. The owner downloads the
 * template; the record needs a recent sign-in, so the owner signs in again and comes back to it.
 * A copy and an import each show their new agent's token once, the limits waiting for approval,
 * the invite links and the admin threshold to raise; a reload shows the tokens gone. Erasing: the
 * only owner is told what to do first, and a viewer, after signing in again, is erased and signed
 * out.
 *
 * Every sign-in is dated back with the fixture's `/__fixture/stale-sign-in`, so this runs against
 * the fixture only.
 */
test("export, copy and import a workspace; erase a person", async ({
  page,
  request,
  baseURL,
  browser,
  widerText,
}, testInfo) => {
  test.skip(Boolean(process.env.OS_WEB_BASE_URL), "sign-ins are dated back with the fixture only");
  test.setTimeout(240_000);
  const shot = (
    name: string,
    target: { element?: Locator; viewport?: true } = {},
    on: Page = page,
  ) => capture(on, testInfo, `export-${name}`, target);
  const problems = watchConsole(page);
  /** Drops the expected refusals of `path` with `status` from a list of problems. */
  const expectRefused = (list: string[], status: number, path: string) => {
    const refused = (line: string) => line.includes(String(status)) && line.includes(path);
    expect(list.filter(refused).length).toBeGreaterThan(0);
    list.splice(0, list.length, ...list.filter((line) => !refused(line)));
  };
  await request.post(`${baseURL}/__fixture/reset`);
  if (widerText) await widenText(page.context());
  await addAuthenticator(page);
  const staleSignIns = async () => {
    expect((await request.post(`${baseURL}/__fixture/stale-sign-in`)).ok()).toBe(true);
  };

  let overview = "";
  let viewer: Page | null = null;
  let viewerProblems: string[] = [];
  await test.step("a workspace with an agent, approved limits and a viewer", async () => {
    await setUpServer(page, "Ada Owner");
    await page.getByLabel("New workspace").fill("Ops team");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByText("Next: add an agent")).toBeVisible();
    overview = new URL(page.url()).pathname;
    await page.getByLabel("Agent name").fill("Invoice payer");
    await page.getByRole("button", { name: "Add an agent" }).click();
    await expect(page.getByRole("heading", { name: "Invoice payer" })).toBeVisible();
    await page.goto(overview);
    await page.getByRole("link", { name: "Set this wallet's policy" }).click();
    await page.getByLabel("Most per transaction ETH").fill("0.05");
    await page.getByLabel("Most per 24 hours ETH").fill("0.2");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByRole("heading", { name: /Change the limits of/ })).toBeVisible();
    await approveOnSignerPage(page);
    await expect(page.getByText("Done. The change is in effect.")).toBeVisible();

    await page.goto(`${overview}/members`);
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Create invite link" }).click();
    const invite = await page.getByLabel(/Invite link/).inputValue();
    const { viewport, deviceScaleFactor, isMobile, hasTouch, colorScheme } = testInfo.project.use;
    const context = await browser.newContext({
      baseURL,
      viewport,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      colorScheme: colorScheme ?? "light",
    });
    if (widerText) await widenText(context);
    viewer = await context.newPage();
    viewerProblems = watchConsole(viewer);
    await addAuthenticator(viewer);
    await viewer.goto(new URL(invite).pathname);
    await viewer.getByLabel("Your name").fill("Lin Viewer");
    await viewer.getByRole("button", { name: "Create passkey and join" }).click();
    await expect(viewer.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  });

  let templatePath = "";
  await test.step("the template downloads; the record waits for a fresh sign-in", async () => {
    await page.goto(overview);
    const card = page.locator("#export");
    const [template] = await Promise.all([
      page.waitForEvent("download"),
      card.getByRole("button", { name: "Download template" }).click(),
    ]);
    expect(template.suggestedFilename()).toBe("ops-team-template.json");
    templatePath = testInfo.outputPath("ops-team-template.json");
    await template.saveAs(templatePath);
    const text = await readFile(templatePath, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      format: "askgina.os/workspace-template/v1",
      name: "Ops team",
      wallets: [{ ref: "w1", kind: "agent", agent: { name: "Invoice payer" } }],
    });
    // Configuration only: no token, and no wallet's address.
    expect(text).not.toContain("osa_");
    expect(text).not.toMatch(/"address"/);

    await staleSignIns();
    await card.getByRole("button", { name: "Download record" }).click();
    await expect(
      card.getByText(/^Sign in again with your passkey to download the record/),
    ).toBeVisible();
    await shot("01-sign-in-again", { element: card });
    expectRefused(problems, 403, "/export/record");
    await card.getByRole("button", { name: "Sign in again" }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(page).toHaveURL((url) => url.pathname === overview && url.hash === "#export");
    const [record] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#export").getByRole("button", { name: "Download record" }).click(),
    ]);
    expect(record.suggestedFilename()).toMatch(/^ops-team-record-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = (await readFile(await record.path(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { format?: string; type?: string; action?: string });
    expect(lines[0]).toMatchObject({ format: "askgina.os/workspace-record/v1" });
    expect(lines.at(-1)).toMatchObject({ type: "end" });
    // The record holds its own export.
    expect(lines.some((line) => line.action === "workspace.exported")).toBe(true);
  });

  await test.step("a copy shows its agent's token once, its waiting limits and its invite", async () => {
    const card = page.locator("#export");
    await card.getByRole("button", { name: "Copy this workspace…" }).click();
    await expect(card.getByLabel("Name of the new workspace")).toHaveValue("Ops team (copy)");
    await expect(card.getByLabel(/^Its agents/)).toBeChecked();
    await expect(card.getByLabel(/^Its members/)).toBeChecked();
    await shot("02-copy-form", { element: card });
    await card.getByRole("button", { name: "Create the copy" }).click();

    await expect(page.getByRole("heading", { name: "The new workspace is ready" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Ops team (copy)" })).toBeVisible();
    await expect(page.getByText("Copy these tokens now. They are shown only now.")).toBeVisible();
    const tokens = page.getByRole("list", { name: "New agent tokens" });
    await expect(tokens.getByRole("link", { name: "Invoice payer" })).toBeVisible();
    const token = (await tokens.locator("code").first().textContent()) ?? "";
    expect(token).toMatch(/^osa_/);
    await expect(
      page.getByRole("list", { name: "Limits waiting for approval" }).getByRole("link"),
    ).toHaveCount(1);
    const invites = page.getByRole("list", { name: "Invite links" });
    await expect(invites.getByText("Lin Viewer", { exact: true })).toBeVisible();
    await expect(invites.getByRole("textbox")).toHaveValue(/\/join\//);
    await expect(
      page.getByText(/^Admin changes in this workspace need 1 approval until you change it/),
    ).toBeVisible();
    await shot("03-copy-result");

    // Shown once: a reload finds the token gone.
    await page.reload();
    await expect(page.getByText("Shown once, and gone")).toBeVisible();
    await expect(page.locator("code", { hasText: token })).toHaveCount(0);
    await page.getByRole("link", { name: "Open the workspace" }).click();
    await expect(page.getByText("Next: set this wallet's limits")).toBeVisible();
  });

  await test.step("a template file imports as a new workspace, and a wrong file is refused", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Import a template…" }).click();
    const card = page.locator("#import");
    const file = card.getByLabel("Template file");
    await file.setInputFiles({
      name: "notes.json",
      mimeType: "application/json",
      buffer: Buffer.from("not a template"),
    });
    await expect(card.getByRole("alert")).toHaveText(
      "This file is not a workspace template: it is not JSON.",
    );
    await file.setInputFiles(templatePath);
    const name = card.getByLabel("Name of the new workspace");
    await expect(name).toHaveValue("Ops team");
    await expect(card.getByText(/^Ops team: 1 wallet, 1 agent, 2 members\./)).toBeVisible();
    await name.fill("Ops team imported");
    await card.getByLabel(/^Its members/).uncheck();
    await shot("04-import-form", { element: card });
    await card.getByRole("button", { name: "Create workspace from template" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Ops team imported" })).toBeVisible();
    await expect(page.getByRole("list", { name: "New agent tokens" }).locator("code")).toHaveCount(
      1,
    );
    await expect(page.getByRole("list", { name: "Invite links" })).toHaveCount(0);
    await shot("05-import-result");
  });

  await test.step("erasing: the only owner must hand over first; a viewer is erased", async () => {
    await page.goto("/settings");
    const card = page.locator("#erase");
    await card.getByRole("button", { name: "Erase me…" }).click();
    await page
      .getByRole("dialog", { name: "Erase yourself?" })
      .getByRole("button", { name: "Erase me", exact: true })
      .click();
    await expect(card.getByRole("alert")).toHaveText(/only owner of Ops team/);
    await shot("06-erase-last-owner", { element: card });
    expectRefused(problems, 409, "/me/erase");

    if (!viewer) throw new Error("the viewer joined in the first step");
    const person: Page = viewer;
    await person.goto("/settings");
    const theirs = person.locator("#erase");
    await theirs.getByRole("button", { name: "Erase me…" }).click();
    await person
      .getByRole("dialog", { name: "Erase yourself?" })
      .getByRole("button", { name: "Erase me", exact: true })
      .click();
    // Their sign-in was dated back with everyone's: they sign in again and come back.
    await expect(
      theirs.getByText(/^Sign in again with your passkey to erase yourself/),
    ).toBeVisible();
    expectRefused(viewerProblems, 403, "/me/erase");
    await theirs.getByRole("button", { name: "Sign in again" }).click();
    await person.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(person).toHaveURL((url) => url.pathname === "/settings" && url.hash === "#erase");
    await person.locator("#erase").getByRole("button", { name: "Erase me…" }).click();
    await person
      .getByRole("dialog", { name: "Erase yourself?" })
      .getByRole("button", { name: "Erase me", exact: true })
      .click();
    await expect(
      person.getByRole("heading", { name: "You were erased from this server" }),
    ).toBeVisible();
    await shot("07-erased", {}, person);
    // Signed out for good: the app sends them to sign in, and their passkey no longer works.
    await person.goto("/");
    await expect(person).toHaveURL(/\/login$/);
    expect(viewerProblems).toEqual([]);
    await person.context().close();

    await page.goto(`${overview}/members`);
    await expect(page.getByText("Lin Viewer")).toHaveCount(0);
    await page.goto(`${overview}/activity`);
    await expect(page.getByText("member.erased")).toBeVisible();
  });

  expect(problems).toEqual([]);
});

/**
 * An order on Hyperliquid testnet, on a fresh server. The owner turns on the wallet's venue
 * rules in the policy editor, which says up front that notional caps are not loss caps, and
 * approves them on the signer's page. The agent proposes a good-till-cancelled order: its
 * request shows market, side, size, limit price, notional, time in force, reduce-only and the
 * submit window, with the venue account's value as what can be lost, and no network fee. It is
 * approved on the signer's page, rests at the stand-in venue, and is cancelled with no passkey.
 *
 * The agent's order is proposed through the fixture's `/__fixture/propose`, so this runs against
 * the fixture only.
 */
test("an order on Hyperliquid testnet: venue rules, the order, where it rests, its cancel", async ({
  page,
  request,
  baseURL,
  widerText,
}, testInfo) => {
  test.skip(Boolean(process.env.OS_WEB_BASE_URL), "orders are proposed with the fixture only");
  test.setTimeout(240_000);
  const shot = (name: string, target: { element?: Locator; viewport?: true } = {}) =>
    capture(page, testInfo, `order-${name}`, target);
  const problems = watchConsole(page);
  await request.post(`${baseURL}/__fixture/reset`);
  if (widerText) await widenText(page.context());
  await addAuthenticator(page);

  let token = "";
  let walletUrl = "";
  let orderUrl = "";
  await test.step("the wallet's venue rules are set, with the caps said not to be loss caps", async () => {
    await setUpServer(page, "Ada Owner");
    await page.getByLabel("New workspace").fill("Trading desk");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByText("Next: add an agent")).toBeVisible();
    await page.getByLabel("Agent name").fill("Market maker");
    await page.getByRole("button", { name: "Add an agent" }).click();
    token = (await page.locator("code", { hasText: /^osa_/ }).first().textContent()) ?? "";
    expect(token).toMatch(/^osa_/);
    await page.getByRole("link", { name: "Overview" }).click();
    await page.getByRole("link", { name: "Set this wallet's policy" }).click();
    await expect(page.getByRole("heading", { name: "Set this wallet's limits" })).toBeVisible();
    walletUrl = page.url().split("#")[0] ?? "";
    await page.getByLabel("Most per transaction ETH").fill("0.05");
    await page.getByLabel("Most per 24 hours ETH").fill("0.2");
    await page.getByLabel("Allow orders on Hyperliquid testnet").check();
    await expect(page.getByText(/limit the notional of new orders, not losses/)).toBeVisible();
    await page.getByLabel("Coin, as Hyperliquid names it").fill("BTC");
    await page.getByLabel("Market index at Hyperliquid").fill("0");
    await page.getByLabel("Most notional per order (USD)").fill("1000");
    await page.getByLabel("Most notional per 24 hours (USD)").fill("2000");
    await page
      .getByLabel("good till cancelled: rests on the book until filled or cancelled")
      .check();
    await shot("01-editor", { element: page.locator("#policy") });
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByRole("heading", { name: /Change the limits of/ })).toBeVisible();
    await expect(page.getByText("Hyperliquid BTC (index 0): per order")).toBeVisible();
    await expect(page.getByText("1,000 USD notional")).toBeVisible();
    await shot("02-approval-policy");
    await approveOnSignerPage(page);
    await expect(page.getByText("Done. The change is in effect.")).toBeVisible();
  });

  await test.step("an order shows what is signed and what can be lost, and no network fee", async () => {
    const proposed = await request.post(`${baseURL}/__fixture/propose`, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        kind: "order",
        coin: "BTC",
        side: "buy",
        size: "0.01",
        limitPrice: "65000",
        timeInForce: "Gtc",
        memo: "Funding turned",
      },
    });
    expect(proposed.ok()).toBe(true);
    const { approvalId } = (await proposed.json()) as { approvalId: string };
    await page.goto(page.url().replace(/[^/]+$/, approvalId));
    await expect(page.getByRole("heading", { name: "Buy 0.01 BTC perpetual" })).toBeVisible();
    await expect(page.getByText("650 USD", { exact: true })).toBeVisible();
    await expect(page.getByText("65,000 USD, the most it pays")).toBeVisible();
    await expect(
      page.getByText("good till cancelled: rests on the book until filled or cancelled"),
    ).toBeVisible();
    await expect(
      page.getByText("Must reach Hyperliquid within 60 seconds of signing"),
    ).toBeVisible();
    await expect(
      page.getByText(/What can be lost: the whole account value at Hyperliquid, 250 USD/),
    ).toBeVisible();
    await expect(page.getByText("The agent may cancel it without asking again")).toBeVisible();
    await expect(page.getByText(/Network fee/)).toHaveCount(0);
    await expect(page.locator("blockquote")).toHaveText("Funding turned");
    // Approving happens only on the signer's page: nothing here asks for a passkey.
    await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
    await shot("03-approval-order-viewport", { viewport: true });
    await shot("04-approval-order");
    await approveOnSignerPage(page);
    await expect(page.getByText("Approved.", { exact: true })).toBeVisible();
    await expect(page.getByText("Resting at the venue", { exact: true })).toBeVisible();
    await expect(page.getByText("Venue order id", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel order" })).toBeVisible();
    await shot("05-order-resting");
    orderUrl = page.url();
  });

  await test.step("the wallet page shows the signer's count and the venue's report, labelled as such", async () => {
    await page.goto(walletUrl);
    const account = page.getByRole("heading", { name: "Hyperliquid testnet account" });
    await expect(account).toBeVisible();
    await expect(page.getByText("Order notional signed in the last 24 hours")).toBeVisible();
    await expect(page.getByText("650 USD of 2,000 USD")).toBeVisible();
    await expect(page.getByText("Counted by the signer.")).toBeVisible();
    await expect(page.getByText("250 USD", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("No open positions.")).toBeVisible();
    await expect(page.getByText("Buy 0.01 BTC at 65,000 USD")).toBeVisible();
    await expect(
      page.getByText("Reported by Hyperliquid through this server, not verified by the signer."),
    ).toBeVisible();
    await shot("06-wallet-venue");
    await page.goto(orderUrl);
  });

  await test.step("the resting order is cancelled with no passkey", async () => {
    await page.getByRole("button", { name: "Cancel order" }).click();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(
      page.getByText("It was cancelled at the venue before any of it filled."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    await shot("07-order-cancelled");
    await page.goto(walletUrl);
    await expect(page.getByRole("heading", { name: "Hyperliquid testnet account" })).toBeVisible();
    await expect(page.getByText("No resting orders.")).toBeVisible();
  });

  expect(problems).toEqual([]);
});
