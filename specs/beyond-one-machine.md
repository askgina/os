# Run on more than one machine: the signer on its own host first, then key providers, replicas, Kubernetes and HA Postgres

- Branch: none yet
- Status: Ready for Review (built 2026-11-15; every milestone green in CI run 43744005029)
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-15
- Links: [Ticket #25](https://github.com/askgina/os/issues/25) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](./research/beyond-one-machine.md) | [v0.1 plan](./agent-workspaces-v0.1.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

The product runs on one machine. Root on that machine is the signer host, so the separation between the control plane and the signer protects nothing against whoever administers it (`docs/threat-model.md:564-566`). This plan takes the product to several machines in the order that pays off first in security, then in availability.

After this plan:

1. An operator can run the signer on its own host, administered by different people, reached only over mutual TLS. The confirmation page, where every approval is made (the keyless `approve` service at `APPROVE_ORIGIN`, `specs/trusted-display.md`), runs in the signer's trust domain too (D7). A person who takes over the control-plane host can then no longer enroll an approver, move the restore fence, revoke a mandate from the operator's command line, read the vault, exceed a policy or show a false confirmation page, because none of that is on that host. This is the one step in the plan that improves security.
2. A signer restored from a backup, or moved to a standby host, cannot be made to sign an approval it already signed before the backup. This is built (Milestone 2, delivered): the operator runs `fence` before starting it, and the signer fences a database file it did not open last by itself.
3. The control plane can keep its key-encryption keys in OpenBao Transit instead of a file, with a migration path from the file keyring.
4. The control plane runs as several replicas: crash one in the middle of a payment and the other finishes it with exactly one transaction.
5. The control plane installs on Kubernetes from Kustomize manifests, with NetworkPolicies that reproduce the Compose isolation as far as Kubernetes allows. Postgres can be a three-instance CloudNativePG cluster with synchronous replication.

Every step keeps the invariant: the signer decides whether a human approved and signs only what was approved, or what a live mandate it holds covers. The control plane is never trusted for that. Nothing in this plan moves a decision out of the signer or a key into the control plane.

Non-goals: replicating the signer; AWS or Google Cloud KMS providers (the interface is the contract; implementations are a later ticket); wallet keys in an HSM or cloud KMS; zero-downtime upgrades of the workflow bundle; autoscaling; service meshes; multi-region; Postgres HA outside Kubernetes (Patroni and similar); hosted or multi-tenant operation; moving the notification webhook secret or the VAPID key into a key provider (they stay files in the control plane's secrets).

Success means:

- CI job `stack (split)` passes every release gate with the signer and the control plane in two Compose projects that share nothing but one network carrying mutual TLS, with the `approve` service on the signer's side, and proves the control project holds no signer secret and no confirm secret.
- Delivered: `apps/signer/test/fence.test.ts` shows a restored signer signs a used approval again without a fence and refuses it with `envelope_fenced` after one; the release gate "a restored and fenced backup keeps wallets, refuses an approval used after the backup and every approval issued before the restore, and signs a new proposal" passes on the real stack (CI run 43710836888).
- CI job `stack (openbao)` passes every release gate with `KEY_PROVIDER=openbao`, and the World's ciphertext-at-rest test passes on both providers, including a 20 second OpenBao outage in the middle of a run.
- CI job `stack (replicas)` passes every release gate with two server replicas, plus a gate that kills the replica running a signing step and still ends in one transaction, and a gate that shows one notification delivery per row across both replicas.
- CI job `k8s` installs the kind overlay, passes the Kubernetes isolation gates and the release gates that do not need Compose, and, on the CloudNativePG variant, survives a primary failover during a payment with one transaction and a whole audit chain.
- Out of scope and stays out: signer replication, cloud KMS adapters, zero-downtime workflow upgrades.

## Progress

- [x] (2026-11-14 21:38Z) Research current behavior and relevant code paths: [`specs/research/beyond-one-machine.md`](./research/beyond-one-machine.md).
- [x] (2026-11-15) Owner decisions D1 to D9 (see `Decision Log`). D5 was taken (2026-11-14): (a). D1 to D4 and D6 to D9 were taken 2026-11-15 by the lead under Eric's delegation, each as the recommended option (a).
- [x] (2026-11-15) CI evidence for Milestones 3, 4 and 5, which supersedes every "CI pending" on
      the lines below: run 43739857058 at `1752478` (the first on Blacksmith runners):
      `stack (replicas)` green (one setup token across two replicas, `/readyz` on both, the
      replica that started signing killed and the other finishing with exactly one transaction,
      each webhook delivery once, the shared agent rate limit, then every release gate on two
      replicas) and `stack (openbao)` green (the AppRole can do nothing but wrap and unwrap, a
      payment, no plaintext, a 20-second outage failing closed and recovering, rotation and
      rewrap, then every release gate with OpenBao as the only key provider). Run 43741473023
      at `89ea505`: job `k8s` green (both overlays render and validate, two server replicas
      Ready on kind, the isolation probe passing and failing under its control, a payment
      approved on the signer's page ending confirmed) and job `test` green with the World's
      ciphertext-at-rest test on both key providers, including the OpenBao outage.
- [x] (2026-11-15) Milestone 1 in CI: `stack (split)` passed on its first run (run 43733608692
      at `8510295`): every release gate through two Compose projects joined only by the wire
      network, and `split.spec.ts` (3 tests: no signer secret or service on the control side,
      the handshake refused without the control certificate, no outbound route from the signer
      under the example nftables rules). Found by that run's `test` job and fixed: the enroll
      command now attaches the passkey values with `=`, because one base64url value in 64
      starts with a dash and was read as an option.
- [x] Milestone 1: the signer on its own host. First half built and green in CI (2026-11-15,
      `8e78b3f`, run 43727759164): signer mutual TLS with each client certificate bound to its
      scope, the loopback health listener, the expiry check at boot, `createSignerFetch`
      (`@askgina/os-protocol/signer-transport`), the `approve` service's TLS client,
      `deploy/split/make-peer-certs.sh`. Second half written (2026-11-15), local checks only, CI
      pending: the server's TLS client (`SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`,
      `SIGNER_TLS_PEER_CERT_FILE`, the https/http rule) and `SIGNER_ADMIN_COMMAND`, shown to
      owners as `signerAdminCommand` in the workspace response and used by the members page;
      `init --domain=all|control|signer` with a read-only `/import` directory; the two split
      Compose files with their Caddyfiles, `deploy/split/nftables-signer.conf`; `E2E_SPLIT=1` in
      `e2e/run.sh` and `e2e/src/stack.ts` with two overlays; `e2e/test/split.spec.ts`; the
      `stack (split)` CI entry. Local: `apps/server/test/support/signer-tls-config.test.ts` (8)
      and `apps/web/test/operator.test.ts` (13) pass alone; type checks of server, api, web and e2e
      clean; every Compose file and overlay parses. Left: `stack (split)` green in CI.
- [x] (2026-11-14) Milestone 2: the restore fence, built ahead of Milestone 1 as a fix to v0.1: `apps/signer/src/fence.ts`, the `fence` admin command, `envelope_fenced` for every envelope kind, a `PRAGMA user_version` migration step for the signer's SQLite (version 2 adds `signer_meta`), detection of a replaced database file, the rewritten restore gate and restore procedure. Proven locally: `apps/signer/test/fence.test.ts` (10 tests) and `apps/signer/test/admin.test.ts` (3 tests) pass, one file at a time.
- [ ] Milestone 2 in CI: the restore gate in `e2e/test/release-gates.spec.ts` on a real stack (`stack (amd64)`, `stack (arm64)`), including `docker compose run --rm signer node src/admin.ts fence` on restored volumes. Written and type-checked, not run.
- [ ] Milestone 3: key providers and OpenBao Transit. Built (2026-11-15), CI pending:
      `KeyProvider` gains `ready` and `close` and loses `hasKek`; `TransitKeyProvider`,
      `CompositeKeyProvider`, `keyProviderFromEnv` (`KEY_PROVIDER`, `OPENBAO_*`); typed
      `KeyProviderUnavailableError` and `KeyProviderRefusedError`; shredding works during a
      provider outage; `@askgina/os-keys` 0.2.0; the test services gain a development OpenBao;
      `deploy/openbao/policy.hcl`. The `stack (openbao)` CI entry is written (2026-11-15), not
      run: `e2e/compose.openbao.yaml` (OpenBao 2.7.2 as a real server on Raft storage, not
      development mode, so its keys survive restarts and the backup gate's restored copy;
      `openbao-bootstrap`, `e2e/src/openbao-bootstrap.mts`, initializes and unseals it on every
      `up`, enables Transit with `os-kek` and an AppRole limited to `deploy/openbao/policy.hcl`,
      and writes `openbao-role-id` and `openbao-secret-id` into the server's secrets volume; the
      server runs with `KEY_PROVIDER=openbao`, no keyring file and `DATA_KEY_CACHE_SECONDS=0`),
      `e2e/test/openbao.spec.ts` (the AppRole wraps and unwraps under `os-kek` and is refused
      rotate, config, export, delete, a new key and `sys/mounts`; a payment end to end; every
      live data key under `bao:transit/os-kek@1` and no plaintext marker in the database; with
      OpenBao paused 20 seconds a new proposal is refused and not stored, `/readyz` stays 200,
      and a payment approved during the outage is confirmed after it, the delays printed as
      `{"gate":"openbao-outage",...}`; rotation, a server restart, `cli.ts rewrap` and
      `min_decryption_version=2` leave every key under `@2` and the first payment's memo
      readable), then every release gate on a second fresh stack of that kind. The World
      ciphertext test on both providers is written (2026-11-15), not run (CI-only):
      `packages/world/test/ciphertext-at-rest.test.ts` runs the marker scenario (with a check
      that the run's key is wrapped under `k1` or `bao:<mount>/os-kek@1`) and shredding on the
      keyring file and on Transit (required when `CI=true`); on Transit, with the container
      paused 20 seconds, a new run is refused as unavailable and leaves no row, a run resumed
      during the outage is neither completed nor failed at unpause and completes after it, the
      delays printed as `{"gate":"world-openbao-outage",...}`. The stock control runs once (it
      uses no key provider). The OpenBao test helpers moved to `packages/testkit/src/openbao.ts`
      with `holdOpenBao()`. Left: CI green, and the measured outage delays of both gates
      recorded here.
- [ ] Milestone 4: a replica-safe control plane. Server and key-store half written (2026-11-15),
      local checks only, CI pending: `os.rate_limits` (UNLOGGED, migration
      `0010_rate_limits`) with `takeToken`/`hasToken` (`apps/server/src/rate-limit.ts`) behind
      the gateway's agent and failed-authentication limits and `FORWARDED_HOPS`; the setup token
      minted once per installation under `SETUP_LOCK`, `SETUP_TOKEN_IN_LOG`, and
      `node apps/server/src/cli.ts setup-token`; the lifecycle finalize throttle shared through a
      bucket (`sweep:lifecycle-finalize`) instead of a per-process map; `DataKeyStore` announcing
      every shred and `shredTenant` key on `os_keys_shred` with the `listen` option, `start()` and
      `close()`, used by the server with `DATA_KEY_CACHE_SECONDS`; the workflow-bundle guard
      (`apps/server/src/execution/bundle-guard.ts`, classes `18680`/`18681`) before the World
      starts; `GET /readyz`; `step.started` with `replica` in `signOnce`;
      `rotate-keyring.mjs add --inactive` and `activate <id>`. Local, one file at a time:
      `packages/keys/test/data-key-store.test.ts` (25), `packages/keys/test/cli.test.ts` (17),
      `apps/server/test/support/rate-limit.test.ts` (5, two gateways on one database),
      `apps/server/test/execution/bundle-guard.test.ts` (3),
      `apps/server/test/support/public-app.test.ts` (3),
      `apps/server/test/identity/identity.test.ts` (43), and unchanged `hardening` (19), `mcp`
      (9), `engine` (17), `sweep` (4), `lifecycle/delete` (3), `lifecycle/retire` (3),
      `notify/outbox` (11); type checks of `apps/server` and `packages/keys` clean. Left:
      `deploy/README.md` (two-phase rotation, setup token, the three
      variables, `/readyz`). Written (2026-11-15), not run: both Caddyfiles proxy to
      `dynamic a server 3000` (refreshed every second, 10 seconds of retries for a request that
      cannot reach its replica); `compose.yaml` checks the server's health on `/readyz` and
      passes `DATA_KEY_CACHE_SECONDS`, `FORWARDED_HOPS`, `SETUP_TOKEN_IN_LOG`, `KEY_PROVIDER`
      and `OPENBAO_*` with defaults that keep the file keyring and one replica's behaviour;
      `e2e/compose.replicas.yaml` (two replicas) and `e2e/test/replicas.spec.ts` (one
      `setup.token_issued` across both replicas and the setup-token command refused after
      setup; `/readyz` 200 on each replica and the edge; the replica that logged `step.started`
      for an approval is killed while the chain is paused and the other confirms it with one
      transaction within 90 seconds, having logged `step.started` itself; each webhook
      delivery of one approval received once while both replicas sweep; 120 requests of one
      agent split across both replicas' own ports pass and the 121st through Caddy gets 429),
      then every release gate on a second fresh two-replica stack, in the `stack (replicas)` CI
      entry. Left: CI green.
- [ ] Milestone 5: Kubernetes manifests proven on kind. Written (2026-11-15), not run, CI
      pending: `deploy/k8s/` (base, components `signer-in-cluster`, `signer-external`,
      `postgres-single`, `dev-chain`, `notifications-egress`, overlays `kind` and
      `production-example`), `deploy/k8s/isolation-probe.yaml` (agent, bystander and outsider
      Jobs), `deploy/k8s/make-secrets.sh` (the kind overlay's Secrets from `init.mjs`),
      `deploy/k8s/test/files.test.ts` (copies of `deploy/` files stay byte-equal), `e2e/run-k8s.sh`,
      `e2e/test/kubernetes.spec.ts` and the `k8s` CI job (kind v0.33.0, kubectl v1.37.0,
      kubeconform v0.8.0, each by SHA-256). The server Deployment runs 2 replicas with
      `strategy: Recreate`, and the gate checks both are Ready. Not done: the `StackDriver` and
      running every release gate with `E2E_DRIVER=k8s`, and the replica crash gate on
      Kubernetes. CI so far: run 43737561979 (`ad0454f`) failed rendering the kind overlay (see
      `Surprises & Discoveries`); run 43739857058 rendered both overlays, passed kubeconform,
      started kind and applied the overlay, then `make-secrets.sh` failed (it chowned the
      container's read-only `/secrets`); both fixed, written, not re-run.
- [x] Milestone 6: HA Postgres with CloudNativePG. Green on its first run (job `k8s-ha`, run
      43744005029). Written (2026-11-15), not run, CI pending:
      `deploy/k8s/components/postgres-cnpg/` (Cluster `os-db`: 3 instances, `synchronous:
      { method: any, number: 1, dataDurability: required }`, `max_connections: "200"` with the
      formula, image `ghcr.io/cloudnative-pg/postgresql:18.7-202611122305-minimal-trixie` by
      digest; the server on `os-db-rw.os.svc:5432` with the password from the operator's
      `os-db-app`; NetworkPolicies for the instances and the operator, the Kubernetes API by
      address), used by `overlays/production-example` and the new `overlays/kind-ha`;
      `e2e/run-k8s.sh --ha` (the operator v1.30.1 manifest by SHA-256, its image by digest) and
      `e2e/test/kubernetes-ha.spec.ts` in the new CI job `k8s-ha`; `k8s` validates CRDs against
      a commit-pinned schema catalog. The gate: the isolation probe; a payment; the primary
      deleted (`--grace-period=0 --force`) while a payment is being signed, then confirmed
      within 180 s with one transaction, the audit chain verified, no server restart; `/readyz`
      200 on both replicas and a new payment; every `LISTEN` a replica had before back on the new
      primary (the open question below), both replicas holding the bundle lock and another
      bundle refused; a shred on one replica heard by the other within 5 s; with both standbys
      deleted (node cordoned) a write that waits in `SyncRep`, invisible, and lands once they
      return. It prints the failover and recovery times. Deviations: the files are named
      `components/postgres-cnpg` and `kubernetes-ha.spec.ts`, and the gate is a job of its own
      rather than a matrix entry of `k8s`, which only gains the CRD schema location; the
      notification-row check and the rolled-back-database gate (Compose) are not written.
      Left: CI green.
- [x] (2026-11-15) Milestone 7: documentation matches the code (deploy guide, signer README,
      threat model, architecture, README, protocol section 10, `deploy/split/.env.example`).
      Not done: the plan's `config-docs.test.ts` that would compare documented settings with
      the code.
- [x] (2026-11-15) Run validation in CI and record evidence: see `Outcomes & Retrospective`.
- [x] (2026-11-15) Re-checked against main at `2911c20`: Milestone 2 and its restore gate are CI-green (run 43710836888); the rest is rewritten for the trusted display, mandates and notifications. See `Revision Notes`.

## Surprises & Discoveries

- Observation: account-nonce reservations are control-plane state, not signer state. They live in `os.nonce_reservations` under a per-wallet, per-chain `pg_advisory_xact_lock`, so they already serialize across server replicas. A stuck transaction keeps its nonce (v0.1 defect fix), which is the same lock and the same table.
  Evidence: `apps/server/src/execution/transactions.ts:109-165` (the allocator moved there from `intents.ts`); `specs/agent-workspaces-v0.1.md:153-155`.
- Observation: a signer restored from a backup older than its last signature forgot the used nonce, the approval and the spend, and signed the same authorization again while the envelope was unexpired, for up to 24 hours by default. At drafting time `deploy/README.md` promised that waiting approvals "can still be approved after the restore". Since `018d2f5` the guide says every restore is fenced and that approvals waiting at the backup are shown closed and must be proposed again (`deploy/README.md:136-175`), so D5 (a) and the guide agree.
  Evidence: `apps/signer/src/signer.ts:381-402` (fence check, then the used-nonce check); `apps/signer/src/config.ts:22`; research finding 6.
- Observation: OpenBao Transit's `rewrap` endpoint takes no `associated_data`, so AAD-bound data keys are rewrapped by decrypt and encrypt, which is what `DataKeyStore.rewrap` already does.
  Evidence: [Transit API](https://openbao.org/api-docs/secret/transit/), "Rewrap data" parameters.
- Observation: runs are not pinned to a workflow bundle. The Postgres World's deployment id is the constant `'postgres'`, and the approval workflow id has no content hash, so two replicas on different bundles can replay the same run with different code.
  Evidence: `@workflow/world-postgres` 5.2.0 `dist/queue.js:351-353`; generated `apps/server/.well-known/workflow/v1/manifest.json:87`.
- Observation: after a key-provider outage, a run can wait hours before its next attempt: Graphile's backoff is `exp(min(attempts, 10))` seconds, about 6 hours per attempt from the tenth, and core fails the run on delivery 49.
  Evidence: `@workflow/world-postgres` 5.2.0 `dist/queue.js:105-118`.
- Observation: Kubernetes NetworkPolicy cannot block `localhost` inside a pod and cannot hide Service names from DNS, so two Compose properties (the loopback-only delivery listener is private to one container; agents cannot resolve internal names) need other measures.
  Evidence: [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/); `e2e/test/release-gates.spec.ts:557-590`.
- Observation: with asynchronous replication, a lost commit removes an audit entry and the workspace's audit head together, so `verifyAudit` still passes and the loss is invisible; a lost shred commit brings a destroyed key back.
  Evidence: `apps/server/src/audit.ts:55-130`; `packages/keys/src/data-key-store.ts:264-275`; research finding 8.
- Observation: a backup of a stopped signer and the stopped signer are the same bytes, so nothing inside the data can tell a restart from a restore. What differs is the file: SQLite never replaces its main file, while a copy, an extracted archive or a move gets a new creation time even where the filesystem reuses the inode number. A disk snapshot rolled back in place keeps both, and `cp -a` onto an existing file writes in place and keeps both too.
  Evidence: a local probe with Node 26 on ext4 (rewriting in place kept `ino` and `birthtimeNs`; deleting and recreating reused the `ino` with a new `birthtimeNs`); `apps/signer/test/fence.test.ts`, "without a fence, a restore that keeps the file signs an approval a second time".
- Observation: the signer's SQLite had no schema version; every table was `CREATE TABLE IF NOT EXISTS`, so a column or a table added later had no migration step.
  Evidence: `apps/signer/src/db.ts` before this change.
- Observation (2026-11-15): moving the signer to another host is a new database file, so the signer fences itself on the new host, and every move of the fence revokes every live mandate with reason `operator`. A move therefore ends all mandates as well as every waiting approval.
  Evidence: `apps/signer/src/fence.ts:55-74,94-109`; `deploy/README.md:161-175`; release gate "the operator's restore fence ends every live mandate" (`e2e/test/release-gates.spec.ts:1741`).
- Observation (2026-11-15): mandate windows and lifetimes, the daily cap and the fence are all counted by the signer's own clock; the control plane's clock matters only for the 60 second request signature and the `issuedAt` it writes into envelopes (refused when more than 30 seconds ahead of the signer).
  Evidence: `apps/signer/src/mandates.ts:183-196`; `apps/signer/src/signer.ts:63,266`; `packages/protocol/src/webauthn/verify-authorization.ts:53-54,128`; `deploy/README.md:177-178,260`.
- Observation (2026-11-15): the notification outbox is already replica-safe. Due rows are claimed under `FOR UPDATE SKIP LOCKED` and leased for 60 seconds in one short transaction, sent outside it, and an outcome is recorded only while the lease still holds; a sender that dies leaves its row to be sent again after the lease. Delivery is at least once, and the guide tells receivers to dedupe.
  Evidence: `apps/server/src/notify/outbox.ts:28-39,162-196,399-420`; `deploy/README.md:403-419`.
- Observation (2026-11-15): two transactions that inserted rows referring to one workspace and then appended to its audit chain deadlocked under `FOR UPDATE` on the workspace row; `appendAudit` now takes `FOR NO KEY UPDATE`. Concurrent proposals on several replicas meet the same lock, so the fix is a precondition for Milestone 4, already met.
  Evidence: `apps/server/src/audit.ts:61-70`; commit `307c404`.
- Observation (2026-11-15, Milestone 4): the research's list of per-process state missed one
  decider: the lifecycle finalize step (`apps/server/src/lifecycle/finalize.ts`) was throttled to
  once a minute by a per-process `WeakMap`, so N replicas finalized N times a minute, each calling
  the signer. It is now one bucket in `os.rate_limits` (one token a minute, burst 1) on the
  database's clock. The 3-second sweep itself stays in every replica, as planned: wake-ups only
  resume a hook, starts are serialized per request, the outbox leases rows.
  Evidence: `apps/server/test/support/rate-limit.test.ts`, "retirements and deletions are
  finished at most once a minute across replicas".
- Observation (2026-11-15, Milestone 4): a token bucket cannot be "checked before the lookup"
  without a read, so the failed-authentication limit reads its bucket (`hasToken`, one primary-key
  read in `os.rate_limits`) before the agents table, and takes a token only on a failure.
  Evidence: `apps/server/src/mcp/gateway.ts`, `authenticate`.
- Observation (2026-11-15, Milestone 4): a listening key store must not cache while its
  `LISTEN` connection is down, or a shred made in that gap stays cached until the TTL; and a key
  read just before a shred is heard must not be cached after it. The store therefore caches only
  while listening, forgets everything when the connection drops and again when it listens anew,
  and does not cache a read that an eviction overtook.
  Evidence: `packages/keys/src/data-key-store.ts` (`#evictions`, `#lost`);
  `packages/keys/test/data-key-store.test.ts`, "a listening store forgets its cache when its
  connection is lost, and listens again".
- Observation (2026-11-15, Milestone 4): changing `rotate-keyring.mjs add` to add an inactive key,
  as planned, would break the CI-green lifecycle gate that rotates "exactly as the deploy guide
  gives it" (`e2e/test/lifecycle.spec.ts:1317-1345`) and the guide itself
  (`deploy/README.md:213-217`). So `add` still adds and activates (one machine), and the replica
  procedure uses `add --inactive`, restart every replica, `activate <id>`, restart every replica,
  rewrap, prune, restart. The guide's replica section (Milestone 7) gives that order.
- Observation (2026-11-15, Milestone 4): a setup token is minted once per installation, so a
  restart before setup no longer replaces it and logs `setup.token_pending` instead; the token
  in the first boot's log keeps working, and `cli.ts setup-token` replaces it. `deploy/README.md`
  ("The setup token", which says every start prints a new one) must follow.
  Evidence: `apps/server/src/identity/setup.ts`; `apps/server/test/identity/identity.test.ts`,
  "two boots at once mint one setup token …".
- Observation (2026-11-15, Milestone 4): connections per replica, re-counted. Everything the
  server, the World, Graphile and the key store use comes from one pool of
  `WORKFLOW_WORKER_CONCURRENCY + 14` (24 by default, up from 22): one connection per workflow
  worker, two held for good (the shred listener and the bundle lock), Graphile's `LISTEN`, the
  World's run-status and run-events listeners when used, and requests. The World opens no pool of
  its own (`pool` is passed) and no client of its own unless `WORKFLOW_POSTGRES_INVOKE=1`. The
  operator's commands add 1 (`cli.ts`) or 2 (`erase-cli.ts`) while they run. Postgres needs at
  least `replicas × (WORKFLOW_WORKER_CONCURRENCY + 14)` plus headroom.
  Evidence: `apps/server/src/main.ts`; `@workflow/world-postgres` 5.2.0 `dist/index.js:39-60`,
  `dist/invocation-notifications.js:55`.
- Observation (2026-11-15, Milestone 4): Caddy runs no active health checks for dynamic
  upstreams, so a `health_uri /readyz` next to `dynamic a` would do nothing. The edges refresh
  the replica list every second (a stopped container leaves Docker's DNS at once) and retry a
  request that could not reach its replica for up to 10 seconds; `/readyz` is the Compose
  health check, and the readiness probe on Kubernetes.
  Evidence: [reverse_proxy, "Dynamic upstreams"](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#dynamic-upstreams):
  "active health checks do not run for dynamic upstreams".
- Observation (2026-11-15, Milestone 3): OpenBao 2.7 removed the `file` storage backend, and a
  development-mode server keeps everything in memory, so the backup gate's restored copy of a
  stack would meet a Transit key it never had. `stack (openbao)` runs OpenBao as a real server
  on Raft storage in a volume that the backup copies, unsealed with one key from a test-only
  volume by `openbao-bootstrap` on every `up`.
  Evidence: [a report of the 2.7 upgrade](https://jacar.es/en/fix-unknown-storage-type-file-openbao-2-7/)
  ("OpenBao 2.7 removed the file backend"; `bao operator migrate` reads it as a source until
  2.8.0), not yet checked against OpenBao's own release notes; `e2e/compose.openbao.yaml`.
- Observation (2026-11-15): Compose `extends` resolves the base file's relative paths (build
  context, bind mounts) against the base file's directory and keeps its `depends_on`, so each split
  file extends the services of `compose.yaml` and changes only what a second host needs, with
  `!override` for lists (networks, ports, volumes, the health check). A base file's `${VAR:?}` is
  interpolated before an overlay's `!reset` can drop the key, so the e2e run sets
  `SIGNER_BIND_ADDRESS` although its overlay publishes nothing.
  Evidence: `docker compose config` (v2.40.3) on `deploy/split/*.compose.yaml` and the e2e overlays.
- Observation (2026-11-15): `make-peer-certs.sh` writes `0400` files owned by the operator, which a
  container running as `node` (uid 1000) can read from a bind mount only when the operator is uid
  1000 too (GitHub's runner is 1001). `init --domain=signer|control` therefore installs them from a
  read-only `/import` directory into the host's secret volumes, owned by `node`, and rewrites a copy
  whenever `/import` differs, which is also how a renewed certificate takes effect.
  Evidence: `deploy/init/init.mjs`; `deploy/split/make-peer-certs.sh` (`chmod 0400`).
- Observation (2026-11-15, Milestone 5): kindnet in kind v0.33.0 enforces NetworkPolicies with
  kube-network-policies configured `FailOpen: true`, and logs "skipping network policies" and
  carries on when its controller cannot start. A broken dataplane therefore allows everything
  silently; only a probe that expects silence notices. Node traffic from root (the kubelet's
  probes) is exempt, and traffic from a pod to its node is checked in the `input` hook, so a
  default-deny egress policy also blocks the Kubernetes API.
  Evidence: `images/kindnetd/cmd/kindnetd/main.go` at `v0.33.0` (`dataplane.Config{FailOpen:
  true}`); kube-network-policies `pkg/dataplane/controller.go` at `f67f0fb` ("meta skuid 0
  accept", the `input` chain).
- Observation (2026-11-15, Milestone 5): every role already has its own policy of each type, so
  deleting a namespace's `default-deny` opens nothing for them; the probe's control therefore
  uses a pod with no role in `os`, held only by `default-deny`, and the probe fails as soon as
  that policy is gone. A probe pod that carried the signer's labels would also receive the
  signer's traffic, so the signer's and `approve`'s isolation is checked by `kubectl exec` of the
  same probe script inside them instead.
  Evidence: `deploy/k8s/isolation-probe.yaml`; `e2e/test/kubernetes.spec.ts`.
- Observation (2026-11-15, Milestone 5): `ReadWriteOncePod` is for CSI volumes only, and kind's
  local-path volumes are not CSI, so the in-cluster signer uses `ReadWriteOnce` with one
  StatefulSet replica as its single writer. The Caddy image's file capability needs
  NET_BIND_SERVICE in the bounding set to start at all, and the non-root gateway binds port 80
  through the namespaced sysctl `net.ipv4.ip_unprivileged_port_start`, which the `restricted`
  standard allows, so `deploy/Caddyfile.agents` is used unchanged.
  Evidence: [Persistent Volumes, access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes);
  [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/).
- Observation (2026-11-15, Milestone 5): Kustomize runs a kustomization's own generators before
  its components (resources, generators, components, then transformers), so an overlay's
  `configMapGenerator` with `behavior: merge` cannot reach a ConfigMap a component generates:
  "id … os-signer … does not exist; cannot merge or replace". The overlay now sets the origins
  once, in the base's `os-server`, and `signer-in-cluster` copies them to the signer and
  `approve` with `replacements`, which run inside the component after the overlay's merge. The
  three values therefore cannot differ between server and signer, as in `compose.yaml`.
  Evidence: CI run 43737561979, job `k8s` (kubectl v1.37.0, Kustomize v5.8.1);
  `api/internal/target/kusttarget.go` at `kustomize/v5.8.1`, `accumulateTarget`.
- Observation (2026-11-15, Milestone 3): Vitest runs the `keys` and `world` projects at once, and
  both pause the one OpenBao test container (the World for 20 seconds), so each would break the
  other's cases, and `docker pause` fails on a paused container. Every test section that uses
  the real OpenBao holds `holdOpenBao()` (`packages/testkit/src/openbao.ts`), a session advisory
  lock on the test Postgres, from setup to teardown; a waiter gives up after 600 seconds and
  names the holder.
  Evidence: `vitest.config.ts` (`projects`), `packages/keys/test/transit.test.ts`.
- Observation (2026-11-15, Milestone 3): a hook resumed while the key provider is down may still
  be accepted: since a run publishes an X25519 public key at start, the SDK seals the resume
  payload to it without asking the World for the run's key. The run then cannot replay until its
  key unwraps, so the World's outage test asserts that the run is neither completed nor failed at
  unpause and completes afterwards, and accepts either answer to the resume itself.
  Evidence: `@workflow/core` 5.5.0 `dist/runtime/resume-hook.js` (`decodeRunPublicKey`,
  `sealTo`), `dist/runtime/start.js` (publishes the public key).
- Observation (2026-11-15, Milestone 6): `@workflow/world-postgres` 5.2.0 reconnects its own
  `LISTEN` connections (run status, run events, streams) once a second after a drop, logging
  `LISTEN <channel> connection lost; reconnecting` and `connection restored`; they are plain
  clients made from the pool's options, outside the pool's `max`. So the open question is
  answered by the code in favour of reconnecting, and the `k8s-ha` gate checks it on a real
  failover: every channel each replica listened on before is listened on again afterwards.
  The extra clients also mean up to 27 connections per replica, not 24.
  Evidence: `dist/streamer.js` (`listenChannel`, `LISTEN_RECONNECT_DELAY_MS`), `dist/run-status.js`,
  `dist/run-events.js`; `deploy/k8s/components/postgres-cnpg/cluster.yaml`.
- Observation (2026-11-15, Milestone 6): a replica's shred listener cannot be shown to work by a
  shred alone, because a data-key store caches only while it listens: a replica that does not
  listen also refuses a shredded key at once. The gate therefore first tombstones a key it just
  read without an announcement (the replica must still answer from its cache, which proves it
  listens) and then shreds it from the other replica (it must stop answering within 5 s).
  Evidence: `packages/keys/src/data-key-store.ts` (`getOrCreate`, `#lost`);
  `e2e/test/kubernetes-ha.spec.ts`.
- Observation (2026-11-15, Milestone 6): CloudNativePG's release manifest names its operator
  image by tag (`ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1`, twice, `imagePullPolicy:
  Always`), so the checksum alone does not pin what runs; `run-k8s.sh` rewrites both to the tag
  with its digest and checks it did. Its CRDs exceed the client-side apply annotation, so it is
  applied with `--server-side`.
  Evidence: `cnpg-1.30.1.yaml` (SHA-256 `37237f14…`), Deployment `cnpg-controller-manager`.

## Decision Log

Owner decisions. All are taken: D5 by Eric on 2026-11-14, the others on 2026-11-15 by the lead under Eric's delegation ("delegate to you on decisions like a CTO"), each as the option the plan recommended. The plan is written for the taken options, and every milestone that depends on one says so.

- Decision D1 (owner, taken 2026-11-15 by the lead under Eric's delegation): order of directions. Options: (a) signer split first (the fence is already built), then key provider, replicas, Kubernetes, HA Postgres; (b) Kubernetes first; (c) key provider first.
  Chosen: (a), the recommended option. Rationale: it is still the only direction that changes what a compromised control-plane host can do; the rest is availability.
- Decision D2 (owner, taken 2026-11-15 by the lead under Eric's delegation): first non-file key provider. Options: (a) OpenBao Transit; (b) AWS KMS; (c) Google Cloud KMS; (d) none, file keyring only.
  Chosen: (a), the recommended option. Rationale: self-hostable, MPL-licensed, a small HTTP API, and a real server can run in CI; cloud KMS cannot be proven without a cloud account.
- Decision D3 (owner, taken 2026-11-15 by the lead under Eric's delegation): Kubernetes packaging. Options: (a) Kustomize base and overlays; (b) Helm chart; (c) both; (d) documentation only.
  Chosen: (a), the recommended option. Rationale: plain YAML that `kubectl` applies and `kubeconform` checks, with no release Secrets holding rendered values.
- Decision D4 (owner, taken 2026-11-15 by the lead under Eric's delegation): where the signer and the `approve` service may run when the control plane is on Kubernetes. Options: (a) outside the cluster only, on the signer's own host; (b) in a separate cluster; (c) in the same cluster, documented as "cluster administrators are the signer host".
  Chosen: (a) for production, the recommended option; the in-cluster component exists for CI and evaluation only. Rationale: Secrets are unencrypted in etcd by default and cluster administration reaches every node, and an `approve` service in the cluster gives cluster administrators the confirmation page.
- Decision D5 (owner, taken 2026-11-14, applied): what a restore promises. Options: (a) every restore is fenced, so approvals waiting at backup time must be proposed again; (b) keep the v0.1 promise that waiting approvals survive a restore.
  Chosen: (a). Rationale: the operator cannot know from the backup whether a payment happened after it; (b) can pay twice. Status 2026-11-15: built in `018d2f5`; `deploy/README.md:136-175`, `docs/approval-protocol.md:385-428` and `docs/threat-model.md:245-262` all say (a), so the earlier contradiction with the deploy guide is gone. Nothing left to decide.
- Decision D6 (owner, taken 2026-11-15 by the lead under Eric's delegation): Postgres durability on Kubernetes. Options: (a) CloudNativePG, 3 instances, `dataDurability: required`; (b) `preferred`; (c) asynchronous.
  Chosen: (a), the recommended option. Rationale: no acknowledged audit entry, shred, mandate grant or notification row is ever lost; writes pause when no standby is available, which stalls approvals but loses nothing.
- Decision D7 (owner, new 2026-11-15, taken 2026-11-15 by the lead under Eric's delegation): where the confirmation page runs in a split deployment (the `approve` service, the edge that serves `APPROVE_ORIGIN`, its TLS certificate and the copy of the confirm secret). Options: (a) on the signer host, with its own small edge, the signer itself still unpublished except to the control host; (b) on a third host with its own administrators, reaching the signer over mutual TLS; (c) on the control host.
  Chosen: (a), the recommended option. Rationale: (c) gives a control-host compromise the confirmation page and so reopens the display gap the trusted display closed (`specs/trusted-display.md`, "Risks", says it runs with the signer on split hosts), and (b) adds a third set of administrators without lowering the worst case, since root on the signer host already controls everything.
- Decision D8 (owner, new 2026-11-15, taken 2026-11-15 by the lead under Eric's delegation): server egress on Kubernetes when the signed webhook or Web Push is on. Options: (a) allow the server pods TCP 443 to any address while either is configured, and rely on the server's own checks (`NOTIFY_WEBHOOK_URL` is one fixed URL, `WEB_PUSH_ENDPOINT_HOSTS` limits push endpoints); (b) only the CIDRs the operator lists, which push services with changing addresses cannot meet; (c) no notifications on Kubernetes.
  Chosen: (a), the recommended option. Rationale: a NetworkPolicy cannot name a host, and the Compose server already reaches the internet for RPC; the host checks stay in the server.
- Decision D9 (owner, new 2026-11-15, taken 2026-11-15 by the lead under Eric's delegation): whether a planned move of the signer to a new host may keep live mandates and waiting approvals. Options: (a) no: a move is a new database file, the signer fences itself and every live mandate ends (today's code); (b) add a hand-over command that lets the operator vouch that no copy is kept, and skip the fence.
  Chosen: (a), the recommended option. Rationale: the signer cannot tell a move from a copy, and a kept copy plus a skipped fence is exactly the double payment the fence exists to stop; people grant mandates again.

Plan decisions (taken here, reopen in review if wrong):

- Decision: mutual TLS lives in the signer process, with self-signed certificates where each side trusts exactly the other's certificate. No certificate authority.
  Rationale: protection that does not depend on how the network between hosts is configured; no CA key to guard. A tunnel (WireGuard, Tailscale) may be added by the operator but is not relied on.
  Date/Author: 2026-11-14 / research agent
- Decision (2026-11-15): with TLS on, the signer trusts two client certificates, the control plane's and the `approve` service's, and binds each to its request-signature scope: a control-scope route presented with the `approve` certificate, or a confirm-scope route with the control certificate, is refused as `unauthenticated` before the HMAC is checked.
  Rationale: the signer already has two scopes with two secrets (`docs/approval-protocol.md`, section 10, "Two secrets, two scopes"; `apps/signer/src/index.ts:236`); binding the certificate to the scope keeps a stolen confirm secret useless from the control host, and keeps the `approve` service on the same TLS listener instead of a second plain one.
  Date/Author: 2026-11-15 / plan refresh
- Decision: the HMAC request signature stays as it is, inside TLS.
  Rationale: it binds method, path, time and body (`docs/approval-protocol.md`, section 10); TLS alone does not bind a request to the moment it was made.
  Date/Author: 2026-11-14 / research agent
- Decision: the restore fence is a time, set by the operator on the signer host, compared with the envelope's passkey-covered `issuedAt` plus `CLOCK_SKEW_SECONDS`. Built: the check runs before the replay check (`apps/signer/src/signer.ts:381-402`; `docs/approval-protocol.md:385-386`), and again inside the signing transaction.
  Rationale: research finding 6; `packages/protocol/src/webauthn/verify-authorization.ts:53-54,128`.
  Date/Author: 2026-11-14 / research agent; order corrected 2026-11-15 to match the code
- Decision: the signer also fences by itself. It records its database file's identity (inode and creation time) in `signer_meta` and, on opening any other file that is not a newly created database, sets the fence to its clock and records `fence-set-on-new-database-file`. A v0.1 file has no recorded identity and is fenced once on its first open.
  Rationale: the owner asked that the fence cannot be skipped silently, and that the signer learns of a restore without the control plane. The documented restore (archives extracted into empty volumes) and every move between hosts create new files, so a forgotten `fence` step is caught; a snapshot rolled back in place is not, which is why the step stays (see `Surprises & Discoveries`).
  Date/Author: 2026-11-14 / FixSignerDefects
- Decision: `fence` takes no `--at`, prints `{ ok, action: "fence-set-by-operator", fenceAt }` like the other admin commands, and moves the fence only forward; a move appends one decision per workspace, a repeat in the same second appends nothing. Every move also revokes every live mandate (added with mandates, `apps/signer/src/fence.ts:72`).
  Rationale: "now" is the only safe value after a restore; an earlier one could let a used approval through, a later one only refuses more. One output shape for every admin command.
  Date/Author: 2026-11-14 / FixSignerDefects
- Decision: the control plane needs no special case. `envelope_fenced` is a permanent signer refusal like any other: the approval ends `failed` with that code, the intent ends `failed` with `failureCode: "envelope_fenced"` (not a new `approval_fenced`), and the nonce reservation is released by the existing path.
  Rationale: one code from the signer to the agent; nothing to translate.
  Date/Author: 2026-11-14 / FixSignerDefects
- Decision: the signer's SQLite gets `PRAGMA user_version` migrations: version 1 is the v0.1 schema (idempotent, so a v0.1 file at `user_version` 0 is taken as version 1), version 2 adds `signer_meta`. Migrations run in one `BEGIN IMMEDIATE` transaction; a file at a newer version is refused (`schema_too_new`). On main the schema is at version 6 (3 confirmations, 4 possession challenges, 5 mandates, 6 stuck-transaction repricing, built on main at `61d0326`). Nothing in this plan adds a signer schema version.
  Rationale: the fence needed a table, and later plans needed tables.
  Date/Author: 2026-11-14 / FixSignerDefects; versions updated 2026-11-15 (twice: version 6 landed with repricing)
- Decision: a Transit KEK id is `bao:<mount>/<key>@<version>`, and `wrap` passes that `key_version`.
  Rationale: rotation must change `kek_id`, or `DataKeyStore.rewrap` (`kek_id <> active`) never moves a row.
  Date/Author: 2026-11-14 / research agent
- Decision: `KeyProvider.hasKek` is removed; the composite provider routes by KEK id prefix.
  Rationale: its only caller is its own unit test (research finding 2; still true on main).
  Date/Author: 2026-11-14 / research agent
- Decision: key-provider health is not part of `/readyz`.
  Rationale: a provider outage would mark every replica unready and take down sign-in and every route that does not need a key.
  Date/Author: 2026-11-14 / research agent
- Decision: rate limits move to an `UNLOGGED` Postgres table.
  Rationale: one shared limit across replicas with no new service; losing the table on crash or failover only resets limits.
  Date/Author: 2026-11-14 / research agent
- Decision: the setup token is minted once per installation under the existing setup lock; a CLI rotates it; Kubernetes manifests set `SETUP_TOKEN_IN_LOG=false`.
  Rationale: replicas overwrote each other's token, and shipped logs are not a place for a secret.
  Date/Author: 2026-11-14 / research agent
- Decision: the server Deployment uses `strategy: Recreate`, and a boot guard refuses to start the queue while a live replica runs a different workflow bundle.
  Rationale: runs are not pinned to a bundle (see `Surprises & Discoveries`). Zero-downtime upgrades are out of scope.
  Date/Author: 2026-11-14 / research agent
- Decision (2026-11-15): the notification outbox needs no change for replicas; every replica reads the same `notify-webhook-secret` and `vapid-key.pem`, from one Secret on Kubernetes and from the shared `server-secrets` files on Compose.
  Rationale: rows are claimed with `SKIP LOCKED` and a lease (see `Surprises & Discoveries`); a replica with another VAPID key would break every subscription, and one with another webhook secret would send signatures the receiver refuses.
  Date/Author: 2026-11-15 / plan refresh
- Decision: on Kubernetes, agent pods get no DNS and reach the gateway through the `AGENT_GATEWAY_SERVICE_HOST` variable that Kubernetes injects for Services in the same namespace; the gateway runs in `os-agents`.
  Rationale: keeps the v0.1 gate "an agent cannot resolve internal names" meaningful.
  Date/Author: 2026-11-14 / research agent
- Decision: kind v0.33.0 with kindnet's built-in NetworkPolicy, not k3d.
  Rationale: kind runs upstream Kubernetes (`kindest/node:v1.37.0`) and enforces policies out of the box since v0.24.0.
  Date/Author: 2026-11-14 / research agent
- Decision (2026-11-15): the control host gets the signer's request secret, and each host its
  certificates, from `/import`, a directory the operator fills (`SIGNER_HOST_FILES`,
  `CONTROL_HOST_FILES`); `init --domain=control` refuses to start without the request secret and
  never makes one. The confirm secret, the token key and the vault passphrase have no way off the
  signer host.
  Rationale: one documented copy step per host, and no secret in the environment or on a command
  line.
  Date/Author: 2026-11-15 / MultiM1Split
- Decision (2026-11-15): `signerAdminCommand` is an optional member of the workspace response, set
  for owners only (like `pendingPasskeys`), checked against one pattern
  (`SignerAdminCommand` in `@askgina/os-api`) by the server at boot and by the web app before it
  builds a command.
  Rationale: additive for every other producer of the response; a non-owner has no use for how the
  operator reaches the signer host.
  Date/Author: 2026-11-15 / MultiM1Split
- Decision (2026-11-15): each edge serves its own origin from `SITE_ADDRESS`/`APPROVE_SITE_ADDRESS`
  set to `PUBLIC_ORIGIN`/`APPROVE_ORIGIN`, on ports 80 and 443, from its own Caddyfile in
  `deploy/split/`; the signer project's edge is named `caddy`, as on one machine, so the gate
  "the confirmation service reaches the signer and nothing else" holds unchanged.
  Rationale: an https origin gets its certificate from Caddy, a plain one (the e2e run) serves on
  its own port; no TLS overlay per host.
  Date/Author: 2026-11-15 / MultiM1Split

## Outcomes & Retrospective

- Outcome (2026-11-15, final): Milestones 1 to 7 are built on private `main` and green in CI.
  Evidence: run 43744005029 at `388386d`, all twelve jobs: check, test, ui, packages,
  `stack` amd64, arm64, tls, split, replicas and openbao, `k8s` and `k8s-ha`. That supersedes
  every "CI pending" and "not run" in `Progress`.
  Measured by `k8s-ha` on kind (three CloudNativePG instances, a synchronous standby
  required): the primary was deleted while a payment was being signed; a standby was primary
  after 19.8 s; the payment confirmed after 26.6 s with exactly one transaction; three
  instances were ready again after 30.7 s and both server replicas after 31 s; every LISTEN a
  replica held was back and both held the bundle lock, which answers the open question about
  the World's listeners; a key shred on one replica was heard by the other in 0.2 to 0.3 s;
  with both standbys gone a write waited 35.9 s and landed 3 s after a standby was allowed
  back. `stack (replicas)`: the survivor finished a payment whose signing replica was killed,
  with one transaction. `stack (openbao)`: a 20-second OpenBao outage failed closed and
  recovered; rotation and rewrap kept old data readable.
  Fix rounds on the way: a base64url value starting with a dash in the enroll command;
  Kustomize running generators before components; a chown of a read-only root in the secrets
  script; OpenBao's first `sys/init` on Raft needing more than five seconds; a gate that
  approved before its notification could be sent.
  Unproven: two real hosts under different administrators (CI runs both Compose projects on
  one runner); a certificate from a public authority on the split edges; a production
  Kubernetes cluster and its CNI (the probe must pass after every install); release gates
  beyond the payment path on Kubernetes; cloud KMS providers (not built); a Postgres failover
  under real load.

- Outcome (2026-11-14): Milestone 2, the restore fence, is built and passes its unit tests locally (`apps/signer/test/fence.test.ts`, `apps/signer/test/admin.test.ts`). The rest of this plan is not built.
  Remaining: the restore gate on the real stack in CI; every other milestone.
- Outcome (2026-11-15): Milestone 2 is delivered and CI-green. Built in `018d2f5`; mandates (`b60495d`) made every move of the fence revoke every live mandate.
  Evidence: CI run 43710836888 at `98cc6a1`: job `test` passes `apps/signer/test/fence.test.ts` (10 tests) and `apps/signer/test/admin.test.ts` (4 tests); `stack (amd64)` and `stack (arm64)` pass `e2e/test/release-gates.spec.ts:753` ("a restored and fenced backup …") and `:1741` ("the operator's restore fence ends every live mandate"), 32 passed in `stack (amd64)`.
  Remaining: Milestones 1 and 3 to 7. Nothing else in this plan is built; no other plan built any of it.

## Context and Orientation

Relevant repo rules:

- Read `AGENTS.md` at the repository root before changing files. `docs/references/` is context, not authority.
- The owner's standing rule reserves local builds, whole test suites, coverage and `e2e/run.sh` for CI unless he names the command (`specs/agent-workspaces-v0.1.md:109-110`). Locally: `bun run check`, `bunx tsc --noEmit` in one package, and single test files.
- Every claim in a status update says whether it is written, type-checked, single-test-passed, CI-green or unproven.

Terms used here (the product's terms are in `docs/architecture.md`, "Words used on this page"):

- **Trust domain**: a set of secrets and state that only one group of administrators controls. Today there are two: the control plane (server, Postgres, keyring, notification webhook secret, VAPID key) and the signer (vault, SQLite, token key, vault passphrase, the two request secrets, and the `approve` service's read-only copy of the confirm secret).
- **Confirmation page**: the page at `APPROVE_ORIGIN`, served by the keyless `approve` service, where every passkey approval is made. The signer accepts an approval only when the browser made it there, top-level.
- **Split deployment**: the signer (and, under D7, the confirmation page) on one host, the control plane on another, each with its own administrators and backups.
- **Restore fence**: a time recorded in the signer's database; the signer refuses every envelope issued before it, and every move of it ends every live mandate.
- **Mandate**: an approval in advance, held and counted by the signer, under which it signs an agent's transfers with no person asked (`specs/approval-mandates.md`).
- **Key provider**: the code behind `KeyProvider` that wraps and unwraps data keys under a key-encryption key (KEK).
- **Replica**: one server process; several share one Postgres.
- **CNPG**: CloudNativePG, the Kubernetes operator for Postgres clusters.

Current behavior (each line is source-read on main at `2911c20`):

- The signer serves plain HTTP on `0.0.0.0:8787` (`apps/signer/src/main.ts:50`) and relies on two Docker `internal` networks: `signing` to the server and `approve-signer` to the `approve` service (`compose.yaml:76,237-244`).
- The `approve` service serves the confirmation page on port 8788, holds only `confirm-request-secret` (`APPROVE_SIGNER_SECRET_FILE`), and reaches the signer's four confirm-scope routes with `createConfirmClient`, which accepts a `fetch` (`apps/approve/src/config.ts:5-13`; `apps/approve/src/main.ts:20-25`; `packages/protocol/src/signer/client.ts:58,283`). Caddy publishes it as a second site and drops the `Cookie` header (`deploy/Caddyfile:28-39`).
- The signer refuses to start when the confirm secret equals the request secret, and when `SIGNER_APPROVAL_ORIGIN` is not under `WEBAUTHN_RP_ID` or equals `SIGNER_RETURN_ORIGIN` (`apps/signer/src/config.ts:136-159`).
- One `init` container writes every trust domain's secrets on one host: the keyring, `notify-webhook-secret`, `vapid-key.pem`, the shared `signer-request-secret`, `confirm-request-secret` and its `approve` copy (rewritten whenever it differs from the signer's), `token-key`, `vault-passphrase` and the Postgres password (`deploy/init/init.mjs:45-92`).
- The keyring is one JSON file read at boot by the server, the World target and the keys CLI (`apps/server/src/main.ts:30`; `packages/world/src/target.ts:53`; `packages/keys/src/cli.ts:59-68`). `KeyProvider` still has the four members the research found (`packages/keys/src/keyring.ts:8-15`), and `parseKeyringFile` still accepts any KEK id (`:36-39`).
- Per-process state that decides something: rate limits (`apps/server/src/mcp/gateway.ts:413-471`, client key from the last `X-Forwarded-For` entry at `:423-424`); the setup token, re-minted on every boot before setup (`apps/server/src/identity/setup.ts:21-33`); the data-key cache, where a shred evicts only locally (`packages/keys/src/data-key-store.ts:264-266`). Caches that only save work: MCP handlers (`gateway.ts:414,505-519`), chain clients and token metadata (`apps/server/src/execution/chains.ts:57-60`), time-zone formatters (`apps/server/src/notify/schedule.ts:62`).
- Coordinated in Postgres, so already shared by replicas: sessions and passkey sign-in ceremonies (`apps/server/src/identity/ceremonies.ts:42-56`); nonce reservations (`apps/server/src/execution/transactions.ts:109-165`); audit appends under `FOR NO KEY UPDATE` on the workspace row (`apps/server/src/audit.ts:55-72`); run starts (`apps/server/src/execution/approvals.ts:294`); opening a confirmation (`approvals.ts:452`); the setup step (`apps/server/src/identity/routes.ts:89`); migrations (`apps/server/src/db/migrate.ts:17-47`, now `0000` to `0007`, the last three being `0005_notifications`, `0006_push_subscriptions` and `0007_transaction_attempts`); the notification outbox (`apps/server/src/notify/outbox.ts:162-196`); stuck-transaction repricing, speed-up and cancel, serialized per approval by `pg_advisory_xact_lock` on `attempts:<approvalId>` (`lockAttempts`, `apps/server/src/execution/transactions.ts:332-336`; `apps/server/src/execution/repricing.ts`, which keeps no module-level state).
- One sweeper per process runs every 3 seconds: it wakes decided approvals, starts runs for orphaned requests and sends due notifications (`apps/server/src/execution/index.ts:23,57-127,144-151`).
- The Workflow queue is Graphile Worker 0.16.6 with in-process delivery for the only queue prefix, `jobLockStaleSeconds: 30` (`apps/server/src/execution/index.ts:139`; `apps/server/src/execution/workflow-runtime.ts:128`).
- Signer state is one SQLite file at schema version 6 (`apps/signer/src/db.ts`); mandates, their uses and the daily cap are counted there by the signer's clock (`apps/signer/src/mandates.ts:183-196`; `apps/signer/src/signer.ts:63,266`). The restore fence is built (`apps/signer/src/fence.ts`; `apps/signer/src/admin.ts` command `fence`; `signer.ts:381-386`).
- The signer's operator commands are `enroll-approver`, `verify-log`, `fence`, `list-mandates` and `revoke-mandate` (`apps/signer/src/admin.ts:12-35`). The UI shows only `enroll-approver`, hard-coded to Compose (`apps/web/src/lib/operator.ts:25`; `apps/web/src/routes/members.tsx:234`), built from `pendingPasskeys` in the members response (`packages/api/src/dto.ts:160-173`).
- The server reaches the internet for RPC, the notification webhook and Web Push (it sits on the non-internal `control` and `chain` networks, `compose.yaml:120`).

How the pieces fit together after the plan (D7 (a)):

```text
 people  --HTTPS PUBLIC_ORIGIN-->  edge (Caddy or ingress)  -->  server replicas  -->  Postgres (single, or CNPG primary)
 people  --HTTPS APPROVE_ORIGIN-->  approve edge (signer host)  -->  approve  ==mutual TLS + confirm HMAC==>  signer
 agents  -->  agent-gateway (os-agents)  --/mcp-->  server replicas
 server replicas  --wrap/unwrap-->  OpenBao Transit (optional; otherwise the keyring file)
 server replicas  ==mutual TLS + control HMAC==>  signer (own host; SQLite and OWS vault; no outbound)
 server replicas  --HTTPS-->  webhook receiver, push services (when configured)
```

Assumptions:

- Hosts in a split deployment keep clocks within 30 seconds (NTP). The request signature allows 60 seconds and the fence uses 30. The signer host's clock alone decides mandate windows and lifetimes, the daily cap and the fence (`deploy/README.md:260`).
- The signer host has local block storage. SQLite over a network file system is not supported.
- Under D7 (a), the signer host accepts HTTPS from people on `APPROVE_ORIGIN` through its own edge, and DNS for that name points at it. The subdomain layout is the only one that fits: the port layout puts `APPROVE_ORIGIN` on `OS_HOSTNAME`, which names the control host (`deploy/README.md:15-34`).
- Postgres poolers, if any, run in session mode: migrations take session advisory locks and Graphile uses `LISTEN`.
- The operator runs OpenBao themselves; this plan does not deploy or operate OpenBao.

## Plan of Work

Milestones are ordered by D1 (a), taken 2026-11-15. Milestone 2 is delivered. Milestones 3 and 4 are independent of each other. Milestone 5 depends on 1 (external signer and `approve`) and 4 (replicas). Milestone 6 depends on 5.

### Milestone 1: The signer and the confirmation page on their own host

Scope: mutual TLS from the server and from the `approve` service to the signer, one `init` per trust domain, a Compose file per host with the `approve` service and its edge on the signer's side (D7), the operator command shown for the signer host, and a CI job that runs the release gates across two Compose projects. First because it is the security gain.

Files and interfaces:

- `apps/signer/src/config.ts`: new variables `SIGNER_HOST` (default `0.0.0.0`), `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_CONTROL_CERT_FILE`, `SIGNER_TLS_APPROVE_CERT_FILE` (all four or none; otherwise `ConfigError("SIGNER_TLS_*: set all four or none")`), `SIGNER_HEALTH_PORT` (default `8789`, used only with TLS; not 8788, which the `approve` container uses). `SignerConfig` gains `host: string` and `tls: { cert: Buffer; key: Buffer; control: Buffer; approve: Buffer } | null`.
- `apps/signer/src/main.ts`: with `tls`, serve with `createServer: https.createServer` and `serverOptions: { cert, key, ca: [control, approve], requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }` (supported by `@hono/node-server` 2.1.8), plus a second plain listener on `127.0.0.1:SIGNER_HEALTH_PORT` whose Hono app answers only `GET /healthz`. Without `tls`, unchanged. At start, log `signer.tls_expiry` with the days left on every certificate; refuse to start if any has expired.
- `apps/signer/src/index.ts`: with `tls`, the request-signature check first maps the verified peer certificate (SHA-256 of its DER) to a scope, `control` or `confirm`, and refuses with `unauthenticated` a request whose route scope differs, before the HMAC is checked. The scope table and the HMAC code are unchanged.
- `apps/server/src/config.ts`: `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_PEER_CERT_FILE`. An `https:` `SIGNER_URL` requires all three; an `http:` one refuses them (a half-configured split fails at boot, not silently in clear text). `SIGNER_ADMIN_COMMAND` (default `docker compose exec signer node src/admin.ts`).
- `apps/approve/src/config.ts` and `apps/approve/src/main.ts`: the same three `APPROVE_TLS_*` variables with the same rule; pass `fetch: createSignerFetch(...)` to `createConfirmClient`.
- `packages/protocol/src/signer/transport.ts` (new, exported as a new Node-only subpath `@askgina/os-protocol/signer-transport` in `packages/protocol/package.json` `exports`, so nothing importing `./signer` pulls in undici): `createSignerFetch(tls, servername): typeof fetch` built from `undici` 8.12.4 (`Agent({ connect: { cert, key, ca: [peerCert], servername, minVersion: "TLSv1.3" } })` with undici's own `fetch`, so the dispatcher and fetch come from one package). Used by the server and by `approve`. Add `"undici": "8.12.4"` to `packages/protocol/package.json`. (The draft put it in the server; the `approve` service needs it too.)
- `apps/server/src/main.ts`: pass `fetch: createSignerFetch(...)` to `createSignerClient` (`packages/protocol/src/signer/client.ts:58`).
- `packages/api/src/dto.ts` (the members response, `pendingPasskeys` at `:160-173`) and `apps/web/src/lib/operator.ts:15-31`, `apps/web/src/routes/members.tsx:234`: the members response carries `signerAdminCommand`; `enrollApproverCommand` takes it as its prefix instead of the hard-coded Compose text, and checks it against a fixed pattern (words of `[A-Za-z0-9_./:-]` separated by single spaces) because it is pasted into a root shell.
- `deploy/init/init.mjs`: `--domain=all|control|signer` (default `all`, today's behaviour). `signer` writes `/secrets/signer/*` and the `approve` copy of the confirm secret. `control` writes the keyring, `notify-webhook-secret`, `vapid-key.pem`, the server's copy of the Postgres password and the db secret, and requires `signer-request-secret` to be present already (copied from the signer host), never generating a second one. The confirm secret never leaves the signer host.
- `deploy/split/make-peer-certs.sh` (new): three `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 730` invocations (`CN=os-signer` with `subjectAltName=DNS:<signer host>,DNS:signer`, `CN=os-control`, `CN=os-approve`), files written `0400`, SHA-256 fingerprints printed.
- `deploy/split/signer.compose.yaml` (new): `init` (`--domain=signer`), `signer` with the TLS variables and `ports: ["${SIGNER_BIND_ADDRESS}:8787:8787"]` on the private interface, `approve` with its TLS variables and `SIGNER_URL=https://signer:8787` on the internal `approve-signer` network, and an edge (Caddy, the `APPROVE_ORIGIN` site block of `deploy/Caddyfile`, ports 80 and 443) on `approve-edge`. The hardening anchor from `compose.yaml`. `deploy/split/nftables-signer.conf` (new): example rules that drop outbound traffic from the signer's and `approve`'s bridges; only the edge container may reach the ACME server.
- `deploy/split/control.compose.yaml` (new): `postgres`, `server`, `caddy` (the `PUBLIC_ORIGIN` site only), `agent-gateway`, `anvil` via `extends` from `../../compose.yaml`, with `SIGNER_URL=https://${SIGNER_HOSTNAME}:8787`, the server's TLS files, `APPROVE_ORIGIN` set to the signer host's name, and no `signer` or `approve` service; `init` with `--domain=control`.
- `e2e/run.sh`, `e2e/src/stack.ts`: `E2E_SPLIT=1` brings up the two projects with an external network `os-e2e-wire` that only `server` and `signer` join, so nothing else connects them.
- `e2e/test/split.spec.ts` (new): the split-only gates below.
- `.github/workflows/ci.yml`: matrix entry `{ name: split, runner: ubuntu-latest, tls: "0", split: "1" }` in `stack` (today's entries are `amd64`, `arm64`, `tls`, `.github/workflows/ci.yml:113-115`).

Work:

The signer checks the peer certificate at the TLS layer, so an unauthenticated client never reaches the HTTP parser, and then binds the certificate to a scope. The control plane and the `approve` service check the signer's certificate and host name. All keep the HMAC signature. The health check moves to a loopback listener because the main port now requires a client certificate. Compose healthchecks in `deploy/split/signer.compose.yaml` call `http://127.0.0.1:8789/healthz`.

Acceptance:

- In CI job `test`: `apps/signer/test/tls.test.ts` passes: a client with the control certificate gets 200 from `GET /healthz` and a control-scope signed request through; the `approve` certificate gets a confirm-scope request through and is refused `unauthenticated` on a control-scope route, and the control certificate on a confirm route; no client certificate, an untrusted self-signed one, and plain HTTP each fail before any HTTP response; the health listener answers only `/healthz` and only on `127.0.0.1`; an expired certificate stops boot.
- In CI job `test`: `packages/protocol/test/signer-transport.test.ts` passes: a signer client using `createSignerFetch` completes a request to a TLS test signer and fails against one presenting another certificate. New `apps/server/test/support/signer-tls-config.test.ts` and `apps/approve/test/config.test.ts`: config refuses `https:` without the three files and `http:` with them.
- CI `stack (split)` is green: every release gate passes, including "the confirmation service reaches the signer and nothing else" (`e2e/test/release-gates.spec.ts:461`), and `e2e/test/split.spec.ts` shows that a container on `os-e2e-wire` without the control plane's key cannot complete a handshake with the signer; that the control project has no volume holding `token-key`, `vault-passphrase`, `confirm-request-secret` or the vault, and runs no `approve` service; and that the signer container cannot reach `https://example.com/` when the example nftables rules are applied.

### Milestone 2: The restore fence (delivered)

Delivered in `018d2f5` as a fix to v0.1, with the revocation of live mandates added by `b60495d`; CI-green in run 43710836888 (see `Outcomes & Retrospective`). What exists, for reference by later milestones:

- `apps/signer/src/fence.ts`: `readFence`, `raiseFence` (moves the fence forward, one decision-log entry per workspace, revokes every live mandate), `fenceReplacedDatabase` (fences a database file that is not the one recorded in `signer_meta`).
- `apps/signer/src/db.ts`: `signer_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`, keys `fence_at` and `database_file`, in schema version 2.
- `apps/signer/src/admin.ts`: `node src/admin.ts fence` (no `--at`), printing `{"ok":true,"action":"fence-set-by-operator","fenceAt":…}`.
- `apps/signer/src/signer.ts:381-386`: `envelope_fenced` for every envelope kind when `issuedAt < fence + 30`, checked before the replay check and again in the signing transaction.
- `packages/protocol/src/signer/api.ts`: `envelope_fenced` (403).
- `e2e/test/release-gates.spec.ts:753` and `:1741`; `deploy/README.md:118-178`; `docs/approval-protocol.md:385-428`; `docs/threat-model.md:245-262`.

What remains for the split: Milestone 1's move procedure relies on it (a moved database file fences itself), and Milestone 7 adds the move to the deploy guide.

### Milestone 3: Key providers and OpenBao Transit

Scope: a provider interface that allows network providers, an OpenBao Transit provider, a composite for migration, and CI against a real OpenBao. Depends on D2, taken as (a) OpenBao Transit. Unchanged by the work since the draft; the keyring still wraps only data keys, not the webhook secret or the VAPID key.

Files and interfaces:

- `packages/keys/src/keyring.ts`: `KeyProvider` becomes `{ ready(): Promise<void>; activeKekId(): string; wrap(kekId, dataKey, aad): Promise<Uint8Array>; unwrap(kekId, wrapped, aad): Promise<Uint8Array>; close(): Promise<void> }`. `hasKek` is removed with its test case (`packages/keys/test/keyring.test.ts:64-71`; run LSP references first). New exported errors `KeyProviderUnavailableError` (retryable) and `KeyProviderRefusedError` (permanent); messages carry ids and HTTP status, never key material or AAD bytes. `LocalKeyring.ready()` and `close()` resolve. `parseKeyringFile` refuses ids outside `^[A-Za-z0-9_-]+$`, so a file id can never be mistaken for a `bao:` id.
- `packages/keys/src/transit.ts` (new): `TransitKeyProvider`. Options: `address: URL`, `mount` (default `transit`), `key` (default `os-kek`), `auth: { kind: "token"; tokenFile } | { kind: "approle"; roleIdFile; secretIdFile } | { kind: "kubernetes"; role; jwtFile }`, `caFile?`, `timeoutMs` (default 2000), `refreshSeconds` (default 300). `ready()` logs in when needed and reads `GET /v1/<mount>/keys/<key>`; the active KEK id is `bao:<mount>/<key>@<latest>`. `wrap` calls `POST /v1/<mount>/encrypt/<key>` with `plaintext`, `associated_data` and `key_version`, checks the returned `vault:v<version>:` prefix, and stores the ciphertext as UTF-8 bytes. `unwrap` calls `POST /v1/<mount>/decrypt/<key>` with `ciphertext` and `associated_data` and checks for 32 bytes. Network errors, timeouts, 429, 5xx and 503 (sealed) throw `KeyProviderUnavailableError` after one retry with 100 to 300 ms jitter; 400 and 403 throw `KeyProviderRefusedError` (403 first triggers one re-login). Token renewal at two thirds of its TTL. Refresh is an unref'd timer.
- `packages/keys/src/composite.ts` (new): `CompositeKeyProvider({ active, legacy })`. Wraps only under `active.activeKekId()`; unwraps ids starting `bao:` with the Transit provider and bare ids with `LocalKeyring`.
- `packages/keys/src/providers.ts` (new): `keyProviderFromEnv(env, { keyringFileVariable }): KeyProvider`. `KEY_PROVIDER=file` (default) needs the keyring file variable; `KEY_PROVIDER=openbao` needs `OPENBAO_ADDR`, `OPENBAO_AUTH` and its files, and becomes a composite when the keyring file variable is also set.
- `packages/keys/src/data-key-store.ts`: `ensureMigrated()` also awaits `provider.ready()`.
- `packages/keys/src/cli.ts`, `packages/world/src/target.ts` (keyring variable `WORLD_KEYRING_FILE`), `apps/server/src/main.ts`, `apps/server/src/config.ts` (keyring variable `KEYRING_FILE`, now optional when `KEY_PROVIDER=openbao`): use the factory. `main.ts` closes the provider on stop.
- `deploy/openbao/policy.hcl` (new): `update` on `<mount>/encrypt/<key>` and `<mount>/decrypt/<key>`, `read` on `<mount>/keys/<key>`.
- `deploy/compose.test.yaml`: service `openbao`, image `quay.io/openbao/openbao:2.7.2` pinned by digest at implementation time, `server -dev -dev-root-token-id=test-root -dev-listen-address=0.0.0.0:8200`, port `127.0.0.1:55820:8200` (beside Postgres on 55432 and anvil on 55545, `deploy/compose.test.yaml:12,25`), healthcheck. `packages/testkit/src/openbao.ts` (new): enables Transit and creates the key idempotently; `pause()`/`unpause()` helpers using `docker pause`.
- `e2e/compose.openbao.yaml` (new) and a `stack` matrix entry `{ name: openbao, ... }`: OpenBao in dev mode on the `control` network, AppRole credentials written by a one-shot service, the server with `KEY_PROVIDER=openbao`.

Work:

Migration from the file keyring: set `KEY_PROVIDER=openbao` and keep `KEYRING_FILE`; restart; run `node packages/keys/src/cli.ts rewrap` until `failedCount` is 0; remove `KEYRING_FILE`; restart. Transit rotation: `bao write -f transit/keys/os-kek/rotate`; wait one `refreshSeconds` (or restart); run `rewrap`; then raise `min_decryption_version`.

Acceptance:

- In CI job `test`: `packages/keys/test/transit.test.ts` passes against the OpenBao service: round trip; a wrapped key presented with another row's AAD is refused with `KeyProviderRefusedError`; after rotation and `ready()` the active id ends `@2` and `rewrap()` returns `{ rewrapped: n, failed: [] }`; after `min_decryption_version=2` an old wrapped copy is refused; with OpenBao paused, `getOrCreate` rejects with `KeyProviderUnavailableError` within `timeoutMs + 500` ms and never resolves to a value; after unpause it resolves.
- In CI job `test`: `packages/keys/test/composite.test.ts` passes: keys created under `LocalKeyring` are readable through the composite, `rewrap` moves every row to `bao:`, and with the file removed every key still reads.
- In CI job `test`: `packages/world/test/ciphertext-at-rest.test.ts` runs for `file` and `openbao`: zero marker hits on the encrypting World and all ten on the stock World for both; a run with OpenBao paused for 20 seconds in the middle completes after unpause, and the test prints the delay for the record.
- CI `stack (openbao)` is green, including "a mandate's purpose is in no column of the database in the clear" (`e2e/test/release-gates.spec.ts:1122`), whose sealed content then sits under a Transit KEK.

### Milestone 4: A replica-safe control plane

Scope: the four things that still break with several replicas (research finding 7: rate limits, the setup token, the key cache and keyring rotation), the bundle guard, and a CI stack with two replicas. Already safe on main and left alone: nonce reservations, audit appends (now `FOR NO KEY UPDATE`), run starts, confirmation opening, the notification outbox (`SKIP LOCKED` and a lease), mandate counting (in the signer, one writer).

Files and interfaces:

- `packages/keys/src/data-key-store.ts`: `shred()` issues `pg_notify('os_keys_shred', scope || ':' || key_id)` in the same transaction as the tombstone. New option `listen?: boolean`; with it, `start()` holds one dedicated client on `LISTEN os_keys_shred` and evicts the named entry; on that client's error it clears the whole cache and reconnects with backoff; `close()` releases it. The TTL stays the upper bound.
- `apps/server/src/config.ts`: `DATA_KEY_CACHE_SECONDS` (default 60, 0 to 600), `FORWARDED_HOPS` (default 1, 1 to 5), `SETUP_TOKEN_IN_LOG` (default `true`; empty means unset).
- A new migration after the last one on main (`0007_transaction_attempts`, from stuck-transaction repricing; so `0008` today, or the next free number when this is built, generated with the repository's Drizzle workflow) and `apps/server/src/db/schema.ts`: `CREATE UNLOGGED TABLE IF NOT EXISTS os.rate_limits (bucket text PRIMARY KEY, tokens double precision NOT NULL, at timestamptz NOT NULL)`.
- `apps/server/src/rate-limit.ts` (new): `takeToken(db, bucket, perMinute): Promise<boolean>`, one `INSERT ... ON CONFLICT DO UPDATE ... WHERE <refilled tokens> >= 1 RETURNING tokens` statement; a missing row in the result means limited.
- `apps/server/src/mcp/gateway.ts`: the `buckets` and `failures` maps (`:413,416`) are replaced with `takeToken` on `agent:<id>` (120 per minute) and `auth-fail:<client>` (10 per minute, checked before the database lookup as today); `clientOf` (`:423-424`) takes the entry `FORWARDED_HOPS` from the end of `X-Forwarded-For`.
- `apps/server/src/identity/setup.ts`: `prepareSetup` mints only when no token row exists, inside `pg_advisory_xact_lock(SETUP_LOCK)` (the lock `apps/server/src/identity/routes.ts:89` already takes); it logs the token only when `SETUP_TOKEN_IN_LOG`, otherwise logs `setup.token_pending`. New `rotateSetupToken(ctx)`.
- `apps/server/src/cli.ts` (new): `node apps/server/src/cli.ts setup-token` rotates and prints the token on stdout of the command, not the server log.
- `apps/server/src/execution/bundle-guard.ts` (new): `holdBundleLock(pool, flowFile)`: SHA-256 of `flow.mjs`, low 31 bits as `objid`; takes `pg_advisory_lock_shared(18680, objid)` on a dedicated client; refuses with `BundleMismatchError` if `pg_locks` shows a granted advisory lock with `classid = 18680` and another `objid`. Called by `startBackground` (`apps/server/src/execution/index.ts:133-160`) before `world.start()`; on the client's loss it re-acquires and re-checks before the queue keeps running.
- `apps/server/src/http/app.ts`: `GET /readyz`, 200 when `SELECT 1` succeeds and the World has started, else 503. `/healthz` unchanged.
- `apps/server/src/execution/transactions.ts`: log `step.started` with `approvalId`, `step` and `replica` (host name) when the signing step begins (`signOnce`). Identifiers only.
- `deploy/init/rotate-keyring.mjs`: `add` adds an inactive key (today it also activates it, `:8-9`); new `activate <id>`. `deploy/README.md` rotation becomes: add, restart every replica, activate, restart every replica, rewrap, prune, restart every replica.
- `deploy/Caddyfile` (the `PUBLIC_ORIGIN` site, `:9-23`) and `deploy/Caddyfile.agents`: Caddy's `dynamic a` upstream for `server` on port 3000, so every replica receives requests.
- `e2e/compose.replicas.yaml` (new): `server: { deploy: { replicas: 2 } }`. `e2e/test/replicas.spec.ts` (new). A `stack` matrix entry `{ name: replicas, ... }`.

Work:

Nothing else in the server keeps per-process state that decides anything (see `Context and Orientation`). The sweeper runs in every replica; that is accepted (research finding 7.7): its workflow writes are conditional, starts are serialized per run, and notification rows are claimed with `SKIP LOCKED`, so N sweepers are N times the polling. Every replica must read the same `notify-webhook-secret` and `vapid-key.pem` (plan decision above). The in-flight stuck-transaction work adds a repricing path to the control plane; when it lands, re-check that its state is in Postgres or in the signer and add it to the list above.

Acceptance:

- In CI job `test`: `packages/keys/test/data-key-store.test.ts` gains "a shred in one store is seen by another within one second": two stores on one database cache a workspace key; after `shred` in the first, the second's `getOrCreate` rejects with `DataKeyUnavailableError` within 1 s.
- In CI job `test`: `apps/server/test/support/rate-limit.test.ts` (new): two app instances on one database; 120 requests for one agent split across them pass and the 121st within the minute gets 429; the failed-authentication limit is shared the same way; `FORWARDED_HOPS=2` charges the second-to-last address.
- In CI job `test`: `apps/server/test/identity/identity.test.ts` gains "two boots at once mint one setup token".
- In CI job `test`: `apps/server/test/execution/workflow.test.ts` gains "a second start with another workflow bundle is refused while the first runs, and the same bundle is accepted".
- CI `stack (replicas)` is green: every release gate passes against two replicas, and `e2e/test/replicas.spec.ts` passes: after an approval, the replica that logged `step.started` for it is killed with `docker kill`, and the intent is `confirmed` with exactly one transaction within 90 seconds; exactly one `setup.token_issued` line exists across both replicas; the webhook receiver gets each delivery id of one approval exactly once while both replicas sweep (the gate at `e2e/test/release-gates.spec.ts:1611`, "an approval is announced once …", already checks the single-replica case).

### Milestone 5: Kubernetes manifests proven on kind

Scope: Kustomize manifests for the control plane, NetworkPolicies, an e2e driver for Kubernetes, and a CI job on kind. Depends on D3 (a) Kustomize, D4 (a) signer and `approve` outside the cluster in production and D8 (a) TCP 443 egress while notifications are configured, all taken 2026-11-15, and on milestones 1 and 4.

Files and interfaces (all new unless stated):

- `deploy/k8s/base/kustomization.yaml`, `namespaces.yaml`: namespaces `os` and `os-agents`, both labelled `pod-security.kubernetes.io/enforce: restricted`.
- `deploy/k8s/base/server.yaml`: Deployment `server` (2 replicas, `strategy: Recreate`, `terminationGracePeriodSeconds: 10`, non-root, read-only root file system, all capabilities dropped, `seccompProfile: RuntimeDefault`, labels `sidecar.istio.io/inject: "false"` and annotation `linkerd.io/inject: disabled`, readiness `/readyz`, liveness `/healthz`); environment from ConfigMap `os-server` with `SETUP_TOKEN_IN_LOG=false` and `APPROVE_ORIGIN`; files from Secret `os-server-secrets` (operator-created; names documented: keyring, `signer-request-secret`, `postgres-password`, `notify-webhook-secret`, `vapid-key.pem`, the TLS files); Service `server` on 3000.
- `deploy/k8s/base/edge.yaml`: Caddy Deployment and Service with `deploy/k8s/base/files/Caddyfile`, which is the `PUBLIC_ORIGIN` site block of `deploy/Caddyfile` only. `deploy/k8s/base/agents.yaml`: `agent-gateway` Deployment, Service and `files/Caddyfile.agents` in `os-agents`. `deploy/k8s/test/files.test.ts` checks that `files/Caddyfile` equals the first site block of `deploy/Caddyfile` and `files/Caddyfile.agents` equals `deploy/Caddyfile.agents`, byte for byte.
- `deploy/k8s/base/network-policies.yaml`: default deny (ingress and egress) in both namespaces; agent pods (`os.askgina/role: agent`) egress only to gateway pods on 80, no DNS; gateway egress only to server pods in `os` on 3000; server ingress from edge and gateway pods on 3000; server egress to Postgres pods on 5432, to the signer (component-specific), to DNS, to RPC and OpenBao endpoints by CIDR (a list the operator fills in), and, under D8 (a), to TCP 443 anywhere when the webhook or Web Push is configured; edge ingress from anywhere on 8080 and egress to server.
- `deploy/k8s/components/signer-in-cluster/`: namespace `os-signer`; StatefulSet `signer` with 1 replica and a `volumeClaimTemplate` with `accessModes: [ReadWriteOncePod]`; Deployment `approve` and an `approve-edge` Caddy serving the `APPROVE_ORIGIN` site block; Secrets `os-signer-secrets` and `os-approve-secrets` (the confirm secret only); policies: signer ingress only from `os` server pods and `approve` pods on 8787, no egress; `approve` ingress only from `approve-edge`, egress only to the signer. A header comment states D4: for CI and evaluation only.
- `deploy/k8s/components/signer-external/`: server egress to `SIGNER_CIDR` on 8787; `SIGNER_URL` and the TLS files in `os-server-secrets`; `APPROVE_ORIGIN` names the signer host's confirmation page (Milestone 1).
- `deploy/k8s/components/postgres-single/`: a one-replica Postgres 18 StatefulSet (image digest as in `compose.yaml:30`) for kind; ingress from server pods only.
- `deploy/k8s/components/dev-chain/`: anvil (image digest as in `compose.yaml:204`); server egress to it.
- `deploy/k8s/overlays/kind/` (base, signer-in-cluster, postgres-single, dev-chain) and `deploy/k8s/overlays/production-example/` (base, signer-external, CNPG from milestone 6).
- `deploy/k8s/isolation-probe.yaml`: a Job operators run after install; it runs the same checks as the e2e gate and exits non-zero on any reachable target.
- `e2e/src/driver.ts`: `interface StackDriver { origin: string; approveOrigin: string; databaseUrl(): Promise<string>; chainUrl(): Promise<string>; setupToken(): Promise<string>; kill(service: string, which?: string): Promise<void>; logs(service: string): Promise<string>; runAsAgent(script: string, env: Record<string, string>): Promise<{ code: number; output: string }>; signerAdmin(args: string[]): Promise<string>; capabilities: Set<"backup" | "compose-networks" | "kubernetes"> }` with `compose` (the code now in `e2e/src/stack.ts`) and `k8s` (`kubectl port-forward`, `kubectl delete pod --grace-period=0 --force`, `kubectl logs`, `kubectl run` in `os-agents`, `kubectl exec ... node apps/server/src/cli.ts setup-token`, `kubectl exec` into the signer for `fence` and `revoke-mandate`).
- `e2e/test/release-gates.spec.ts`: gates declare the capabilities they need; gates needing `backup` or `compose-networks` are skipped on Kubernetes with a stated reason. The operator-command gates (`:1474`, `:1741`) use `signerAdmin`.
- `e2e/test/kubernetes.spec.ts`: an agent pod cannot resolve `server.os.svc.cluster.local`, gets 401 from `http://$AGENT_GATEWAY_SERVICE_HOST/mcp`, 404 for the API, the UI and the delivery routes, and cannot reach the internet; a pod in `os` without the server label cannot reach the signer on 8787; the `approve` pod reaches the signer and nothing else; `kubectl exec` into the signer cannot reach anything; the server pod has exactly one container; a NetworkPolicy deleted on purpose makes the probe Job fail (the probe is not blind).
- `.github/workflows/ci.yml`: job `k8s` on `ubuntu-latest`: install kind v0.33.0 and kubeconform v0.8.0 with checksums; `kubectl kustomize deploy/k8s/overlays/kind | kubeconform -strict -summary -kubernetes-version 1.37.0`; `kind create cluster --image kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`; build the server, signer, `approve` and scripted-agent images; `kind load docker-image`; create the Secrets from a script that reuses `deploy/init/init.mjs` output; `kubectl apply -k deploy/k8s/overlays/kind`; wait for rollout; `E2E_DRIVER=k8s ./e2e/run.sh`.

Work:

Server, signer, `approve` and gateway images are the Compose ones. The kind overlay runs the signer and `approve` in the cluster only because CI has one machine. Production uses `signer-external`.

Acceptance:

- In CI job `test`: `deploy/k8s/test/files.test.ts` passes.
- CI `k8s` is green: kubeconform passes; every applicable release gate passes with `E2E_DRIVER=k8s`, including the browser gates that approve on the confirmation page; `e2e/test/kubernetes.spec.ts` passes; the replica crash gate of milestone 4 passes with `kubectl delete pod`.

### Milestone 6: HA Postgres with CloudNativePG

Scope: a three-instance Postgres with synchronous replication on kind, and two gates on lost and kept commits. Depends on D6 (a) CloudNativePG with `dataDurability: required`, taken 2026-11-15, and milestone 5.

Files and interfaces:

- `deploy/k8s/components/cnpg/cluster.yaml` (new): `Cluster os-db`, `instances: 3`, `postgresql.synchronous: { method: any, number: 1, dataDurability: required }`, `postgresql.parameters.max_connections: "200"`; the server's `DATABASE_URL` points at `os-db-rw.os.svc:5432` and `DATABASE_PASSWORD_FILE` at the CNPG application Secret's `password` key.
- `deploy/k8s/components/cnpg/network-policies.yaml` (new): instance ingress on 5432 from server pods and from the other instances (`cnpg.io/cluster: os-db`), on 8000 from the operator namespace `cnpg-system`; instance egress to the other instances and to the Kubernetes API.
- `deploy/k8s/overlays/kind-ha/` (new): the kind overlay with `cnpg` instead of `postgres-single`.
- `.github/workflows/ci.yml`: job `k8s` gains a matrix `db: [single, cnpg]`; for `cnpg`, install the CloudNativePG v1.30.1 release manifest pinned by SHA-256 before applying.
- `e2e/test/postgres-ha.spec.ts` (new, `kubernetes` capability): record the audit head through the API; propose and approve; when `step.started` appears, delete the primary pod with `--grace-period=0 --force`; expect `confirmed` and exactly one transaction within 180 seconds, `verifyAudit` ok, the audit sequence at least the one recorded plus the events the API acknowledged before the failover, the approval's notification row present and sent once, and no server pod restarted.
- `e2e/test/release-gates.spec.ts` (Compose, `backup` capability): new gate "a database rolled back to before the signature, with a current signer, ends in one transaction": snapshot `postgres-data` after the approval opens, approve, wait for `confirmed`, stop, restore only `postgres-data`, start, approve again; the signer returns the stored transaction, the chain shows one transfer, and the audit chain verifies. A rolled-back database may also hold a mandate the signer has since revoked, or miss one it granted; the gate checks the mandate list after the restart matches what the signer reports for the workspace.

Work:

The server already reconnects idle clients (`apps/server/src/main.ts:26-27`), and Graphile polls every 500 ms (`queue.js:1159`). Whether the World's run-status and stream listeners reconnect on their own is unknown; the failover gate settles it. If they do not, the fix goes upstream or into `packages/world`, and this milestone records it.

Acceptance:

- CI `k8s (cnpg)` is green, including `e2e/test/postgres-ha.spec.ts`.
- CI `stack (amd64)` is green with the rolled-back-database gate.

### Milestone 7: Documentation matches the code

Scope: the threat model, architecture, protocol and deployment guide describe what milestones 1 and 3 to 6 built, and a test keeps configuration and documentation in step. The restore fence is already documented (`docs/approval-protocol.md:385-428`; `docs/threat-model.md:245-262,600-608`; `deploy/README.md:118-178`).

Files and interfaces:

- `docs/threat-model.md`: "One machine running everything gives no protection against that machine" (`:564-566`) gains the two-host form and where the confirmation page runs; new limits for Kubernetes (Secrets in etcd, policies need an enforcing CNI, no `localhost` blocking, server egress under D8), the key provider row, and lost commits under asynchronous replication; "Out of scope for v0.1" (`:628`) loses the multi-machine line.
- `docs/architecture.md`: "Where state lives" gains OpenBao as a KEK location; "Components and what each may reach" gains the NetworkPolicy table and the split layout.
- `docs/approval-protocol.md`: section 10 states that between hosts requests travel inside mutual TLS and that each client certificate is bound to one scope.
- `deploy/README.md`: "Signer on its own machine" (including the `approve` service, its edge and DNS for `APPROVE_ORIGIN`), moving an existing install (a move fences and ends every live mandate), "OpenBao", "Several server replicas" (one webhook secret and VAPID key for all), two-phase keyring rotation, and a pointer to `deploy/k8s/`.
- `apps/server/test/support/config-docs.test.ts` (new): every variable accepted by `apps/server/src/config.ts`, `apps/signer/src/config.ts` and `apps/approve/src/config.ts` appears in `deploy/README.md`, `apps/approve/README.md` or `docs/`, and every `SIGNER_*`, `APPROVE_TLS_*`, `OPENBAO_*`, `KEY_PROVIDER`, `FORWARDED_HOPS`, `SETUP_TOKEN_IN_LOG` and `DATA_KEY_CACHE_SECONDS` named there exists in a schema.

Acceptance:

- In CI job `test`: `apps/server/test/support/config-docs.test.ts` passes. CI `check` passes.

## Interfaces and Dependencies

Local interfaces:

- `KeyProvider` (`packages/keys/src/keyring.ts`): `ready(): Promise<void>`; `activeKekId(): string`; `wrap(kekId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array>`; `unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array>`; `close(): Promise<void>`. Every failure throws `KeyProviderUnavailableError` or `KeyProviderRefusedError`; nothing resolves to "no key".
- KEK id grammar: Transit ids match `^bao:[a-z0-9/_-]+@[1-9][0-9]*$`. `LocalKeyring` ids must match `^[A-Za-z0-9_-]+$`; today `parseKeyringFile` accepts any string (`packages/keys/src/keyring.ts:36-39`), so it gains that check, and the ids `rotate-keyring.mjs` writes (`k1`, `k2`, ...) already pass it.
- `DataKeyStoreOptions` (`packages/keys/src/data-key-store.ts`): adds `listen?: boolean`. Channel `os_keys_shred`, payload `<scope>:<keyId>`.
- `createSignerFetch(tls: { cert: Buffer; key: Buffer; peerCert: Buffer }, servername: string): typeof fetch` (`@askgina/os-protocol/signer-transport`, new). Fails as `fetch` fails: a handshake refusal rejects the promise, exactly as an unreachable signer does today (the signer client does not catch it, `packages/protocol/src/signer/client.ts:149-175`).
- Signer scope binding: a verified client certificate maps to `control` or `confirm`; a mismatch with the route's scope is `unauthenticated` (401), the same code as a bad HMAC.
- Already built, used as is: `SignerErrorCode` `envelope_fenced` (403); signer table `signer_meta`; `node src/admin.ts fence`, `list-mandates`, `revoke-mandate`.
- Server CLI: `node apps/server/src/cli.ts setup-token`.
- Server HTTP: `GET /readyz` (200 or 503, body `{ ok: boolean }`).
- Postgres: `os.rate_limits` (UNLOGGED); advisory lock class `18680` for the bundle guard.
- Configuration, server: `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_PEER_CERT_FILE`, `SIGNER_ADMIN_COMMAND`, `KEY_PROVIDER`, `OPENBAO_ADDR`, `OPENBAO_TRANSIT_MOUNT`, `OPENBAO_TRANSIT_KEY`, `OPENBAO_AUTH`, `OPENBAO_TOKEN_FILE`, `OPENBAO_ROLE_ID_FILE`, `OPENBAO_SECRET_ID_FILE`, `OPENBAO_KUBERNETES_ROLE`, `OPENBAO_CA_FILE`, `OPENBAO_TIMEOUT_MS`, `DATA_KEY_CACHE_SECONDS`, `FORWARDED_HOPS`, `SETUP_TOKEN_IN_LOG`. Signer: `SIGNER_HOST`, `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_CONTROL_CERT_FILE`, `SIGNER_TLS_APPROVE_CERT_FILE`, `SIGNER_HEALTH_PORT`. `approve`: `APPROVE_TLS_CERT_FILE`, `APPROVE_TLS_KEY_FILE`, `APPROVE_TLS_PEER_CERT_FILE`. None of these exists on main today. Every default keeps today's single-machine Compose behaviour.

External dependencies:

- OpenBao 2.7.2 Transit secrets engine ([API](https://openbao.org/api-docs/secret/transit/)): `POST /v1/<mount>/encrypt/<key>` (`plaintext`, `associated_data`, `key_version`), `POST /v1/<mount>/decrypt/<key>` (`ciphertext`, `associated_data`), `GET /v1/<mount>/keys/<key>` (`keys`, `min_decryption_version`), `POST /v1/<mount>/keys/<key>/rotate`; auth `approle` and `kubernetes`. Constraint: `rewrap` has no `associated_data`; a sealed server answers nothing useful until unsealed. Image `quay.io/openbao/openbao:2.7.2`. Versions as of 2026-11-14, not re-checked.
- `undici` 8.12.4 (already in `bun.lock` as a transitive dependency): `Agent`, `fetch`.
- `@hono/node-server` 2.1.8 (pinned in `apps/server/package.json` and `apps/signer/package.json`): `serve({ createServer, serverOptions })` for HTTPS.
- `graphile-worker` 0.16.6 and `@workflow/world-postgres` 5.2.0: `jobLockStaleSeconds` must be equal on every process; deployment id is constant.
- kind v0.33.0 with `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`; kindnet NetworkPolicy via kube-network-policies (since kind v0.24.0). Not re-checked since 2026-11-14.
- kubeconform v0.8.0; Kustomize as built into `kubectl`.
- CloudNativePG v1.30.1: `spec.postgresql.synchronous` with `method`, `number`, `dataDurability`.
- `openssl` on the operator's machine for `deploy/split/make-peer-certs.sh`.

## Concrete Steps

Locally, only what the standing rule allows, from the repository root:

    bun run check
    (cd packages/keys && bunx tsc --noEmit)
    (cd packages/protocol && bunx tsc --noEmit)
    (cd apps/signer && bunx tsc --noEmit)
    (cd apps/approve && bunx tsc --noEmit)
    (cd apps/server && bunx tsc --noEmit)
    bunx vitest run apps/signer/test/tls.test.ts           # one file
    bunx vitest run packages/keys/test/transit.test.ts     # one file; needs `bun run services:up`

Everything else runs in CI on push:

    test                 # unit and package suites, OpenBao service included
    stack (amd64|arm64|tls|split|openbao|replicas)
    k8s (single|cnpg)

Evidence so far:

    CI run 43710836888 (98cc6a1), stack (amd64):
      ✓ test/release-gates.spec.ts:753:1 › a restored and fenced backup keeps wallets, refuses an approval used after the backup …
      ✓ test/release-gates.spec.ts:1741:1 › the operator's restore fence ends every live mandate
      32 passed

Expected evidence (to be recorded here when it exists):

    stack (split): release gates N passed; split.spec.ts 3 passed
    k8s (cnpg): postgres-ha.spec.ts 1 passed; audit verified; transactions 1

## Validation and Acceptance

Automated validation:

- `apps/signer/test/tls.test.ts`: in `test`. `apps/signer/test/fence.test.ts`: in `test`, green.
- `packages/protocol/test/signer-transport.test.ts`; `apps/server/test/support/rate-limit.test.ts`, `config-docs.test.ts`; `apps/server/test/support/signer-tls-config.test.ts`, `apps/approve/test/config.test.ts`; new cases in `identity.test.ts` and `workflow.test.ts`: in `test`.
- `packages/keys/test/transit.test.ts`, `composite.test.ts`; new case in `data-key-store.test.ts`; `packages/world/test/ciphertext-at-rest.test.ts` on both providers: in `test`.
- `deploy/k8s/test/files.test.ts`: in `test`.
- `e2e/test/split.spec.ts`: in `stack (split)`.
- `e2e/test/replicas.spec.ts`: in `stack (replicas)` and `k8s`.
- `e2e/test/kubernetes.spec.ts`: in `k8s`.
- `e2e/test/postgres-ha.spec.ts`: in `k8s (cnpg)`.
- The restore gate (green) and the rolled-back-database gate: in `stack (amd64)` and `stack (arm64)`.

Manual or runtime validation (cannot be automated):

- Two real hosts with different administrators run the split deployment: the control host has no account that can log into the signer host. Record who administers each. A person approves a payment on the signer host's confirmation page from a phone, and the control host's operator cannot change what that page shows.
- A real OpenBao with auto-unseal survives a restart of OpenBao while the stack runs; record the delay before runs resume.

Regression checks:

- Every release gate still passes in `stack (amd64)`, `stack (arm64)` and `stack (tls)` with default settings (single machine, file keyring, one replica), including the mandate and notification gates.
- The README quickstart still prints the setup token in the server log.

## Threat Model After the Change

| If this is compromised                                                                                                  | The attacker can                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The attacker cannot                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A control-plane replica, its host (split deployment) or its Kubernetes namespace                                        | Everything `docs/threat-model.md` lists under "Code execution in the control plane": ask the signer anything the control secret allows; read sealed content (through the keyring file, or by calling OpenBao with the server's token while it holds it); propose any operation, sweep, policy or approver change; link a person to the confirmation page of another waiting request; withhold approvals; have the signer sign, with no person, transfers it invents under a live mandate up to that mandate's worst case; revoke mandates or ignore a person's revocation; send notifications signed with the webhook secret and push messages under the VAPID key; pause | Produce an assertion at `APPROVE_ORIGIN`; change what the confirmation page shows (D7 (a): not on this host); exceed a policy cap or a mandate's limits; reuse an approval; grant a mandate; enroll an approver, move the fence or run `revoke-mandate` (CLI-only on the signer host); read the vault, the token key, the vault passphrase or the confirm secret (not on this host); reach the signer without the client key it holds anyway, or reach its confirm routes with that key |
| The network between control host and signer host                                                                        | Drop or delay traffic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Read intents or assertions, or replay a captured request (mutual TLS)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The confirmation page on the signer host (the `approve` service, its edge, DNS or the certificate for `APPROVE_ORIGIN`) | What `docs/threat-model.md` lists for a compromised `approve` service: show a false view and relay assertions over other digests, for the people who use the page meanwhile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Sign, read a key, open a confirmation or reach a control-scope route (its certificate is bound to the confirm scope); an escape from its container to the host is the signer host row                                                                                                                                                                                                                                                                                                   |
| OpenBao, or the server's OpenBao token                                                                                  | Decrypt every data key it is asked for; with a database copy, read all sealed content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Sign, approve or change policy; the signer does not use the keyring                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A Postgres replica, a CNPG backup or a WAL archive                                                                      | Read what database read access gives (`docs/threat-model.md`, "Read access to the control plane's database"); recover keys shredded after the backup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Read sealed content without the KEKs; make the signer sign                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Kubernetes cluster administration, signer and confirmation page outside the cluster                                     | Everything the control plane can                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Everything in the "cannot" column of the first row                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Kubernetes cluster administration, signer in the cluster (CI and evaluation only)                                       | Everything for every wallet (Secrets and the signer volume are in the cluster)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Nothing is protected                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The signer host                                                                                                         | Everything for the wallets on it, including enrolling approvers, setting the fence, revoking mandates and serving the confirmation page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Nothing is protected (unchanged)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The invariant holds in every row: whether a human approved is decided by the signer from passkey assertions it verifies itself, made top-level at `APPROVE_ORIGIN` (`docs/architecture.md`, "Why each boundary exists"), and the signer builds every transaction from the approved intent or from a transfer a live mandate it holds covers. The split adds refusals (certificate and scope) and removes none.

## Idempotence and Recovery

- `init --domain=...` never overwrites an existing secret (as today); `--domain=control` refuses to generate a request secret it should have received; `--domain=signer` rewrites the `approve` copy of the confirm secret whenever it differs, as `init` does today.
- `fence` sets the fence only forward; running it twice changes nothing (built).
- `rewrap` can be repeated; rows already under the active KEK are skipped; failures are reported and not fatal (`packages/keys/src/data-key-store.ts:202-256`).
- The rate-limit migration uses `IF NOT EXISTS`; the table can be truncated at any time.
- `kubectl apply -k` is idempotent. CNPG manages its own instances.
- Backout per milestone: TLS is off when the TLS variables are unset; `KEY_PROVIDER=file` with the keyring file restores the file provider while the composite still has both (do not remove the file until `rewrap` reported zero failures); one replica is the single-machine configuration; Kubernetes and CNPG are separate deploy targets and leave Compose untouched. Going back from a split to one machine is a move of the signer's volumes, so it fences too.
- Restoring the signer: stop it; restore `signer-data` and `signer-secrets` into empty volumes; run `fence`; start it; grant again the mandates people still want (`deploy/README.md:136-148`). Agents re-propose what was waiting.

## Rollout and Operations

- Feature flags/config/env vars: listed under `Interfaces and Dependencies`. Defaults keep today's behaviour.
- Split deployment steps: on the signer host, `init --domain=signer`, generate the three peer certificates, point DNS for `APPROVE_ORIGIN` at the host, start `deploy/split/signer.compose.yaml` (signer, `approve`, approve edge), apply the nftables example; copy `signer-request-secret`, the control certificate and key, and the signer certificate to the control host; there, `init --domain=control` and start `deploy/split/control.compose.yaml` with the same `APPROVE_ORIGIN`, `OS_HOSTNAME` (the RP ID, under which `APPROVE_ORIGIN` must sit) and `PUBLIC_ORIGIN` as before. Moving an existing single-machine install: wait until no request waits for approval, stop the stack, move `signer-data` and `signer-secrets` to the new host, run `fence`, start both sides; every live mandate has ended (D9), so people grant again the ones they want; the confirmation origin changes host but not name, so no passkey is enrolled again.
- Monitoring: log events `keys.provider_unavailable` (count and duration), `signer.tls_expiry` (days left, at start), `workflow.bundle_mismatch`, `setup.token_pending`; the signer's `restore fence set` with `reason: new_database_file` after a move; `/readyz` for load balancers and Kubernetes; Graphile job attempts above 5 for any run means it is backing off; `notification failed` lines per replica.
- Clock: NTP on both hosts; a skew above 60 seconds shows as `unauthenticated` signer refusals, which the server retries (`apps/server/src/execution/transactions.ts:96-100`); an `issuedAt` more than 30 seconds ahead of the signer is refused; mandates and the fence follow the signer host's clock only.
- Certificates: valid 730 days; rotation is "generate a new pair, copy, restart both sides". The `APPROVE_ORIGIN` web certificate is the approve edge's ACME certificate, renewed by it.

## Risks and Open Questions

- Risk: a key-provider outage leaves runs backing off for hours after it ends.
  Mitigation: the 20-second outage test in milestone 3 measures the delay; if long, add a bounded in-provider retry before throwing, or an operator command that resets the backoff of active runs. Alert on `keys.provider_unavailable`.
- Risk: OpenBao with a Shamir seal stays sealed after its restart.
  Mitigation: document auto-unseal; treat sealed as an outage.
- Risk: certificate expiry stops all signing, or all approving when the `approve` certificate expires.
  Mitigation: the expiry log at start and a refusal to start with an expired certificate, so it is seen at the next restart at the latest; a two-year validity.
- Risk: the signer is a single point of failure; approvals expire and mandates stop signing while it is down.
  Mitigation: accepted (D1, signer not replicated); restore with a fence; document the recovery time.
- Risk (new 2026-11-15): under D7 (a) the signer host takes HTTPS from the internet through the approve edge, and the edge needs outbound access for ACME.
  Mitigation: the signer and `approve` containers keep no outbound route (nftables example); only the edge reaches the ACME server; the edge holds no secret but its certificate. A container escape from the edge is the signer host case, which the threat model already treats as everything.
- Risk (new 2026-11-15): a move to a new host ends every live mandate and refuses every waiting approval (D9 (a)), which people may read as a failure.
  Mitigation: the move procedure says so first and asks to move while nothing waits; the control plane already shows ended mandates with reason `operator`.
- Risk (new 2026-11-15): the two hosts are upgraded at different times, so a newer control plane asks an older signer for something it does not know (a new envelope kind is refused as invalid, `docs/approval-protocol.md`, section 12), or an older signer image meets a newer database (`schema_too_new`).
  Mitigation: the deploy guide's split section upgrades the signer host first, then the control host, in one window; refused requests fail closed and are proposed again.
- Risk: a wallet created after the last signer backup is lost on restore, with its funds.
  Mitigation: document "back up the signer after creating a wallet and before funding it"; a later ticket can make the control plane show wallets created since the signer's last backup.
- Risk: NetworkPolicies are silently ignored by a CNI that does not implement them.
  Mitigation: `deploy/k8s/isolation-probe.yaml` must pass after every install; it fails when a policy is missing.
- Risk: a service mesh injects a sidecar into the server pod and reaches the loopback delivery listener.
  Mitigation: injection disabled by label and annotation; the Kubernetes gate checks the server pod has one container.
- Risk: synchronous replication pauses writes when no standby is available.
  Mitigation: accepted under D6 (a); three instances tolerate one loss.
- Risk: connection count grows with replicas (22 per replica by default, research finding; not re-counted after notifications).
  Mitigation: `max_connections: 200` in the CNPG cluster; document the formula; re-count when Milestone 4 is built.
- Risk: `Recreate` gives a short outage on every server upgrade.
  Mitigation: accepted; in-flight steps rerun after the restart; notification rows wait in the outbox.
- Risk: the `k8s` CI job is slow.
  Mitigation: measure on the first run; if needed run it on pushes to `main`, nightly, and on pull requests that touch `deploy/k8s/**`.
- Open question: whether the World's run-status and stream listeners reconnect after a Postgres failover. Owner/next step: milestone 6 gate.
- Answered (2026-11-15): stuck-transaction repricing, built on main at `61d0326`, keeps no per-process state that decides anything. Repricing, speed-up and cancel take `pg_advisory_xact_lock` on `attempts:<approvalId>` (`apps/server/src/execution/transactions.ts:332-336`) and store attempts in `0007_transaction_attempts`, so replicas already serialize on it; Milestone 4 needs no change for it.
- Answered (2026-11-15): D1 to D4 and D6 to D9 are taken as the recommended option (a) by the lead under Eric's delegation; see `Decision Log`.

## Artifacts and Notes

    docs/threat-model.md:564-566
      One machine running everything gives no protection against that machine. The network
      separation between server and signer protects only when they run on different hosts with
      separate administration. On one host, root on that host is the signer host case.

    specs/trusted-display.md, Risks and Open Questions
      Risk: the `approve` service is a new public surface, and its compromise reopens the display
      gap. Mitigation: ... on split hosts it runs with the signer (askgina/os#25).

    apps/server/src/notify/outbox.ts:162-164
      Due rows are claimed under `FOR UPDATE SKIP LOCKED` and leased for LEASE_SECONDS in one
      short transaction, then sent outside it, so passes that overlap never send a row twice

    @workflow/world-postgres 5.2.0 dist/config.d.ts:31-34
      Seconds a running delivery's Graphile job lock may go unrenewed before another process
      releases any of this World's jobs for redelivery. Use the same value on every process
      that shares the database

    https://kubernetes.io/docs/concepts/services-networking/network-policies/
      Creating a NetworkPolicy resource without a controller that implements it will have no effect.
      ... (Pods cannot currently block localhost access ...)

    https://openbao.org/api-docs/secret/transit/ (Rewrap data)
      Parameters: name, ciphertext, context, key_version, nonce, reference, batch_input
      (no associated_data)

## Revision Notes

- 2026-11-14: First draft, written from the research report for ticket #25. Nothing built.
- 2026-11-14: D5 taken (a). Milestone 2 built as a v0.1 fix, with two additions to the draft: the
  signer fences by itself when its database file was replaced, and its SQLite got `user_version`
  migrations. `fence` has no `--at`, and a fenced intent fails with `envelope_fenced`, not a new
  `approval_fenced`.
- 2026-11-15: Re-checked against main at `2911c20` after the trusted display, the v0.1 defect
  fixes, mandates and notifications landed. Milestone 2 is marked delivered and CI-green (run
  43710836888), and its old file list is replaced by what exists. D5's contradiction with the
  deploy guide is gone (the guide now fences every restore). Milestone 1 now places the keyless
  `approve` service, its edge and the confirm secret on the signer's side, gives the signer two
  client certificates bound to the two request scopes, moves `createSignerFetch` into
  `@askgina/os-protocol/signer-transport` so `approve` can use it, moves the signer's health port to 8789,
  and splits `init` with the webhook secret and VAPID key on the control side. Milestone 4 drops
  what is already replica-safe (notification outbox, audit appends, nonces, mandate counting) and
  stops naming a fixed migration number. Milestones 5 to 7 add the `approve` service, the new
  Secrets, notification egress and the operator-command gates. Context, threat table, risks and
  line references are updated to main; stale references fixed (`main.ts:50`, `gateway.ts:413-471`,
  `transactions.ts:109-165`, `execution/index.ts:139,144-151`, `approvals.ts:294`,
  `compose.yaml:30,204,237-244`, `init.mjs:45-92`, `verify-authorization.ts:53-54,128`,
  `threat-model.md:564-566`). New owner decisions D7 (where the confirmation page runs), D8
  (server egress on Kubernetes) and D9 (whether a planned move keeps mandates). Stuck-transaction
  repricing is in flight and not cited. Still Draft.
- 2026-11-15: D1 to D4 and D6 to D9 taken as the recommended options by the lead under Eric's
  delegation; the Decision Log, the owner-decisions Progress line, the milestone dependencies and
  the open questions say so. Repricing (#22) is built on main at `61d0326`: signer schema 6,
  server migrations through `0007_transaction_attempts`; Milestone 4's migration is `0008` today,
  and repricing's per-process-state question is answered (none; an advisory lock per approval).
