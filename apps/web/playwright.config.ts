import { defineConfig } from "@playwright/test";
import type { LayoutOptions } from "./test/layout.ts";

/**
 * By default the journey runs against the Vite dev server, which proxies `/api` to the in-memory
 * fixture server; both send the production Content-Security-Policy, and nothing is built. Set
 * OS_WEB_BASE_URL to run it against a real control plane serving the built UI instead.
 */
const external = process.env.OS_WEB_BASE_URL;
// `localhost`, not 127.0.0.1: WebAuthn refuses an IP address as the relying party.
const baseURL = external ?? "http://localhost:55730";

const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const desktop = { viewport: { width: 1280, height: 800 } };

export default defineConfig<LayoutOptions>({
  testDir: "test",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Chromium's new headless mode, not the separate headless shell: in the shell
    // `Notification.permission` stays "denied" and a service worker may not show notifications,
    // whatever permission is granted. `playwright install chromium` installs both.
    channel: "chromium",
  },
  projects: [
    { name: "phone-light", use: { ...phone, colorScheme: "light" } },
    { name: "phone-dark", use: { ...phone, colorScheme: "dark" } },
    { name: "desktop-light", use: { ...desktop, colorScheme: "light" } },
    { name: "desktop-dark", use: { ...desktop, colorScheme: "dark" } },
    // The phone journey with every letter wider than on any font here or on CI's runners, so a
    // screen that fits only with narrow fonts fails on this machine too, not first in CI.
    { name: "phone-wide-font", use: { ...phone, colorScheme: "light", widerText: true } },
  ],
  ...(external
    ? {}
    : {
        webServer: [
          {
            command: "node dev/fixture-server.ts",
            url: "http://127.0.0.1:55731/api/v1/session",
            reuseExistingServer: false,
            stdout: "ignore",
          },
          {
            command: "bunx vite --strictPort",
            url: `${baseURL}/`,
            reuseExistingServer: false,
            stdout: "ignore",
          },
        ],
      }),
});
