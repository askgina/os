import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "keys",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
