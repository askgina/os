import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Address,
  type DeleteWorkspaceEnvelope,
  mandateHash,
  newId,
  policyHash,
  type RetireWalletEnvelope,
  type Sweep,
  sweepHash,
  type WalletId,
  type WalletRef,
} from "@askgina/os-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestVault, SCHEMA_VERSION, type Vault, VaultError } from "../src/index.ts";
import {
  approveIntent,
  authorize,
  CHAIN,
  Clock,
  DROP_VERSION_7,
  ETH,
  grantMandate,
  header,
  intentFor,
  mandateFor,
  newPerson,
  RECIPIENT,
  refused,
  replacePolicy,
  setUpWorld,
  startSigner,
  type TestSigner,
  tokenIntent,
  txParams,
  useRequest,
  type World,
} from "./harness.ts";

const WEEK = 604_800;

/** A `SELECT COUNT(*) AS n` row. */
const CountRow = z.object({ n: z.number() });

/** The row `PRAGMA user_version` returns. */
const UserVersion = z.object({ user_version: z.number() });

function retireEnvelope(
  world: World,
  changes: Partial<RetireWalletEnvelope> = {},
): RetireWalletEnvelope {
  return {
    ...header(world.t.clock, newId("apr"), world.workspaceId),
    type: "retire-wallet",
    wallet: { walletId: world.walletId, address: world.address },
    destroyAfter: world.t.clock.value + WEEK,
    ...changes,
  };
}

function retire(world: World, changes: Partial<RetireWalletEnvelope> = {}) {
  return world.t.client.retireWallet(
    world.walletId,
    authorize(retireEnvelope(world, changes), world.people),
  );
}

/** The workspace's wallets as a deletion names them: by id. */
async function walletRefs(world: World, walletIds: readonly WalletId[]): Promise<WalletRef[]> {
  const refs = await Promise.all(
    walletIds.map(async (walletId) => {
      const state = await world.t.client.getWallet(walletId);

      return { walletId, address: state.address };
    }),
  );

  return refs.sort((a, b) => (a.walletId < b.walletId ? -1 : 1));
}

function deleteEnvelope(
  world: World,
  wallets: WalletRef[],
  changes: Partial<DeleteWorkspaceEnvelope> = {},
): DeleteWorkspaceEnvelope {
  return {
    ...header(world.t.clock, newId("apr"), world.workspaceId),
    type: "delete-workspace",
    wallets,
    destroyAfter: world.t.clock.value + WEEK,
    ...changes,
  };
}

async function pay(world: World) {
  const intent = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "1" });

  return world.t.client.sign({
    intent,
    authorization: approveIntent(world, intent),
    transaction: txParams(),
  });
}

async function sweep(world: World, to: Address) {
  const swept: Sweep = {
    v: 1,
    workspaceId: world.workspaceId,
    walletId: world.walletId,
    chainId: CHAIN,
    asset: "native",
    amount: String(ETH),
    to,
    maxFeeWei: String(10n ** 15n),
  };

  return world.t.client.sweep(world.walletId, {
    sweep: swept,
    authorization: authorize(
      {
        ...header(world.t.clock, newId("apr"), world.workspaceId),
        type: "sweep-wallet",
        walletId: world.walletId,
        chainId: CHAIN,
        sweepHash: sweepHash(swept),
      },
      world.people,
    ),
    transaction: txParams(),
  });
}

/** What the decision log records as allowed, in order; refusals are logged too. */
async function actions(world: World): Promise<string[]> {
  const { decisions } = await world.t.client.listDecisions(world.workspaceId, { limit: 1000 });

  return decisions
    .filter((decision) => decision.outcome === "allowed")
    .map((decision) => decision.action);
}

/** Can the vault still sign for the wallet? */
function vaultHolds(t: TestSigner, walletId: WalletId): boolean {
  try {
    t.vault.signEvmTransaction(walletId, "test_wrong", {
      chainId: 31337,
      nonce: 0,
      to: RECIPIENT,
      gas: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    });

    return true;
  } catch (error) {
    return !(error instanceof VaultError && error.reason === "wallet_missing");
  }
}

