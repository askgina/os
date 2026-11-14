import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { newId } from "@askgina/os-protocol";
import { afterAll, describe, expect, it } from "vitest";
import {
  approveIntent,
  intentFor,
  newPerson,
  type Person,
  RP,
  setUpWorld,
  startSigner,
  txParams,
} from "./harness.ts";

const run = promisify(execFile);
const ADMIN = new URL("../src/admin.ts", import.meta.url).pathname;

describe("the admin CLI on the signer host", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-signer-admin-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "hmac"), randomBytes(32).toString("base64"));
  writeFileSync(join(dir, "key"), randomBytes(32).toString("base64"));
  writeFileSync(join(dir, "passphrase"), "a long enough owner passphrase");
  const env = {
    PATH: process.env.PATH ?? "",
    SIGNER_DATA_DIR: dir,
    SIGNER_HMAC_SECRET_FILE: join(dir, "hmac"),
    SIGNER_KEY_FILE: join(dir, "key"),
    SIGNER_VAULT_PASSPHRASE_FILE: join(dir, "passphrase"),
    WEBAUTHN_RP_ID: RP.id,
    WEBAUTHN_ORIGINS: RP.origins.join(","),
  };

  async function admin(args: string[]): Promise<{ code: number; line: Record<string, unknown> }> {
    const result = await run(process.execPath, [ADMIN, ...args], { env }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
    );
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return { code: result.code, line: JSON.parse(lines[0] ?? "") };
  }

  const enroll = (workspaceId: string, person: Person) =>
    admin([
      "enroll-approver",
      "--workspace",
      workspaceId,
      "--user",
      person.userId,
      "--credential-id",
      person.credential.credentialId,
      "--public-key",
      person.credential.publicKey,
    ]);

  it("enrolls exactly the key the operator typed, once, and records it", async () => {
    const sqlitePath = join(dir, "signer.sqlite");
    // The running signer and the CLI share the SQLite file, as on a real host.
    const t = startSigner({ sqlitePath });
    const world = await setUpWorld(t);
    const replacement = newPerson();

    expect(await enroll(newId("ws"), replacement)).toEqual({
      code: 2,
      line: { ok: false, code: "not_found" },
    });
    expect(await enroll(world.workspaceId, replacement)).toEqual({
      code: 0,
      line: {
        ok: true,
        action: "enroll-approver-by-operator",
        workspaceId: world.workspaceId,
        userId: replacement.userId,
        credentialId: replacement.credential.credentialId,
      },
    });
    expect(await enroll(world.workspaceId, replacement)).toEqual({
      code: 2,
      line: { ok: false, code: "conflict" },
    });

    const { decisions } = await t.client.listDecisions(world.workspaceId);
    expect(decisions.filter((d) => d.action === "enroll-approver-by-operator")).toHaveLength(1);
    // The enrolled key approves on its own.
    const intent = intentFor(world);
    const signed = await t.client.sign({
      intent,
      authorization: approveIntent(world, intent, { people: [replacement] }),
      transaction: txParams(),
    });
    expect(signed.from).toBe(world.address);
    t.signer.close();

    expect(await admin(["verify-log", "--workspace", world.workspaceId])).toEqual({
      code: 0,
      line: { ok: true, workspaceId: world.workspaceId, brokenAt: null },
    });
  });

  it("refuses a malformed key without touching the database", async () => {
    const result = await admin([
      "enroll-approver",
      "--workspace",
      newId("ws"),
      "--user",
      newId("usr"),
      "--credential-id",
      "not base64url!",
      "--public-key",
      "x",
    ]);
    expect(result).toEqual({ code: 2, line: { ok: false, code: "usage" } });
  });
});
