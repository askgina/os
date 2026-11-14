import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "world",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // The integration tests start host processes on fixed ports; running files in parallel
    // would make them collide.
    fileParallelism: false,
  },
});
