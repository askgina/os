import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Hono } from "hono";

const HTML = "text/html; charset=utf-8";

/** Content type by file extension. */
const TYPES = new Map([
  [".html", HTML],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** Paths the UI never owns: an unknown one there is a 404, not the app shell. */
const NOT_THE_UI = ["/api/", "/mcp", "/.well-known/"];

async function readRegularFile(path: string): Promise<Buffer | null> {
  const info = await stat(path).catch(() => null);

  return info?.isFile() ? readFile(path) : null;
}

/**
 * Serve the built UI. A path that names a file under `root` gets that file; any other GET gets
 * `index.html`, so the single-page app's own routes (`/join/…`, `/w/…`) load on refresh.
 */
export function serveWebApp(app: Hono, root: string): void {
  const base = resolve(root);
  app.get("*", async (c) => {
    let path: string;

    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound();
    }

    if (
      NOT_THE_UI.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))
    ) {
      return c.notFound();
    }

    const candidate = resolve(join(base, path));
    // `resolve` collapses `..`; anything that lands outside the build directory is not served.
    const inside = candidate === base || candidate.startsWith(base + sep);
    const file = inside && path !== "/" ? await readRegularFile(candidate) : null;

    if (file !== null) {
      // Vite fingerprints everything under `assets/`, so those never change under a name.
      const immutable = path.startsWith("/assets/");

      return c.body(new Uint8Array(file), 200, {
        "content-type": TYPES.get(extname(candidate)) ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }

    const shell = await readRegularFile(join(base, "index.html"));

    if (shell === null) return c.notFound();

    return c.body(new Uint8Array(shell), 200, {
      "content-type": HTML,
      "cache-control": "no-cache",
    });
  });
}
