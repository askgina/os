/**
 * One person's first day through the real UI, against a fresh installation of the real stack:
 * claim the server, create a workspace and an agent, set and approve the wallet's limits, and
 * approve one payment that an agent proposed over MCP, then a second one on the signer's
 * confirmation page. Passkeys come from Chromium's virtual authenticator, so registration and
 * every approval go through the browser's WebAuthn API.
 *
 * The tests share one tab and its authenticator, in order: the passkey the first test registers
 * on the control plane's origin is the one the confirmation page asks for.
 *
 * `e2e/run.sh` starts a second, empty stack for this file, because setting up a server can be
 * done only once.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createPublicClient, createTestClient, formatEther, http, parseEther } from "viem";
import { foundry } from "viem/chains";
import { connectAgent } from "../src/agent.ts";
import { setupToken, stack, waitUntilHealthy } from "../src/stack.ts";

test.describe.configure({ mode: "serial" });

const RECIPIENT = "0x00000000000000000000000000000000000b0b0b";
const HTTPS = stack.origin.startsWith("https:");

const chain = createPublicClient({
  chain: foundry,
  transport: http(stack.anvilUrl),
  cacheTime: 0,
});
const chainAdmin = createTestClient({
  chain: foundry,
  mode: "anvil",
  transport: http(stack.anvilUrl),
});

let context: BrowserContext;
let page: Page;
/**
 * A console error or an uncaught exception on any page fails the gate that saw it: it is how a
 * blocked script or style under the Content-Security-Policy would show up.
 */
const problems: string[] = [];
/** The agent the first test creates, whose wallet the second test pays from again. */
let agentToken = "";

async function addAuthenticator(target: Page): Promise<void> {
  const cdp = await target.context().newCDPSession(target);
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
}

test.beforeAll(async ({ browser }) => {
  await waitUntilHealthy();
  context = await browser.newContext({ baseURL: stack.origin, ignoreHTTPSErrors: HTTPS });
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()} (${page.url()})`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message} (${page.url()})`));
  await addAuthenticator(page);
});

test.beforeEach(() => {
  problems.length = 0;
});

test.afterAll(async () => {
  await context?.close();
});

test("setup, an agent with limits, and one payment approved with a passkey in the browser", async () => {
  test.setTimeout(240_000);

  await test.step("the setup token and a passkey create the first owner", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Setup token").fill(await setupToken());
    await page.getByLabel("Your name").fill("Ada Owner");
    await page.getByRole("button", { name: "Create owner passkey" }).click();
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    if (HTTPS) {
      const session = (await context.cookies()).find((c) => c.name.endsWith("os_session"));
      expect(session).toMatchObject({ name: "__Host-os_session", secure: true, httpOnly: true });
    }
  });

  await test.step("a workspace and an agent, whose token is shown once", async () => {
    await page.getByLabel("New workspace").fill("Research team");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByLabel("Agent name").fill("Invoice payer");
    await page.getByRole("button", { name: "Add an agent" }).click();
    await expect(page.locator("code", { hasText: /^osa_/ }).first()).toBeVisible();
  });
  agentToken = (await page.locator("code", { hasText: /^osa_/ }).first().textContent()) ?? "";
  expect(agentToken).toMatch(/^osa_/);

  await test.step("the wallet's first limits are approved with the passkey", async () => {
    await page.getByRole("link", { name: "Overview" }).click();
    await page.getByRole("link", { name: "Set this wallet's policy" }).click();
    await page.getByLabel("Most per transaction ETH").fill("0.05");
    await page.getByLabel("Most per 24 hours ETH").fill("0.2");
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await page.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page.getByText("Done. The change is in effect.")).toBeVisible({ timeout: 60_000 });
  });

  // From here the agent acts, over MCP, exactly as any agent would.
  const agent = await connectAgent(`${stack.origin}/mcp`, agentToken);
  const me = await agent.call("whoami");
  const address = /0x[0-9a-fA-F]{40}/.exec(JSON.stringify(me))?.[0] as `0x${string}`;
  await chainAdmin.setBalance({ address, value: parseEther("1") });
  const before = await chain.getBalance({ address: RECIPIENT });
  const proposal = await agent.call("propose_transfer", {
    chainId: "eip155:31337",
    to: RECIPIENT,
    amount: "0.015",
    memo: "Pay invoice #4411 to Northwind <b>not bold</b>",
  });

  await test.step("the approval page shows the payment and the passkey approves it", async () => {
    await page.goto(new URL(String(proposal.approvalUrl)).pathname);
    await expect(page.getByRole("heading", { name: /^Send 0\.015 ETH to 0x0000/ })).toBeVisible();
    // The memo is the agent's text, shown literally, never as HTML.
    await expect(page.locator("blockquote")).toHaveText(
      "Pay invoice #4411 to Northwind <b>not bold</b>",
    );
    await expect(page.locator("blockquote b")).toHaveCount(0);
    await expect(page.getByText("15000000000000000 base units")).toBeVisible();
    await page.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 120_000 });
  });

  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.015");
  const state = await agent.call("get_intent", { intentId: proposal.intentId });
  expect(state.status).toBe("confirmed");
  await agent.close();

  await test.step("the log verifies, and the passkey signs in again after signing out", async () => {
    const workspacePath = new URL(page.url()).pathname.replace(/\/approvals\/.*$/, "");
    await page.goto(`${workspacePath}/activity`);
    await page.getByRole("button", { name: "Verify log" }).click();
    await expect(page.getByText(/The log is intact/)).toBeVisible();
    await page.goto("/settings");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(page.getByText("Research team")).toBeVisible();
  });

  expect(problems).toEqual([]);
});

