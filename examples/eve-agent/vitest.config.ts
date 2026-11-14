import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "eve-agent",
    include: ["test/**/*.test.ts"],
    // Each run builds the agent with `eve build` and starts it as a server.
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
