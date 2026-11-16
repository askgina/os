import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const harness = fileURLToPath(new URL("./harness/", import.meta.url));

const cli = fileURLToPath(new URL("../node_modules/.bin/workflow", import.meta.url));

/**
 * Build the proof host's workflows with the SDK's standalone builder once per test run. The
 * output (`test/harness/.well-known/`) is generated and ignored by git.
 */
export default async function setup(): Promise<void> {
  await execFileAsync(cli, ["build"], { cwd: harness, timeout: 180_000 });
}
