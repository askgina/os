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
    trace: "retain-on-failure",
  },
});
