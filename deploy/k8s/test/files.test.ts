// The Kubernetes manifests carry copies of files Compose reads from deploy/, because Kustomize
// reads nothing outside its own directory. These tests fail when a copy drifts from its source,
// and when a manifest pins an image Compose does not.
//   node --test deploy/k8s/test/files.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const K8S = join(ROOT, "deploy", "k8s");

const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), "utf8");

/**
 * The top-level blocks of a Caddyfile, each with the comment lines above it: the global options
 * first, then each site. A blank line outside every brace ends a block.
 */
function blocks(caddyfile: string): string[] {
  const found: string[] = [];
  let current: string[] = [];
  let depth = 0;

  for (const line of caddyfile.split("\n")) {
    if (depth === 0 && line.trim() === "") {
      if (current.length > 0) found.push(current.join("\n"));
      current = [];
      continue;
    }

    current.push(line);

    // `{$NAME:default}` is a placeholder, not a block.
    for (const char of line.replace(/\{\$[^}]*\}/g, "")) {
      if (char === "{") depth += 1;

      if (char === "}") depth -= 1;
    }
  }

  if (current.length > 0) found.push(current.join("\n"));
  assert.equal(depth, 0, "unbalanced braces");

  return found;
}

test("the edge's Caddyfile is the global options and the PUBLIC_ORIGIN site of deploy/Caddyfile", () => {
  const [global, site] = blocks(read("deploy", "Caddyfile"));
  assert.ok(site?.includes("{$SITE_ADDRESS:"));
  assert.equal(read("deploy", "k8s", "base", "files", "Caddyfile"), `${global}\n\n${site}\n`);
});

test("the confirmation page's edge has the global options and the APPROVE_ORIGIN site", () => {
  const [global, , site] = blocks(read("deploy", "Caddyfile"));
  assert.ok(site?.includes("{$APPROVE_SITE_ADDRESS:"));
  assert.equal(
    read("deploy", "k8s", "components", "signer-in-cluster", "files", "Caddyfile.approve"),
    `${global}\n\n${site}\n`,
  );
});

test("the gateway's Caddyfile, the chains and the assets are copied byte for byte", () => {
  const copies: [string[], string[]][] = [
    [
      ["deploy", "Caddyfile.agents"],
      ["deploy", "k8s", "base", "files", "Caddyfile.agents"],
    ],
    [
      ["deploy", "chains.json"],
      ["deploy", "k8s", "base", "files", "chains.json"],
    ],
    [
      ["deploy", "chains.json"],
      ["deploy", "k8s", "components", "signer-in-cluster", "files", "chains.json"],
    ],
    [
      ["deploy", "assets.json"],
      ["deploy", "k8s", "components", "signer-in-cluster", "files", "assets.json"],
    ],
  ];

  for (const [source, copy] of copies) {
    assert.equal(read(...copy), read(...source), `${copy.join("/")} differs from its source`);
  }
});

test("every image a manifest pins by digest is one compose.yaml pins", () => {
  const compose = read("compose.yaml");

  const manifests = readdirSync(K8S, { recursive: true, encoding: "utf8" }).filter((path) =>
    path.endsWith(".yaml"),
  );

  let pinned = 0;

  for (const path of manifests) {
    for (const [, image] of read("deploy", "k8s", path).matchAll(
      /image: (\S+@sha256:[0-9a-f]{64})/g,
    )) {
      pinned += 1;
      assert.ok(
        compose.includes(`image: ${image}`),
        `${relative(ROOT, join(K8S, path))} pins ${image}, which compose.yaml does not`,
      );
    }
  }

  assert.ok(pinned > 0, "no pinned image found");
});
