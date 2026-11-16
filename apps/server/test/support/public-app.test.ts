import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiErrorBody } from "@askgina/os-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineOf } from "../../src/execution/approvals.ts";
import { workflowRuntime } from "../../src/execution/workflow-runtime.ts";
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

describe("readiness", () => {
  const ready = async (ctx = t.ctx) => {
    const response = await createPublicApp(ctx).fetch(new Request(new URL("/readyz", TEST_ORIGIN)));

    return { status: response.status, body: await response.json() };
  };

  it("is ready only while the World delivers runs and the database answers; health stays up", async () => {
    // The test context never starts the World.
    expect(await ready()).toEqual({ status: 503, body: { ok: false } });
    const engine = engineOf(t.ctx);
    engine.attachRuntime(workflowRuntime(t.ctx));

    try {
      expect(await ready()).toEqual({ status: 200, body: { ok: true } });
      const down = { ...t.ctx, db: { execute: () => Promise.reject(new Error("down")) } as never };
      expect(await ready(down)).toEqual({ status: 503, body: { ok: false } });
    } finally {
      engine.attachRuntime(null);
    }

    const health = await createPublicApp(t.ctx).fetch(
      new Request(new URL("/healthz", TEST_ORIGIN)),
    );

    expect(health.status).toBe(200);
  });
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
