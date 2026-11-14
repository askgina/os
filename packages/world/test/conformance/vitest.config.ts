import { defineConfig } from "vitest/config";

// Used only by conformance.test.ts, which runs upstream's suite as a child process.
export default defineConfig({
  test: {
    name: "world-conformance",
    root: import.meta.dirname,
    include: ["suite.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
