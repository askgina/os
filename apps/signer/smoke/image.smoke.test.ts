import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, policyHash } from "@askgina/os-protocol";
import { createSignerClient } from "@askgina/os-protocol/signer";
import { recoverTransactionAddress } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import {
  approveIntent,
  authorize,
  basePolicy,
  Clock,
  header,
  intentFor,
  newPerson,
  RP,
  refused,
  type World,
} from "../test/harness.ts";

// Runs against a built image: SIGNER_IMAGE=<tag> bun run smoke:image
const IMAGE = process.env.SIGNER_IMAGE ?? "";
const PORT = 55702;
const NAME = `osbuild-signer-smoke-${process.pid}`;
const now = () => Math.floor(Date.now() / 1000);

describe("the signer image", () => {
  const dir = mkdtempSync(join(tmpdir(), "osbuild-signer-smoke-"));
  afterAll(() => {
    execFileSync("docker", ["rm", "-f", "-v", NAME], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts, becomes healthy, creates a wallet with the real vault and signs", async () => {
    const secret = randomBytes(32);
    writeFileSync(join(dir, "hmac"), secret.toString("base64"));
    writeFileSync(join(dir, "key"), randomBytes(32).toString("base64"));
    writeFileSync(join(dir, "passphrase"), "a long enough owner passphrase");
    // The image runs as its own unprivileged user, which must be able to read the mounted files.
    chmodSync(dir, 0o755);
    for (const file of ["hmac", "key", "passphrase"]) chmodSync(join(dir, file), 0o644);
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      NAME,
      "-p",
      `127.0.0.1:${PORT}:8787`,
      "-v",
      `${dir}:/secrets:ro`,
      "-e",
      "SIGNER_HMAC_SECRET_FILE=/secrets/hmac",
      "-e",
      "SIGNER_KEY_FILE=/secrets/key",
      "-e",
      "SIGNER_VAULT_PASSPHRASE_FILE=/secrets/passphrase",
      "-e",
      `WEBAUTHN_RP_ID=${RP.id}`,
      "-e",
      `WEBAUTHN_ORIGINS=${RP.origins.join(",")}`,
      IMAGE,
    ]);
    const deadline = Date.now() + 60_000;
    while (
      execFileSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", NAME])
        .toString()
        .trim() !== "healthy"
    ) {
      if (Date.now() > deadline) throw new Error("the container never became healthy");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const client = createSignerClient({ baseUrl: `http://127.0.0.1:${PORT}`, secret });
    const clock = new Clock();
    clock.now = now;
    clock.value = now();
    const alice = newPerson();
    const workspaceId = newId("ws");
    const walletId = newId("wal");
    const agentId = newId("agt");
    await client.createWorkspace({ workspaceId, adminThreshold: 1, approvers: [alice.credential] });
    const wallet = await client.createWallet({ workspaceId, walletId, kind: "agent", label: "w" });
    const policy = basePolicy({ workspaceId, walletId, agentId });
    await client.setPolicy(walletId, {
      policy,
      authorization: authorize(
        {
          ...header(clock, newId("apr"), workspaceId),
          type: "set-policy",
          walletId,
          policyHash: policyHash(policy),
          previousPolicyHash: null,
        },
        [alice],
      ),
    });
    const world: World = {
      t: { client, clock },
      workspaceId,
      walletId,
      agentId,
      people: [alice],
      address: wallet.address,
      policy,
    };
    const intent = intentFor(world);
    const signed = await client.sign({
      intent,
      authorization: approveIntent(world, intent),
      transaction: {
        nonce: 0,
        gas: "21000",
        maxFeePerGas: "2000000000",
        maxPriorityFeePerGas: "1000000000",
      },
    });
    const from = await recoverTransactionAddress({
      serializedTransaction: signed.signedTransaction as `0x02${string}`,
    });
    expect(from.toLowerCase()).toBe(wallet.address);
    await refused(client.getWorkspace(newId("ws")), "not_found");
    const unknown = await fetch(`http://127.0.0.1:${PORT}/v1/sign-message`, { method: "POST" });
    expect(unknown.status).toBe(404);
  });
});