describe("retiring a wallet", () => {
  it("stops signing, revokes the wallet's live mandates only, and destroys the key after the delay", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);

    const treasury = await t.client.createWallet({
      workspaceId: world.workspaceId,
      walletId: newId("wal"),
      kind: "treasury",
      label: "treasury",
    });

    const { mandate } = await grantMandate(world);
    const signed = await pay(world);

    const retiring = await retire(world);
    expect([retiring.state, retiring.destroyAfter]).toEqual(["retiring", t.clock.value + WEEK]);
    expect(await t.client.getMandate(mandate.id)).toMatchObject({
      status: "revoked",
      revokedReason: "requested",
    });
    await refused(pay(world), "wallet_retired");
    await refused(sweep(world, treasury.address), "wallet_retired");
    await refused(
      t.client.signUnderMandate(mandate.id, useRequest(tokenIntent(world, 1n))),
      "wallet_retired",
    );
    await refused(t.client.grantMandate(...grantArgs(world)), "wallet_retired");
    // A retiring wallet cannot be retired again, nor given a policy.
    await refused(retire(world), "wallet_retired");
    await refused(replacePolicy(world, {}), "wallet_retired");

    await refused(
      t.client.finalizeRetireWallet(world.walletId, world.workspaceId),
      "destroy_not_due",
    );
    t.clock.value += WEEK;
    expect(vaultHolds(t, world.walletId)).toBe(true);
    const destroyed = await t.client.finalizeRetireWallet(world.walletId, world.workspaceId);
    expect([destroyed.state, destroyed.destroyAfter]).toEqual(["destroyed", retiring.destroyAfter]);
    expect(vaultHolds(t, world.walletId)).toBe(false);
    expect(await t.client.finalizeRetireWallet(world.walletId, world.workspaceId)).toEqual(
      destroyed,
    );
    // The signed transaction is emptied: its hash is kept, its bytes are not handed out again.
    expect(await t.client.getApproval(signed.approvalId)).toMatchObject({
      state: "signed",
      transactionHash: signed.transactionHash,
      attempts: [],
    });
    await refused(t.client.cancelRetireWallet(world.walletId, world.workspaceId), "conflict");
    const log = await actions(world);
    expect(log).toContain("revoke-mandate-on-retire");
    expect(log.filter((action) => action === "destroy-wallet")).toHaveLength(1);
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: true, brokenAt: null });
  });

  it("cancelling keeps the key as held: it signs nothing until a new policy, and the mandate stays revoked", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const { mandate } = await grantMandate(world);
    await retire(world);
    const held = await t.client.cancelRetireWallet(world.walletId, world.workspaceId);
    expect([held.state, held.destroyAfter]).toEqual(["held", null]);
    await refused(t.client.cancelRetireWallet(world.walletId, world.workspaceId), "conflict");
    await refused(pay(world), "wallet_retired");
    await refused(t.client.finalizeRetireWallet(world.walletId, world.workspaceId), "conflict");

    world.policy = await replacePolicy(world, {});
    expect((await t.client.getWallet(world.walletId)).state).toBe("active");
    expect((await pay(world)).from).toBe(world.address);
    expect((await t.client.getMandate(mandate.id)).status).toBe("revoked");
  });

  it("refuses another wallet's address, a delay outside the bounds, and a fenced envelope", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    await refused(
      retire(world, { wallet: { walletId: world.walletId, address: `0x${"11".repeat(20)}` } }),
      "envelope_mismatch",
    );
    await refused(
      retire(world, { destroyAfter: t.clock.value + WEEK - 1 }),
      "destroy_delay_out_of_range",
    );
    await refused(
      retire(world, { destroyAfter: t.clock.value + 7_776_001 }),
      "destroy_delay_out_of_range",
    );
    const early = retireEnvelope(world);
    t.signer.fence();
    t.clock.value += 600;
    await refused(
      t.client.retireWallet(world.walletId, authorize(early, world.people)),
      "envelope_fenced",
    );
    expect((await t.client.getWallet(world.walletId)).state).toBe("active");
  });

  it("a key store that fails or crashes mid-destroy leaves the wallet retiring, and the next finalize completes", async () => {
    const honest = createTestVault();
    const faults = { before: 1, after: 1 };

    const vault: Vault = {
      createWallet: (walletId) => honest.createWallet(walletId),
      signEvmTransaction: (...args) => honest.signEvmTransaction(...args),
      signHyperliquid: (...args) => honest.signHyperliquid(...args),
      destroyWallet: (walletId) => {
        if (faults.before > 0) {
          faults.before -= 1;
          throw new VaultError("failed", "the disk is full");
        }

        honest.destroyWallet(walletId);

        // Deleted from the key store, then the process dies before the database commits.
        if (faults.after > 0) {
          faults.after -= 1;
          throw new VaultError("failed", "killed");
        }
      },
    };

    const t = startSigner({ vault });
    const world = await setUpWorld(t);
    const signed = await pay(world);
    await retire(world);
    t.clock.value += WEEK;

    for (let failure = 0; failure < 2; failure += 1) {
      await refused(
        t.client.finalizeRetireWallet(world.walletId, world.workspaceId),
        "vault_error",
      );
      expect((await t.client.getWallet(world.walletId)).state).toBe("retiring");
      expect((await t.client.getApproval(signed.approvalId)).attempts).toHaveLength(1);
    }

    expect((await t.client.finalizeRetireWallet(world.walletId, world.workspaceId)).state).toBe(
      "destroyed",
    );
    expect((await t.client.getApproval(signed.approvalId)).attempts).toEqual([]);
  });
});