// Over HTTPS this is the plan's gate "the confirmation page over HTTPS shows the payment and a
// passkey there approves it": origin https://localhost:8443, RP ID `localhost`, and the passkey
// enrolled on the control plane's origin. Over plain HTTP it runs the same steps on another port.
test(`the confirmation page${HTTPS ? " over HTTPS" : ""} shows the payment and a passkey there approves it`, async () => {
  test.setTimeout(240_000);
  expect(agentToken, "the first gate creates the agent").toMatch(/^osa_/);
  const agent = await connectAgent(`${stack.origin}/mcp`, agentToken);
  const before = await chain.getBalance({ address: RECIPIENT });
  const memo = "Pay invoice #4412 to Northwind <i>not italic</i>";
  const proposal = await agent.call("propose_transfer", {
    chainId: "eip155:31337",
    to: RECIPIENT,
    amount: "0.02",
    memo,
  });
  const approvalPath = new URL(String(proposal.approvalUrl)).pathname;
  const approvalId = approvalPath.split("/").at(-1) ?? "";
  let confirmUrl = "";

  await test.step("the approval page links to the signer's page on its own origin", async () => {
    await page.goto(approvalPath);
    await expect(page.getByRole("heading", { name: /^Send 0\.02 ETH to 0x0000/ })).toBeVisible();
    const link = page.getByRole("link", { name: "Review and approve on the signer's page" });
    confirmUrl = (await link.getAttribute("href")) ?? "";
    const target = new URL(confirmUrl);
    expect(target.origin).toBe(stack.approveOrigin);
    expect(target.pathname).toBe(`/a/${approvalId}`);
    expect(target.search).toBe("");
    expect(target.hash).toMatch(/^#[A-Za-z0-9_-]{22}$/);
    await expect(page.getByText(target.host, { exact: true })).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(confirmUrl);
  });

  await test.step("the signer's page shows the payment as the signer holds it", async () => {
    // The page names its own origin, for the person to compare with the address bar.
    await expect(page.locator("#origin")).toHaveText(stack.approveOrigin);
    await expect(page.getByRole("heading", { name: "Send 0.02 ETH", exact: true })).toBeVisible();
    await expect(page.getByText(RECIPIENT, { exact: true })).toBeVisible();
    await expect(page.getByText("Local chain (eip155:31337)", { exact: true })).toBeVisible();
    // The agent's note is set apart as text nobody checked, and shown literally.
    const note = page.locator(".line-unchecked", { hasText: "Pay invoice #4412" });
    await expect(note.locator("dd")).toHaveText(memo);
    await expect(note.getByText("Not checked by the signer", { exact: true })).toBeVisible();
    await expect(page.locator("main i")).toHaveCount(0);
    await expect(page.getByText("Waiting for approvals. 0 of 1 so far.")).toBeVisible();
  });

  await test.step("the passkey approves it there, and the page goes back to the request", async () => {
    await page.getByRole("button", { name: "Approve with passkey" }).click();
    await expect(page.getByText(/^The signer recorded your approval: 1 of 1\./)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(`${stack.origin}${approvalPath}`, { timeout: 15_000 });
    // The control plane collects the approval when the page asks for the request, and signs.
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 120_000 });
  });

  expect(formatEther((await chain.getBalance({ address: RECIPIENT })) - before)).toBe("0.02");
  const state = await agent.call("get_intent", { intentId: proposal.intentId });
  expect(state.status).toBe("confirmed");
  await agent.close();

  await test.step("the link takes no further approval", async () => {
    await page.goto(confirmUrl);
    await expect(
      page.getByText("The signer already acted on this request. It cannot be approved again."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve with passkey" })).toHaveCount(0);
  });

  expect(problems).toEqual([]);
});

test("over HTTPS, plain HTTP is redirected and browsers are told to stay on HTTPS", async () => {
  test.skip(!HTTPS, "the stack under test is served without TLS");
  // These requests verify the certificate against Caddy's local authority and the host name.
  const secure = await fetch(`${stack.origin}/healthz`);
  expect(secure.status).toBe(200);
  expect(secure.headers.get("strict-transport-security")).toMatch(/max-age=\d{7,}/);
  const plain = await fetch(`${stack.origin.replace("https:", "http:")}/healthz`, {
    redirect: "manual",
  });
  expect(plain.status).toBe(308);
  expect(plain.headers.get("location")).toBe(`${stack.origin}/healthz`);

  // The confirmation page has its own certificate-checked site, which says the same.
  const confirmation = await fetch(`${stack.approveOrigin}/healthz`);
  expect(confirmation.status).toBe(200);
  expect(confirmation.headers.get("strict-transport-security")).toMatch(/max-age=\d{7,}/);
  expect(confirmation.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});
