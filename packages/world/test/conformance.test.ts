// Upstream's World conformance suite on the encrypting World. The suite decodes each run's output
// in its own test process with no key (`hydrateWorkflowReturnValue(output, runId, undefined)`),
// so every test that checks an output fails with RuntimeDecryptionError by construction: that is
// a limit of the suite, not a defect of the World. Any other failure is a defect and fails here.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LocalKeyring } from "@askgina/os-keys";
import { createTestDatabase, type TestDatabase } from "@askgina/os-testkit";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { bootstrapWorkflowSchema } from "./harness/host.ts";

const execFileAsync = promisify(execFile);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "os-world-conformance-"));

let db: TestDatabase;

/** The parts of vitest's JSON report this test reads: each test's title, status and failures. */
const VitestReport = z.object({
  testResults: z.array(
    z.object({
      assertionResults: z.array(
        z.object({ title: z.string(), status: z.string(), failureMessages: z.array(z.string()) }),
      ),
    }),
  ),
});

beforeAll(async () => {
  db = await createTestDatabase("world_conformance");
  await bootstrapWorkflowSchema(db.url);
});

afterAll(async () => {
  await db?.drop();
  rmSync(dir, { recursive: true, force: true });
});

test("upstream conformance fails only where the suite itself cannot decrypt", {
  timeout: 600_000,
}, async () => {
  const keyringFile = join(dir, "keyring.json");
  writeFileSync(keyringFile, JSON.stringify(LocalKeyring.generate("k1")), { mode: 0o600 });
  const reportFile = join(dir, "report.json");

  // `--retry=1`: the suite's servers listen on port 0, which can land on a port fetch refuses.
  const args = [
    "vitest",
    "run",
    "--config",
    "test/conformance/vitest.config.ts",
    "--retry=1",
    "--reporter=json",
    `--outputFile=${reportFile}`,
  ];

  await execFileAsync("bunx", args, {
    cwd: packageRoot,
    env: { ...process.env, WORKFLOW_POSTGRES_URL: db.url, HARNESS_KEYRING_FILE: keyringFile },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 540_000,
  }).catch((cause: unknown) => {
    // The child exits non-zero whenever any upstream test fails, which is expected; the report
    // decides. A missing report is a real failure and surfaces when it is read below.
    return cause;
  });

  const report = VitestReport.parse(JSON.parse(readFileSync(reportFile, "utf8")));

  const all = report.testResults.flatMap((file) => file.assertionResults);
  const count = (status: string) => all.filter((assertion) => assertion.status === status).length;
  const failed = all.filter((assertion) => assertion.status === "failed");

  const unexplained = failed.filter(
    (assertion) =>
      !assertion.failureMessages.every(
        (message) =>
          message.includes("RuntimeDecryptionError") &&
          message.includes("hydrateWorkflowReturnValue"),
      ),
  );

  process.stdout.write(
    `[conformance] ${JSON.stringify({
      passed: count("passed"),
      failedTestSideDecrypt: failed.length - unexplained.length,
      unexplained: unexplained.map((assertion) => assertion.title),
      skipped: count("pending") + count("skipped"),
    })}\n`,
  );
  expect(
    unexplained.map((a) => ({
      title: a.title,
      message: a.failureMessages.join("\n").slice(0, 1500),
    })),
  ).toEqual([]);
  // The upstream suite at these versions has 8 tests that do not read outputs; fewer passing
  // means something stopped running rather than started working.
  expect(count("passed")).toBeGreaterThanOrEqual(8);
});
