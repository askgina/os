import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "web",
    // The browser journey (`*.e2e.ts`) is Playwright's; Vitest runs only the plain logic tests.
    include: ["test/**/*.test.ts"],
  },
});
