import { defineConfig } from "oxlint";

// anti-slop is vendored in tools/oxlint/anti-slop (see tools/oxlint/README.md).
// Run with `bun run lint:slop`. The Effect bundle is not registered: no workspace depends on `effect`.
export default defineConfig({
  ignorePatterns: [
    ".agents/**",
    "tools/oxlint/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/.swc/**",
    "**/.well-known/**",
    "**/coverage/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "**/.vitest/**",
    "**/.workflow-data/**",
    ".packs/**",
    "apps/web/dev/screenshots/**",
    "**/*.gen.ts",
    "**/migrations/meta/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-martinfowler",
      specifier: "./tools/oxlint/anti-slop/martinfowler/index.ts",
    },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/max-ternary-depth": ["error", { maxDepth: 2 }],
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-spread": "error",
    "anti-slop/no-disabled-type-assertion-rules": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-reprovide-ambient-service": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    // Code smells are prompts to look, so they warn. message-chains stays off, as upstream ships it.
    "anti-slop-martinfowler/global-data": "warn",
    "anti-slop-martinfowler/long-function": "warn",
    "anti-slop-martinfowler/long-parameter-list": "warn",
    "anti-slop-martinfowler/loops": "warn",
    "anti-slop-martinfowler/mutable-data": "warn",
    "anti-slop-martinfowler/mysterious-name": "warn",
    "anti-slop-martinfowler/repeated-switches": "warn",
  },
  overrides: [
    {
      // These files run with no node_modules: browser scripts served as they are, single files
      // mounted into a bare Node container, and the example that is dependency-free on purpose.
      // `no-runtime-typeof` asks for a schema decode at the boundary, and no schema library can
      // load there, so a `typeof` check is the decode. Every other rule still applies to them.
      files: [
        "apps/web/public/*.js",
        "apps/approve/public/*.js",
        "apps/web/dev/confirm/*.js",
        "deploy/init/*.mjs",
        "e2e/src/openbao-bootstrap.mts",
        "e2e/src/webhook-receiver.mts",
        "examples/ntfy-sidecar/**",
      ],
      rules: { "anti-slop/no-runtime-typeof": "off" },
    },
  ],
});
