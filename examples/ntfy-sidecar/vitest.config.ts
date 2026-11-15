import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ntfy-sidecar",
    include: ["test/**/*.test.ts"],
  },
});
