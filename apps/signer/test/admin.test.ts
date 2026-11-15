import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { newId } from "@askgina/os-protocol";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { OwsVault } from "../src/index.ts";
import {
  approveIntent,
  authorize,
  confirmationEnvironment,
  grantMandate,
  header,
  intentFor,
  newPerson,
  type Person,
  RP_ID,
  refused,
  setUpWorld,
  startSigner,
  tokenIntent,
  txParams,
  useRequest,
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
    WEBAUTHN_RP_ID: RP_ID,
    ...confirmationEnvironment(dir),
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
      // Attached with "=": a base64url value may start with "-".
      `--credential-id=${person.credential.credentialId}`,
      `--public-key=${person.credential.publicKey}`,
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

  it("takes a credential id and a key that start with a dash, as one in 64 base64url values do", async () => {
    startSigner({ sqlitePath: join(dir, "signer.sqlite") });
    const person = newPerson();
    const result = await admin([
      "enroll-approver",
      "--workspace",
      newId("ws"),
      "--user",
      person.userId,
      `--credential-id=-${person.credential.credentialId.slice(1)}`,
      `--public-key=${person.credential.publicKey}`,
    ]);
    // Read as a value, so the answer is about the workspace, not about how to call the command.
    expect(result).toEqual({ code: 2, line: { ok: false, code: "not_found" } });
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

  it("lists a workspace's mandates, and revokes one or every live one as the operator", async () => {
    const t = startSigner({ sqlitePath: join(dir, "signer.sqlite") });
    // The CLI runs on the host's clock: grant on it too, so the mandates are live for both.
    t.clock.value = Math.floor(Date.now() / 1000);
    const world = await setUpWorld(t);
    const granted = [
      await grantMandate(world),
      await grantMandate(world),
      await grantMandate(world),
    ];
    const [one, ...rest] = granted.map(({ mandate }) => mandate);
    if (one === undefined) throw new Error("three mandates were granted");

    expect(await admin(["list-mandates", "--workspace", world.workspaceId])).toEqual({
      code: 0,
      line: {
        ok: true,
        workspaceId: world.workspaceId,
        mandates: granted
          .map(({ mandate, state }) => ({
            mandateId: mandate.id,
            walletId: world.walletId,
            agentId: world.agentId,
            status: "active",
            notBefore: mandate.notBefore,
            notAfter: mandate.notAfter,
            grantedAt: state.grantedAt,
            revokedAt: null,
            revokedReason: null,
            uses: 0,
            maxUses: mandate.maxUses,
          }))
          .sort((a, b) => (a.mandateId < b.mandateId ? -1 : 1)),
      },
    });

    expect(await admin(["revoke-mandate", "--mandate", one.id])).toEqual({
      code: 0,
      line: { ok: true, action: "revoke-mandate-by-operator", revoked: [one.id] },
    });
    expect(await admin(["revoke-mandate", "--mandate", one.id])).toEqual({
      code: 0,
      line: { ok: true, action: "revoke-mandate-by-operator", revoked: [] },
    });
    expect(await admin(["revoke-mandate", "--mandate", newId("mnd")])).toEqual({
      code: 2,
      line: { ok: false, code: "not_found" },
    });
    expect(await admin(["revoke-mandate", "--all", "--workspace", world.workspaceId])).toEqual({
      code: 0,
      line: {
        ok: true,
        action: "revoke-mandate-by-operator",
        workspaceId: world.workspaceId,
        revoked: rest.map((mandate) => mandate.id).sort(),
      },
    });
    for (const args of [
      ["revoke-mandate"],
      ["revoke-mandate", "--all"],
      ["revoke-mandate", "--mandate", one.id, "--all", "--workspace", world.workspaceId],
      ["revoke-mandate", "--mandate", one.id, "--workspace", world.workspaceId],
      ["list-mandates"],
    ]) {
      expect(await admin(args), args.join(" ")).toEqual({
        code: 2,
        line: { ok: false, code: "usage" },
      });
    }

    // The running signer sees the revocations at once.
    expect(await t.client.getMandate(one.id)).toMatchObject({
      status: "revoked",
      revokedReason: "operator",
    });
    await refused(
      t.client.signUnderMandate(one.id, useRequest(tokenIntent(world, 1n))),
      "mandate_revoked",
    );
    const { decisions } = await t.client.listDecisions(world.workspaceId);
    expect(decisions.filter((d) => d.action === "revoke-mandate-by-operator")).toHaveLength(3);
    t.signer.close();
  });

  it("exports a wallet's mnemonic to a new 0600 file, logs it, and refuses an existing file and a destroyed wallet", async () => {
    const vault = new OwsVault({
      vaultPath: join(dir, "vault"),
      passphraseFile: join(dir, "passphrase"),
    });
    const t = startSigner({
      sqlitePath: join(dir, "signer.sqlite"),
      vault,
      minDestroyDelaySeconds: 60,
    });
    t.clock.value = Math.floor(Date.now() / 1000);
    const world = await setUpWorld(t);
    const out = join(dir, "export.txt");
    const exportWallet = () =>
      admin([
        "export-wallet",
        "--workspace",
        world.workspaceId,
        "--wallet",
        world.walletId,
        "--out",
        out,
      ]);

    expect(await exportWallet()).toEqual({
      code: 0,
      line: {
        ok: true,
        action: "export-wallet-by-operator",
        workspaceId: world.workspaceId,
        walletId: world.walletId,
        address: world.address,
        out,
      },
    });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const mnemonic = readFileSync(out, "utf8").trim();
    expect(mnemonicToAccount(mnemonic).address.toLowerCase()).toBe(world.address);
    expect(await exportWallet()).toEqual({ code: 2, line: { ok: false, code: "out_exists" } });
    const { decisions } = await t.client.listDecisions(world.workspaceId);
    expect(decisions.filter((d) => d.action === "export-wallet-by-operator")).toHaveLength(1);

    rmSync(out);
    await t.client.retireWallet(
      world.walletId,
      authorize(
        {
          ...header(t.clock, newId("apr"), world.workspaceId),
          type: "retire-wallet",
          wallet: { walletId: world.walletId, address: world.address as `0x${string}` },
          destroyAfter: t.clock.value + 60,
        },
        world.people,
      ),
    );
    t.clock.value += 60;
    await t.client.finalizeRetireWallet(world.walletId, world.workspaceId);
    expect(await exportWallet()).toEqual({ code: 2, line: { ok: false, code: "wallet_retired" } });
    t.signer.close();
  });

  it("sets the restore fence for every workspace, and the running signer refuses what came before", async () => {
    const t = startSigner({ sqlitePath: join(dir, "signer.sqlite") });
    const world = await setUpWorld(t);
    const before = Math.floor(Date.now() / 1000);
    const result = await admin(["fence"]);
    expect(result).toMatchObject({ code: 0, line: { ok: true, action: "fence-set-by-operator" } });
    const fenceAt = Number(result.line.fenceAt);
    expect(fenceAt).toBeGreaterThanOrEqual(before);

    const { decisions } = await t.client.listDecisions(world.workspaceId);
    expect(decisions.at(-1)).toMatchObject({ action: "fence-set-by-operator", at: fenceAt });

    // The CLI runs on the host's clock; move the test clock to either side of its fence.
    t.clock.value = fenceAt - 60;
    const stale = intentFor(world);
    await refused(
      t.client.sign({
        intent: stale,
        authorization: approveIntent(world, stale),
        transaction: txParams(),
      }),
      "envelope_fenced",
    );
    t.clock.value = fenceAt + 60;
    const fresh = intentFor(world);
    const signed = await t.client.sign({
      intent: fresh,
      authorization: approveIntent(world, fresh),
      transaction: txParams(),
    });
    expect(signed.from).toBe(world.address);
    t.signer.close();
  });
});