function grantArgs(world: World) {
  const mandate = mandateFor(world);

  return [
    mandate.id,
    {
      mandate,
      authorization: authorize(
        {
          ...header(world.t.clock, newId("apr"), world.workspaceId),
          type: "grant-mandate",
          mandateId: mandate.id,
          walletId: mandate.walletId,
          agentId: mandate.agentId,
          mandateHash: mandateHash(mandate),
        },
        world.people,
      ),
    },
  ] as const;
}

describe("deleting a workspace", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("names exactly the signer's wallets, within the delay bounds and the restore fence", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);

    const second = await t.client.createWallet({
      workspaceId: world.workspaceId,
      walletId: newId("wal"),
      kind: "treasury",
      label: "treasury",
    });

    const both = await walletRefs(world, [world.walletId, second.walletId]);

    const remove = (envelope: DeleteWorkspaceEnvelope) =>
      t.client.deleteWorkspace(world.workspaceId, authorize(envelope, world.people));

    await refused(remove(deleteEnvelope(world, both.slice(0, 1))), "wallet_set_mismatch");
    const stranger = { walletId: newId("wal"), address: `0x${"22".repeat(20)}` as const };
    await refused(
      remove(
        deleteEnvelope(
          world,
          [...both, stranger].sort((a, b) => (a.walletId < b.walletId ? -1 : 1)),
        ),
      ),
      "wallet_set_mismatch",
    );
    await refused(
      remove(deleteEnvelope(world, both, { destroyAfter: t.clock.value + WEEK - 1 })),
      "destroy_delay_out_of_range",
    );
    const early = deleteEnvelope(world, both);
    t.signer.fence();
    t.clock.value += 600;
    await refused(remove(early), "envelope_fenced");
    expect((await t.client.getWorkspace(world.workspaceId)).state).toBe("active");
  });

  it("pauses and stops every change while it waits; cancelling puts each wallet back and stays paused", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);

    const heldWallet = await t.client.createWallet({
      workspaceId: world.workspaceId,
      walletId: newId("wal"),
      kind: "treasury",
      label: "held",
    });

    const heldWorld = { ...world, walletId: heldWallet.walletId, address: heldWallet.address };
    await retire(heldWorld);
    await t.client.cancelRetireWallet(heldWallet.walletId, world.workspaceId);
    const { mandate } = await grantMandate(world);

    const refs = await walletRefs(world, [world.walletId, heldWallet.walletId]);
    const envelope = deleteEnvelope(world, refs);

    const deleting = await t.client.deleteWorkspace(
      world.workspaceId,
      authorize(envelope, world.people),
    );

    expect([deleting.state, deleting.paused, deleting.destroyAfter]).toEqual([
      "deleting",
      true,
      envelope.destroyAfter,
    ]);
    // A repeat of the same envelope returns the state.
    expect(
      await t.client.deleteWorkspace(world.workspaceId, authorize(envelope, world.people)),
    ).toEqual(deleting);
    expect((await t.client.getWallet(heldWallet.walletId)).state).toBe("retiring");
    expect((await t.client.getMandate(mandate.id)).revokedReason).toBe("requested");

    const newcomer = newPerson();
    await refused(
      t.client.addApprover(world.workspaceId, {
        authorization: authorize(
          {
            ...header(t.clock, newId("apr"), world.workspaceId),
            type: "add-approver",
            ...newcomer.credential,
          },
          world.people,
        ),
      }),
      "workspace_deleting",
    );
    await refused(replacePolicy(world, {}), "workspace_deleting");
    await refused(t.client.grantMandate(...grantArgs(world)), "workspace_deleting");
    await refused(
      t.client.resumeWorkspace(
        world.workspaceId,
        authorize(
          { ...header(t.clock, newId("apr"), world.workspaceId), type: "resume-workspace" },
          world.people,
        ),
      ),
      "workspace_deleting",
    );
    await refused(
      t.client.createWallet({
        workspaceId: world.workspaceId,
        walletId: newId("wal"),
        kind: "agent",
        label: "late",
      }),
      "workspace_deleting",
    );
    await refused(pay(world), "workspace_deleting");
    await refused(
      t.client.cancelRetireWallet(world.walletId, world.workspaceId),
      "workspace_deleting",
    );
    await refused(t.client.finalizeDeleteWorkspace(world.workspaceId), "destroy_not_due");

    const cancelled = await t.client.cancelDeleteWorkspace(world.workspaceId);
    expect([cancelled.state, cancelled.paused, cancelled.destroyAfter]).toEqual([
      "active",
      true,
      null,
    ]);
    await refused(t.client.cancelDeleteWorkspace(world.workspaceId), "conflict");
    expect((await t.client.getWallet(world.walletId)).state).toBe("active");
    // A held wallet is still held: cancelling a deletion never lets it sign without a new policy.
    expect((await t.client.getWallet(heldWallet.walletId)).state).toBe("held");
    expect((await t.client.getMandate(mandate.id)).status).toBe("revoked");
    await refused(pay(world), "workspace_paused");
  });

  it("after finalize the workspace keeps only its state, its log and its used ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-signer-lifecycle-"));
    dirs.push(dir);
    const sqlitePath = join(dir, "signer.sqlite");
    const t = startSigner({ sqlitePath });
    const world = await setUpWorld(t);
    const { mandate } = await grantMandate(world);
    const signed = await pay(world);
    // An open confirmation of another kind, superseded once the deletion applies.
    const intent = intentFor(world);
    const pending = approveIntent(world, intent, { people: [] }).envelope;

    const { path } = await t.client.openConfirmation(pending.approvalId, {
      envelope: pending,
      subject: { kind: "approve-intent", intent },
    });

    const token = path.slice(path.indexOf("#") + 1);

    const envelope = deleteEnvelope(world, await walletRefs(world, [world.walletId]));
    await t.client.deleteWorkspace(world.workspaceId, authorize(envelope, world.people));
    expect((await t.confirm.getConfirmation(pending.approvalId, token)).state).toBe("superseded");
    t.clock.value = envelope.destroyAfter;
    const deleted = await t.client.finalizeDeleteWorkspace(world.workspaceId);
    expect([deleted.state, deleted.paused, deleted.approvers]).toEqual(["deleted", true, []]);
    expect(await t.client.finalizeDeleteWorkspace(world.workspaceId)).toEqual(deleted);
    expect(
      await t.client.deleteWorkspace(world.workspaceId, authorize(envelope, world.people)),
    ).toEqual(deleted);
    expect(vaultHolds(t, world.walletId)).toBe(false);

    // Each call is made only when awaited, so no refusal goes unhandled meanwhile.
    for (const call of [
      () => t.client.getWallet(world.walletId),
      () => t.client.getMandate(mandate.id),
      () => t.client.listMandates(world.walletId),
      () => t.client.getApproval(signed.approvalId),
      () => t.client.pauseWorkspace(world.workspaceId),
      () => t.client.cancelDeleteWorkspace(world.workspaceId),
      () => t.client.revokeApproval(newId("apr"), world.workspaceId),
      () => t.client.revokeMandate(mandate.id, world.workspaceId),
      () => t.client.cancelRetireWallet(world.walletId, world.workspaceId),
      () => pay(world),
      () => replacePolicy(world, {}),
    ]) {
      await refused(call(), "workspace_deleted");
    }

    await refused(t.confirm.getConfirmation(pending.approvalId, token), "not_found");
    await refused(
      t.client.createWorkspace({
        workspaceId: world.workspaceId,
        adminThreshold: 1,
        approvers: world.people.map((person) => person.credential),
      }),
      "conflict",
    );
    // Its envelope nonces stay used for good, in every workspace.
    const fresh = await setUpWorld(t);

    const reused = deleteEnvelope(fresh, await walletRefs(fresh, [fresh.walletId]), {
      nonce: envelope.nonce,
    });

    await refused(
      t.client.deleteWorkspace(fresh.workspaceId, authorize(reused, fresh.people)),
      "nonce_reused",
    );
    expect((await actions(world)).slice(-2)).toEqual(["destroy-wallet", "delete-workspace"]);
    expect(t.signer.verifyDecisionLog(world.workspaceId)).toEqual({ ok: true, brokenAt: null });
    t.signer.close();

    const db = new DatabaseSync(sqlitePath);
    const count = (sql: string) => CountRow.parse(db.prepare(sql).get(world.workspaceId)).n;
    expect(count("SELECT COUNT(*) AS n FROM confirmations WHERE workspace_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM approvers WHERE workspace_id = ?")).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM mandates WHERE workspace_id = ? AND mandate <> ''"),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM mandates WHERE workspace_id = ?")).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM signatures s JOIN wallets w ON w.wallet_id = s.wallet_id WHERE w.workspace_id = ? AND (s.signed_transaction <> '' OR length(w.sealed_credential) > 0)",
      ),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM used_nonces WHERE workspace_id = ?")).toBeGreaterThan(
      0,
    );
    db.close();
  });
});

