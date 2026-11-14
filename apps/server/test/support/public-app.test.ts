import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiErrorBody } from "@askgina/os-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicApp } from "../../src/http/app.ts";
import { createTestContext, TEST_ORIGIN, type TestContext } from "./context.ts";

let t: TestContext;
let uiDir: string;

beforeAll(async () => {
  t = await createTestContext({ label: "public_app" });
  uiDir = mkdtempSync(join(tmpdir(), "os-public-app-ui-"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>app shell</title>");
});
afterAll(async () => {
  await t?.close();
});

// The Workflow runtime's delivery routes are unauthenticated upstream: anyone who could reach
// them could start or resume runs. They belong only on the loopback listener.
describe("the public app never serves the Workflow delivery routes", () => {
  const paths = ["/.well-known/workflow/v1/flow", "/.well-known/workflow/v1/webhook/x"];

  it.each([
    ["without the built UI", false],
    ["with the built UI", true],
  ])("%s", async (_label, withUi) => {
    const config = withUi ? { ...t.ctx.config, webDistDir: uiDir } : t.ctx.config;
    const app = createPublicApp({ ...t.ctx, config });
    for (const path of paths) {
      for (const method of ["POST", "GET"]) {
        const response = await app.fetch(
          new Request(new URL(path, TEST_ORIGIN), {
            method,
            headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
            ...(method === "POST" ? { body: "{}" } : {}),
          }),
        );
        expect(response.status, `${method} ${path}`).toBe(404);
        const body = ApiErrorBody.parse(await response.json());
        expect(body.error.code).toBe("not_found");
      }
    }
    if (withUi) {
      // The control: the same app does serve the UI shell for the UI's own routes.
      const shell = await app.fetch(new Request(new URL("/join/abc", TEST_ORIGIN)));
      expect(await shell.text()).toContain("app shell");
    }
  });
});
