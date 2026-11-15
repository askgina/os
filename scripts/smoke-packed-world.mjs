#!/usr/bin/env node
/**
 * Proves the packed @askgina/os-keys and @askgina/os-world work outside this monorepo:
 *
 *   node scripts/pack-packages.mjs [packs-dir]
 *   node scripts/smoke-packed-world.mjs [packs-dir]     # default: .packs
 *
 * Installs the two tarballs into an empty temporary project (other dependencies from the
 * public registry), imports every entry point with Node, which refuses TypeScript inside
 * node_modules and so fails if an export still points at a source file, and type-checks a
 * consumer against the packed declarations with Node's ESM resolution.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = resolve(process.argv[2] ?? join(root, ".packs"));
const say = (line) => process.stdout.write(`${line}\n`);

const major = Number(process.versions.node.split(".")[0]);
if (major < 26) throw new Error(`smoke: Node 26 or later is required, this is ${process.version}`);

const packs = JSON.parse(readFileSync(join(packsDir, "packs.json"), "utf8"));
const tarball = (name) => {
  if (!packs[name]) throw new Error(`smoke: no tarball for ${name} in ${packsDir}/packs.json`);
  return `file:${join(packsDir, packs[name])}`;
};

// A consumer's own type packages, at the versions this repository tests with.
const manifest = (path) => JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
const typePackages = {
  "@types/node": manifest(".").devDependencies["@types/node"],
  "@types/pg": manifest("packages/world").devDependencies["@types/pg"],
};

const dir = mkdtempSync(join(tmpdir(), "os-world-smoke-"));
try {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "os-world-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@askgina/os-keys": tarball("@askgina/os-keys"),
          "@askgina/os-world": tarball("@askgina/os-world"),
        },
        devDependencies: typePackages,
        // The World's own dependency on the keys package is the packed tarball too, not a
        // registry lookup.
        overrides: { "@askgina/os-keys": "$@askgina/os-keys" },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts"],
    { cwd: dir, stdio: "inherit" },
  );

  writeFileSync(
    join(dir, "smoke.mjs"),
    `const say = (line) => process.stdout.write(line + "\\n");
const fail = (message) => { throw new Error("smoke: " + message); };
for (const specifier of [
  "@askgina/os-keys",
  "@askgina/os-keys/seal",
  "@askgina/os-world",
  "@askgina/os-world/target",
]) {
  const url = import.meta.resolve(specifier);
  if (!/\\/dist\\/[^/]+\\.js$/.test(url)) fail(specifier + " resolves to " + url + ", not dist/*.js");
}

const keys = await import("@askgina/os-keys");
if (typeof keys.DataKeyStore !== "function" || typeof keys.LocalKeyring !== "function")
  fail("@askgina/os-keys lacks DataKeyStore or LocalKeyring");
const { sealJson, openJson } = await import("@askgina/os-keys/seal");
const { randomBytes } = await import("node:crypto");
const key = randomBytes(32);
if (openJson(key, sealJson(key, { ok: 1 }, "smoke"), "smoke")?.ok !== 1) fail("seal round trip");
say("smoke: @askgina/os-keys loaded");

const world = await import("@askgina/os-world");
if (typeof world.createEncryptedWorld !== "function") fail("@askgina/os-world lacks createEncryptedWorld");
if (world.WITHHELD_ATTRIBUTE_VALUE !== "[withheld]") fail("@askgina/os-world lacks WITHHELD_ATTRIBUTE_VALUE");
say("smoke: @askgina/os-world loaded");

const target = await import("@askgina/os-world/target");
if (typeof target.createWorld !== "function" || target.default !== target.createWorld)
  fail("@askgina/os-world/target lacks its createWorld default export");
say("smoke: @askgina/os-world/target loaded");
`,
  );
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: dir, stdio: "inherit" });

  // Each assignment is wrong only if the packed declarations were found and resolved: a type
  // that fell back to \`any\` would accept it, and the unused @ts-expect-error then fails.
  writeFileSync(
    join(dir, "smoke.ts"),
    `import { LocalKeyring } from "@askgina/os-keys";
import { seal } from "@askgina/os-keys/seal";
import {
  ALWAYS_READABLE_ATTRIBUTE_KEYS,
  createEncryptedWorld,
  TENANT_START_OPTION,
  WITHHELD_ATTRIBUTE_VALUE,
} from "@askgina/os-world";
import createWorld from "@askgina/os-world/target";

// @ts-expect-error a class is not a number
export const a: number = LocalKeyring;
// @ts-expect-error a function is not a number
export const b: number = seal;
// @ts-expect-error a string array is not a number
export const c: number = ALWAYS_READABLE_ATTRIBUTE_KEYS;
// @ts-expect-error a function is not a number
export const d: number = createEncryptedWorld;
// @ts-expect-error a string is not a number
export const e: number = TENANT_START_OPTION;
// @ts-expect-error a string is not a number
export const f: number = WITHHELD_ATTRIBUTE_VALUE;
// @ts-expect-error a function is not a number
export const g: number = createWorld;
`,
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      files: ["smoke.ts"],
    })}\n`,
  );
  execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: dir,
    stdio: "inherit",
  });
  say("smoke: packed declarations type-check");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