describe("the database's schema version 7", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("a version 6 file gains the lifecycle columns, keeps its rows and log head, and retires a wallet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os-signer-lifecycle-"));
    dirs.push(dir);
    const sqlitePath = join(dir, "signer.sqlite");

    const host = {
      sqlitePath,
      clock: new Clock(),
      vault: createTestVault(),
      tokenKey: randomBytes(32),
    };

    let t = startSigner(host);
    const world = await setUpWorld(t);
    const signed = await pay(world);
    const before = await t.client.listDecisions(world.workspaceId);
    t.signer.close();

    // What a signer at version 6 left behind.
    const old = new DatabaseSync(sqlitePath);
    old.exec(`${DROP_VERSION_7} PRAGMA user_version = 6;`);
    old.close();

    t = startSigner(host);
    const upgraded: World = { ...world, t };
    expect(await t.client.getWorkspace(world.workspaceId)).toMatchObject({
      state: "active",
      destroyAfter: null,
      minDestroyDelaySeconds: WEEK,
    });
    const wallet = await t.client.getWallet(world.walletId);
    expect([wallet.state, wallet.destroyAfter, wallet.policy]).toEqual([
      "active",
      null,
      world.policy,
    ]);
    expect((await t.client.getApproval(signed.approvalId)).transactionHash).toBe(
      signed.transactionHash,
    );
    const after = await t.client.listDecisions(world.workspaceId);
    // The file was not replaced, so it is not fenced: the log continues from the same head.
    expect(after.decisions.slice(0, before.decisions.length)).toEqual(before.decisions);
    expect((await retire(upgraded)).state).toBe("retiring");
    t.signer.close();

    const db = new DatabaseSync(sqlitePath);
    const { user_version } = UserVersion.parse(db.prepare("PRAGMA user_version").get());
    db.close();
    expect([SCHEMA_VERSION, user_version]).toEqual([8, 8]);
  });

  it("a retirement needs at least the configured minimum delay", async () => {
    const t = startSigner({ minDestroyDelaySeconds: 60 });
    const world = await setUpWorld(t);
    expect((await t.client.getWorkspace(world.workspaceId)).minDestroyDelaySeconds).toBe(60);
    await refused(
      retire(world, { destroyAfter: t.clock.value + 59 }),
      "destroy_delay_out_of_range",
    );
    expect((await retire(world, { destroyAfter: t.clock.value + 60 })).state).toBe("retiring");
    expect(policyHash(world.policy)).toBe((await t.client.getWallet(world.walletId)).policyHash);
  });
});
