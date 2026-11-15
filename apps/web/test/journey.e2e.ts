import {
  type APIRequestContext,
  test as baseTest,
  type CDPSession,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { expectNoSidewaysOverflow, type LayoutOptions, widenText } from "./layout.ts";

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
 * Every captured screen is checked for content wider than the screen (`shot`).
 */

const test = baseTest.extend<LayoutOptions>({ widerText: [false, { option: true }] });

const SETUP_TOKEN = process.env.OS_WEB_SETUP_TOKEN ?? "fixture-setup-token-0123456789";
const SCREENSHOTS = new URL("../dev/screenshots/", import.meta.url).pathname;
const RECIPIENT = "0x52908400098527886e0f7030069857d2e4169ee7";

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
  test.setTimeout(240_000);
  /** Checks the screen for content wider than it, then captures the page, a part or the view. */
  const shot = async (name: string, target: { element?: Locator; viewport?: true } = {}) => {
    await expectNoSidewaysOverflow(page, name);
    const path = `${SCREENSHOTS}${testInfo.project.name}-${name}.png`;
    await (target.element
      ? target.element.screenshot({ path })
      : page.screenshot({ path, fullPage: !target.viewport }));
  };
  const problems = watchConsole(page);
  const proposeUrl = process.env.OS_WEB_PROPOSE_URL ?? `${baseURL}/__fixture/propose`;
  if (!process.env.OS_WEB_BASE_URL) await request.post(`${baseURL}/__fixture/reset`);
  if (widerText) await widenText(page.context());
  await addAuthenticator(page);

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
    // On a phone, the decision fits on the first screen, without scrolling.
    const viewport = page.viewportSize();
    const decision = await confirm.boundingBox();
    if (testInfo.project.name.startsWith("phone") && viewport && decision) {
      expect(decision.y + decision.height).toBeLessThanOrEqual(viewport.height);
    }
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
      await shot(picture);
    }
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

  await test.step("the other pages render", async () => {
    const base = workspacePath();
    await page.goto(base);
    await expect(page.getByText("Invoice payer")).toBeVisible();
    await shot("15-overview");
    await page.getByRole("link", { name: /Invoice payer/ }).click();
    await expect(page.getByText("Recent requests")).toBeVisible();
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
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

    // A second person joins with their own passkey; it waits to become an approver.
    const other = await browser.newContext({
      baseURL,
      colorScheme: testInfo.project.use.colorScheme ?? "light",
    });
    const joiner = await other.newPage();
    const joinerProblems = watchConsole(joiner);
    await addAuthenticator(joiner);
    await joiner.goto(new URL(inviteUrl).pathname);
    await joiner.getByLabel("Your name").fill("Grace Approver");
    await joiner.getByRole("button", { name: "Create passkey and join" }).click();
    await expect(joiner.getByRole("heading", { name: "Workspaces" })).toBeVisible();
    await expect(joiner.getByText("Research team")).toBeVisible();
    expect(joinerProblems).toEqual([]);
    await other.close();

    await page.reload();
    await expect(page.getByText("No open invites.")).toBeVisible();
    await expect(page.getByText(/is waiting to become an approver/)).toBeVisible();
    const workspaceId = base.split("/").pop() ?? "";
    await expect(page.getByLabel("Command to enroll this passkey at the signer")).toHaveValue(
      new RegExp(
        `^docker compose exec signer node src/admin\\.ts enroll-approver --workspace ${workspaceId} --user usr_[A-Za-z0-9_-]+ --credential-id [A-Za-z0-9_-]+ --public-key [A-Za-z0-9_-]+$`,
      ),
    );
    await expect(page.getByRole("link", { name: "approval inbox" })).toHaveAttribute(
      "href",
      `${base}/approvals`,
    );
    await shot("18-members");
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
    // An approval link opened while signed out comes back to that approval after sign-in.
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
