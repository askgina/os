import { fileURLToPath } from "node:url";
import { CONTENT_SECURITY_POLICY } from "@askgina/os-api";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fixturePort = Number(process.env.OS_WEB_FIXTURE_PORT ?? 55731);

export default defineConfig(({ command }) => ({
  // The React plugin's dev mode injects an inline Fast Refresh script, which the production
  // Content-Security-Policy forbids. The dev server sends that policy too, so it runs without
  // the plugin (Vite compiles JSX itself; a change reloads the page instead of hot-swapping).
  plugins: command === "build" ? [react(), tailwindcss()] : [tailwindcss()],
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Keep every asset a file: a strict Content-Security-Policy forbids data: and inline code.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    port: 55730,
    strictPort: true,
    host: "127.0.0.1",
    headers: { "content-security-policy": CONTENT_SECURITY_POLICY },
    // `bun run dev` talks to the in-memory fixture server (`bun run fixture`).
    proxy: {
      "/api": `http://127.0.0.1:${fixturePort}`,
      "/__fixture": `http://127.0.0.1:${fixturePort}`,
    },
  },
}));
