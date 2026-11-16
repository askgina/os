import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId } from "@askgina/os-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { createTestVault, SCHEMA_VERSION, SchemaTooNewError } from "../src/index.ts";
import {
  approveIntent,
  authorize,
  Clock,
  DROP_VERSION_7,
  header,
  intentFor,
  refused,
  setUpWorld,
  startSigner,
  type TestSigner,
  txParams,
  type World,
} from "./harness.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * One signer host: a SQLite file, a vault and a token key that outlive restarts, and the
 * operator's backup copy of the file.
 */
function signerHost() {
  const dir = mkdtempSync(join(tmpdir(), "os-signer-fence-"));
  dirs.push(dir);
  const sqlitePath = join(dir, "signer.sqlite");
  const backupPath = join(dir, "backup.sqlite");
  const clock = new Clock();
  const vault = createTestVault();
  const tokenKey = new Uint8Array(randomBytes(32));
  let running: TestSigner | null = startSigner({ sqlitePath, clock, vault, tokenKey });
  const sidecars = [`${sqlitePath}-wal`, `${sqlitePath}-shm`];

  const host = {
    sqlitePath,
    clock,
    get t(): TestSigner {
      if (!running) throw new Error("the signer is stopped");

      return running;
    },
    stop() {
      running?.signer.close();
      running = null;
      // Closing the last connection checkpoints the log into the file: the file is the backup.
      expect(existsSync(sidecars[0] ?? "")).toBe(false);
    },
    start(): TestSigner {
      running = startSigner({ sqlitePath, clock, vault, tokenKey });

      return running;
    },
    /** With the signer stopped, as the deploy guide says. */
    backUp() {
      host.stop();
      copyFileSync(sqlitePath, backupPath);

      return host.start();
    },
    /** Put the backup's bytes into the same file, as rolling back a disk snapshot does. */
    restoreInPlace() {
      host.stop();
      writeFileSync(sqlitePath, readFileSync(backupPath));

      return host.start();
    },
    /** Put the backup back as a new file, as extracting an archive or copying a volume does. */
    restoreAsNewFile() {
      host.stop();

      for (const path of [sqlitePath, ...sidecars]) rmSync(path, { force: true });
      copyFileSync(backupPath, sqlitePath);

      return host.start();
    },
  };

  return host;
}

const on = (world: World, t: TestSigner): World => ({ ...world, t });

async function decisionActions(world: World): Promise<string[]> {
  const { decisions } = await world.t.client.listDecisions(world.workspaceId);

  return decisions.map((decision) => decision.action);
}

describe("restoring a backup older than the last payment", () => {
  it("without a fence, a restore that keeps the file signs an approval a second time", async () => {
    // The hazard the fence exists for, kept as a characterization: a disk snapshot rolled back
    // in place looks like the same file, so only the operator's `fence` step catches it.
    const host = signerHost();
    const world = await setUpWorld(host.t);
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);

    const afterBackup = on(world, host.backUp());

    const first = await afterBackup.t.client.sign({
      intent,
      authorization,
      transaction: txParams(),
    });

    const restored = on(world, host.restoreInPlace());
    const second = await restored.t.client.sign({ intent, authorization, transaction: txParams() });
    expect(second.transactionHash).not.toBe(first.transactionHash);
    host.stop();
  });

  it("after the operator's fence, an approval used after the backup is refused, and so is one that was waiting", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    const paid = intentFor(world, undefined, "paid after the backup");
    const paidAuthorization = approveIntent(world, paid);
    const waiting = intentFor(world, undefined, "waiting at the backup");
    const waitingAuthorization = approveIntent(world, waiting);

    const threshold = authorize(
      {
        ...header(host.clock, newId("apr"), world.workspaceId),
        type: "set-admin-threshold",
        adminThreshold: 1,
      },
      world.people,
    );

    const live = on(world, host.backUp());
    await live.t.client.sign({
      intent: paid,
      authorization: paidAuthorization,
      transaction: txParams(),
    });

    const restored = on(world, host.restoreInPlace());
    host.clock.value += 5;
    expect(host.t.signer.fence()).toBe(host.clock.value);

    await refused(
      restored.t.client.sign({
        intent: paid,
        authorization: paidAuthorization,
        transaction: txParams(),
      }),
      "envelope_fenced",
    );
    await refused(
      restored.t.client.sign({
        intent: waiting,
        authorization: waitingAuthorization,
        transaction: txParams(),
      }),
      "envelope_fenced",
    );
    // Changes that add authority are fenced the same way.
    await refused(
      restored.t.client.setAdminThreshold(world.workspaceId, threshold),
      "envelope_fenced",
    );
    expect((await restored.t.client.getApproval(paidAuthorization.envelope.approvalId)).state).toBe(
      "unknown",
    );

    const { decisions } = await restored.t.client.listDecisions(world.workspaceId);
    expect(decisions.filter((d) => d.action === "fence-set-by-operator")).toHaveLength(1);
    expect(
      decisions.filter((d) => d.outcome === "denied" && d.code === "envelope_fenced"),
    ).toHaveLength(3);
    expect(host.t.signer.verifyDecisionLog(world.workspaceId)).toEqual({
      ok: true,
      brokenAt: null,
    });
    host.stop();
  });

  it("a backup restored as a new file is fenced by the signer itself, without the operator", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    const paid = intentFor(world);
    const authorization = approveIntent(world, paid);
    const live = on(world, host.backUp());
    await live.t.client.sign({ intent: paid, authorization, transaction: txParams() });
    // A restart of the same file is not a restore: nothing is fenced.
    host.stop();
    const restarted = on(world, host.start());
    expect(await decisionActions(restarted)).not.toContain("fence-set-on-new-database-file");

    const restored = on(world, host.restoreAsNewFile());
    expect(await decisionActions(restored)).toContain("fence-set-on-new-database-file");
    await refused(
      restored.t.client.sign({ intent: paid, authorization, transaction: txParams() }),
      "envelope_fenced",
    );
    host.stop();
  });
});

