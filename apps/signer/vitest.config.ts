import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "signer",
    // The image smoke needs a built image and Docker, so it runs only when one is named.
    include: process.env.SIGNER_IMAGE ? ["smoke/*.test.ts"] : ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
