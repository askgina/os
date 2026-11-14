import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every workspace that has its own Vitest configuration. The UI and the end-to-end gates
    // are driven by Playwright and are not part of this run.
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "examples/*/vitest.config.ts",
    ],
  },
});