describe("after a fence", () => {
  it("signs an envelope issued once the allowed clock skew has passed, and refuses one inside it", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    const fenceAt = host.t.signer.fence();

    host.clock.value = fenceAt + 29;
    const early = intentFor(world);
    await refused(
      world.t.client.sign({
        intent: early,
        authorization: approveIntent(world, early),
        transaction: txParams(),
      }),
      "envelope_fenced",
    );

    host.clock.value = fenceAt + 30;
    const fresh = intentFor(world);

    const signed = await world.t.client.sign({
      intent: fresh,
      authorization: approveIntent(world, fresh),
      transaction: txParams(),
    });

    expect(signed.from).toBe(world.address);
    host.stop();
  });

  it("keeps the fence across a restart", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    const before = intentFor(world);
    const beforeAuthorization = approveIntent(world, before);
    const fenceAt = host.t.signer.fence();

    host.stop();
    const restarted = on(world, host.start());
    host.clock.value = fenceAt + 60;
    await refused(
      restarted.t.client.sign({
        intent: before,
        authorization: beforeAuthorization,
        transaction: txParams(),
      }),
      "envelope_fenced",
    );
    const after = intentFor(restarted);
    await restarted.t.client.sign({
      intent: after,
      authorization: approveIntent(restarted, after),
      transaction: txParams(),
    });
    const actions = await decisionActions(restarted);
    expect(actions.filter((action) => action.startsWith("fence-"))).toEqual([
      "fence-set-by-operator",
    ]);
    host.stop();
  });

  it("still returns the stored transaction for an approval this database already signed", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    const intent = intentFor(world);

    const request = {
      intent,
      authorization: approveIntent(world, intent),
      transaction: txParams(),
    };

    const first = await world.t.client.sign(request);
    host.t.signer.fence();
    expect(await world.t.client.sign({ ...request, transaction: txParams() })).toEqual(first);
    host.stop();
  });

  it("never moves backwards", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    const fenceAt = host.t.signer.fence();
    host.clock.value -= 600;
    expect(host.t.signer.fence()).toBe(fenceAt);
    const actions = await decisionActions(world);
    expect(actions.filter((action) => action === "fence-set-by-operator")).toHaveLength(1);
    host.stop();
  });
});

describe("the database's schema version", () => {
  const userVersion = (path: string) => {
    const db = new DatabaseSync(path);
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    db.close();

    return user_version;
  };

  it("a new file starts at the current version and is not fenced", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    expect(await decisionActions(world)).not.toContain("fence-set-on-new-database-file");
    host.stop();
    expect(userVersion(host.sqlitePath)).toBe(SCHEMA_VERSION);
  });

  it("a v0.1 file is migrated, keeps its records, and is fenced once, since nothing says it was not restored", async () => {
    const host = signerHost();
    const world = await setUpWorld(host.t);
    host.stop();
    // What a v0.1 signer left behind: the same tables, no metadata, user_version 0.
    const old = new DatabaseSync(host.sqlitePath);
    old.exec(`DROP TABLE signer_meta; ${DROP_VERSION_7} PRAGMA user_version = 0;`);
    old.close();

    const upgraded = on(world, host.start());
    expect((await upgraded.t.client.getWallet(world.walletId)).policy).toEqual(world.policy);
    expect(host.t.signer.verifyDecisionLog(world.workspaceId)).toEqual({
      ok: true,
      brokenAt: null,
    });
    host.stop();
    expect(userVersion(host.sqlitePath)).toBe(SCHEMA_VERSION);
    const again = on(world, host.start());
    expect(
      (await decisionActions(again)).filter((a) => a === "fence-set-on-new-database-file"),
    ).toHaveLength(1);
    host.stop();
  });

  it("a file written by a newer signer is refused, not opened", () => {
    const host = signerHost();
    host.stop();
    const newer = new DatabaseSync(host.sqlitePath);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    expect(() => host.start()).toThrow(SchemaTooNewError);
  });
});
