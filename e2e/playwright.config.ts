import { defineConfig } from "@playwright/test";
import { stack } from "./src/stack.ts";

// The gates share one running stack and change its state, so they run in one worker, in order.
export default defineConfig({
  testDir: "./test",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  reporter: [["list"]],
  use: {
    baseURL: stack.origin,
    // Over HTTPS the stack's certificate comes from Caddy's local authority, which the browser
    // does not know. The test process itself verifies it (see `e2e/run.sh`).
    ignoreHTTPSErrors: stack.origin.startsWith("https:"),
    trace: "retain-on-failure",
  },
});
