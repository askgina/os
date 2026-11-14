/**
 * One person's first day through the real UI, against a fresh installation of the real stack:
 * claim the server, create a workspace and an agent, set and approve the wallet's limits, and
 * approve one payment that an agent proposed over MCP. Passkeys come from Chromium's virtual
 * authenticator, so registration and every approval go through the browser's WebAuthn API.
 *
 * `e2e/run.sh` starts a second, empty stack for this file, because setting up a server can be
 * done only once.
 */
import { expect, type Page, test } from "@playwright/test";
import { createPublicClient, createTestClient, formatEther, http, parseEther } from "viem";
import { foundry } from "viem/chains";
import { connectAgent } from "../src/agent.ts";
import { setupToken, stack, waitUntilHealthy } from "../src/stack.ts";

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

async function addAuthenticator(page: Page): Promise<void> {
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
}

test.beforeAll(async () => {
  await waitUntilHealthy();
});

test("setup, an agent with limits, and one payment approved with a passkey in the browser", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A console error or an uncaught exception on any page fails the gate: it is how a blocked
  // script or style under the Content-Security-Policy would show up.
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()} (${page.url()})`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await addAuthenticator(page);

  await test.step("the setup token and a passkey create the first owner", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Setup token").fill(await setupToken());
    await page.getByLabel("Your name").fill("Ada Owner");
    await page.getByRole("button", { name: "Create owner passkey" }).click();
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    if (HTTPS) {
      const session = (await page.context().cookies()).find((c) => c.name.endsWith("os_session"));
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
  const token = (await page.locator("code", { hasText: /^osa_/ }).first().textContent()) ?? "";
  expect(token).toMatch(/^osa_/);

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
  const agent = await connectAgent(`${stack.origin}/mcp`, token);
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
});
