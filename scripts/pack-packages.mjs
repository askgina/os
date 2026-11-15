#!/usr/bin/env node
/**
 * Packs @askgina/os-keys and @askgina/os-world for another repository, from their built `dist/`.
 *
 *   bun run --filter @askgina/os-keys --filter @askgina/os-world build
 *   node scripts/pack-packages.mjs [out-dir]        # default: .packs
 *
 * Inside this monorepo both packages export their TypeScript sources, so the server, the signer,
 * the examples, their tests and their images run the sources with no build step. The published
 * shape is applied here, to a staged copy, and never to the workspace: `exports` becomes the
 * package's own `publishConfig.exports` (the built files with their types), `private`, `scripts`
 * and `devDependencies` are dropped, and `workspace:` versions become the sibling's version.
 * Declarations keep tsc's `.ts` import paths (tsc rewrites them only in JavaScript), so they are
 * rewritten to `.js` too, for consumers whose TypeScript does not resolve `.ts` paths.
 *
 * Writes one tarball per package and `packs.json` ({ name: tarball file name }) into out-dir.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, ".packs"));
const packages = ["packages/keys", "packages/world"];

const manifests = new Map(
  packages.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    return [manifest.name, { dir, manifest }];
  }),
);

function publishedVersion(name, spec) {
  const sibling = manifests.get(name);
  if (!sibling) throw new Error(`${name}: a workspace dependency that is not packed here`);
  const version = sibling.manifest.version;
  const range = spec.slice("workspace:".length);
  if (range === "*" || range === "") return version;
  if (range === "^" || range === "~") return `${range}${version}`;
  return range;
}

function publishedDependencies(dependencies) {
  if (!dependencies) return undefined;
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => [
      name,
      spec.startsWith("workspace:") ? publishedVersion(name, spec) : spec,
    ]),
  );
}

// `from "./x.ts"`, `import "./x.ts"` and `import("./x.ts")` in emitted declarations.
const RELATIVE_TS = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+)\.(m|c)?ts(["'])/g;

function rewriteDeclarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) rewriteDeclarations(path);
    else if (/\.d\.[mc]?ts$/.test(entry.name)) {
      const text = readFileSync(path, "utf8");
      writeFileSync(
        path,
        text.replace(
          RELATIVE_TS,
          (_, head, base, flavour, quote) => `${head}${base}.${flavour ?? ""}js${quote}`,
        ),
      );
    }
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const packs = {};

for (const [name, { dir, manifest }] of manifests) {
  const source = join(root, dir);
  if (!existsSync(join(source, "dist", "index.js"))) {
    throw new Error(`${name}: ${dir}/dist/index.js is missing; run its build first`);
  }
  const exportsMap = manifest.publishConfig?.exports;
  if (!exportsMap) throw new Error(`${name}: publishConfig.exports is missing`);

  const stage = join(out, "stage", name.replace("/", "__"));
  mkdirSync(stage, { recursive: true });
  for (const file of manifest.files ?? [])
    cpSync(join(source, file), join(stage, file), { recursive: true });
  for (const file of ["README.md"]) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(stage, file));
  }
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  rewriteDeclarations(join(stage, "dist"));

  for (const target of Object.values(exportsMap).flatMap((entry) => Object.values(entry))) {
    if (!existsSync(join(stage, target))) throw new Error(`${name}: ${target} was not built`);
  }

  const publishConfig = { ...manifest.publishConfig };
  delete publishConfig.exports;
  const published = {
    ...manifest,
    exports: exportsMap,
    publishConfig,
    dependencies: publishedDependencies(manifest.dependencies),
  };
  delete published.private;
  delete published.scripts;
  delete published.devDependencies;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(published, null, 2)}\n`);

  const [result] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", out], {
      cwd: stage,
      encoding: "utf8",
    }),
  );
  packs[name] = result.filename;
  process.stdout.write(`packed ${name}@${manifest.version}: ${join(out, result.filename)}\n`);
}

rmSync(join(out, "stage"), { recursive: true, force: true });
writeFileSync(join(out, "packs.json"), `${JSON.stringify(packs, null, 2)}\n`);
