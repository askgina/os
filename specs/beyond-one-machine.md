# Run on more than one machine: the signer on its own host first, then key providers, replicas, Kubernetes and HA Postgres

- Branch: none yet
- Status: Draft
- Owner(s): Eric Juta
- Created: 2026-11-14
- Last Updated: 2026-11-14
- Links: [Ticket #25](https://github.com/askgina/os/issues/25) | [Map #18](https://github.com/askgina/os/issues/18) | [Research report](./research/beyond-one-machine.md) | [v0.1 plan](./agent-workspaces-v0.1.md)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current as research,
implementation, validation, and review proceed.
When the next milestone is clear, continue to it and update the spec instead of
asking for generic next steps.

## Purpose / Big Picture

v0.1 runs on one machine. Root on that machine is the signer host, so the separation between the control plane and the signer protects nothing against whoever administers it (`docs/threat-model.md:216-218`). This plan takes the product to several machines in the order that pays off first in security, then in availability.

After this plan:

1. An operator can run the signer on its own host, administered by different people, reached only over mutual TLS. A person who takes over the control-plane host can no longer enroll an approver, read the vault or exceed a policy, because none of that is on that host. This is the one step in the plan that improves security.
2. A signer restored from a backup, or moved to a standby host, cannot be made to sign an approval it already signed before the backup. The operator runs `fence` before starting it.
3. The control plane can keep its key-encryption keys in OpenBao Transit instead of a file, with a migration path from the file keyring.
4. The control plane runs as several replicas: crash one in the middle of a payment and the other finishes it with exactly one transaction.
5. The control plane installs on Kubernetes from Kustomize manifests, with NetworkPolicies that reproduce the Compose isolation as far as Kubernetes allows. Postgres can be a three-instance CloudNativePG cluster with synchronous replication.

Every step keeps the v0.1 invariant: the signer decides whether a human approved and signs only what was approved. The control plane is never trusted for that. Nothing in this plan moves a decision out of the signer or a key into the control plane.

Non-goals: replicating the signer; AWS or Google Cloud KMS providers (the interface is the contract; implementations are a later ticket); wallet keys in an HSM or cloud KMS; zero-downtime upgrades of the workflow bundle; autoscaling; service meshes; multi-region; Postgres HA outside Kubernetes (Patroni and similar); hosted or multi-tenant operation.

Success means:

- CI job `stack (split)` passes every release gate with the signer and the control plane in two Compose projects that share nothing but one network carrying mutual TLS, and proves the control project holds no signer secret.
- `apps/signer/test/fence.test.ts` shows a restored signer signs a used approval again without a fence and refuses it with `envelope_fenced` after one.
- CI job `stack (openbao)` passes every release gate with `KEY_PROVIDER=openbao`, and the World's ciphertext-at-rest test passes on both providers, including a 20 second OpenBao outage in the middle of a run.
- CI job `stack (replicas)` passes every release gate with two server replicas, plus a gate that kills the replica running a signing step and still ends in one transaction.
- CI job `k8s` installs the kind overlay, passes the Kubernetes isolation gates and the release gates that do not need Compose, and, on the CloudNativePG variant, survives a primary failover during a payment with one transaction and a whole audit chain.
- Out of scope and stays out: signer replication, cloud KMS adapters, zero-downtime workflow upgrades.

## Progress

- [x] (2026-11-14 21:38Z) Research current behavior and relevant code paths: [`specs/research/beyond-one-machine.md`](./research/beyond-one-machine.md).
- [ ] Owner decisions D1 to D6 (see `Decision Log`).
- [ ] Milestone 1: the signer on its own host.
- [ ] Milestone 2: the restore fence.
- [ ] Milestone 3: key providers and OpenBao Transit.
- [ ] Milestone 4: a replica-safe control plane.
- [ ] Milestone 5: Kubernetes manifests proven on kind.
- [ ] Milestone 6: HA Postgres with CloudNativePG.
- [ ] Milestone 7: documentation matches the code.
- [ ] Run validation in CI and record evidence.

## Surprises & Discoveries

- Observation: account-nonce reservations are control-plane state, not signer state. They live in `os.nonce_reservations` under a per-wallet, per-chain `pg_advisory_xact_lock`, so they already serialize across server replicas.
  Evidence: `apps/server/src/execution/intents.ts:648-697`; `specs/agent-workspaces-v0.1.md:153-155`.
- Observation: a signer restored from a backup older than its last signature forgets the used nonce, the approval and the spend, and signs the same authorization again (with any account nonce) while the envelope is unexpired, for up to 24 hours by default. `deploy/README.md:82-83` says waiting approvals "can still be approved after the restore", which is also how a person pays twice after a whole-stack restore of an older backup.
  Evidence: `apps/signer/src/signer.ts:716,756-768`; `apps/signer/src/config.ts:17`; research finding 6.
- Observation: OpenBao Transit's `rewrap` endpoint takes no `associated_data`, so AAD-bound data keys are rewrapped by decrypt and encrypt, which is what `DataKeyStore.rewrap` already does.
  Evidence: [Transit API](https://openbao.org/api-docs/secret/transit/), "Rewrap data" parameters.
- Observation: runs are not pinned to a workflow bundle. The Postgres World's deployment id is the constant `'postgres'`, and the approval workflow id has no content hash, so two replicas on different bundles can replay the same run with different code.
  Evidence: `@workflow/world-postgres` 5.2.0 `dist/queue.js:351-353`; generated `apps/server/.well-known/workflow/v1/manifest.json:84-87`.
- Observation: after a key-provider outage, a run can wait hours before its next attempt: Graphile's backoff is `exp(min(attempts, 10))` seconds, about 6 hours per attempt from the tenth, and core fails the run on delivery 49.
  Evidence: `@workflow/world-postgres` 5.2.0 `dist/queue.js:105-118`.
- Observation: Kubernetes NetworkPolicy cannot block `localhost` inside a pod and cannot hide Service names from DNS, so two Compose properties (the loopback-only delivery listener is private to one container; agents cannot resolve internal names) need other measures.
  Evidence: [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/); `e2e/test/release-gates.spec.ts:269-301`.
- Observation: with asynchronous replication, a lost commit removes an audit entry and the workspace's audit head together, so `verifyAudit` still passes and the loss is invisible; a lost shred commit brings a destroyed key back.
  Evidence: `apps/server/src/audit.ts:55-108`; `packages/keys/src/data-key-store.ts:264-275`; research finding 8.

## Decision Log

Owner decisions. Each is open; the plan is written for the recommended option and every milestone that depends on one says so.

- Decision D1 (owner, open): order of directions. Options: (a) signer split and fence first, then key provider, replicas, Kubernetes, HA Postgres; (b) Kubernetes first; (c) key provider first.
  Recommended: (a). Rationale: it is the only direction that changes what a compromised control-plane host can do; the rest is availability.
- Decision D2 (owner, open): first non-file key provider. Options: (a) OpenBao Transit; (b) AWS KMS; (c) Google Cloud KMS; (d) none, file keyring only.
  Recommended: (a). Rationale: self-hostable, MPL-licensed, a small HTTP API, and a real server can run in CI; cloud KMS cannot be proven without a cloud account.
- Decision D3 (owner, open): Kubernetes packaging. Options: (a) Kustomize base and overlays; (b) Helm chart; (c) both; (d) documentation only.
  Recommended: (a). Rationale: plain YAML that `kubectl` applies and `kubeconform` checks, with no release Secrets holding rendered values.
- Decision D4 (owner, open): where the signer may run when the control plane is on Kubernetes. Options: (a) outside the cluster only, on its own host; (b) in a separate cluster; (c) in the same cluster, documented as "cluster administrators are the signer host".
  Recommended: (a) for production; the in-cluster component exists for CI and evaluation only. Rationale: Secrets are unencrypted in etcd by default and cluster administration reaches every node.
- Decision D5 (owner, open): what a restore promises. Options: (a) every restore is fenced, so approvals waiting at backup time must be proposed again; (b) keep the v0.1 promise that waiting approvals survive a restore, and fence only when the operator knows the backup is older than the last signature.
  Recommended: (a). Rationale: the operator cannot know from the backup whether a payment happened after it; (b) can pay twice.
- Decision D6 (owner, open): Postgres durability on Kubernetes. Options: (a) CloudNativePG, 3 instances, `dataDurability: required`; (b) `preferred`; (c) asynchronous.
  Recommended: (a). Rationale: no acknowledged audit entry or shred is ever lost; writes pause when no standby is available, which stalls approvals but loses nothing.

Plan decisions (taken here, reopen in review if wrong):

- Decision: mutual TLS lives in the signer process, with self-signed certificates where each side trusts exactly the other's certificate. No certificate authority.
  Rationale: protection that does not depend on how the network between hosts is configured; no CA key to guard. A tunnel (WireGuard, Tailscale) may be added by the operator but is not relied on.
  Date/Author: 2026-11-14 / research agent
- Decision: the HMAC request signature stays as it is, inside TLS.
  Rationale: it binds method, path, time and body (`docs/approval-protocol.md:307-331`); TLS alone does not bind a request to the moment it was made.
  Date/Author: 2026-11-14 / research agent
- Decision: the restore fence is a time, set by the operator on the signer host, compared with the envelope's passkey-covered `issuedAt` plus `CLOCK_SKEW_SECONDS`. The replay check (an approval already signed in this database) still comes first.
  Rationale: research finding 6; `packages/protocol/src/webauthn/verify-authorization.ts:44,62-69`.
  Date/Author: 2026-11-14 / research agent
- Decision: a Transit KEK id is `bao:<mount>/<key>@<version>`, and `wrap` passes that `key_version`.
  Rationale: rotation must change `kek_id`, or `DataKeyStore.rewrap` (`kek_id <> active`) never moves a row.
  Date/Author: 2026-11-14 / research agent
- Decision: `KeyProvider.hasKek` is removed; the composite provider routes by KEK id prefix.
  Rationale: its only caller is its own unit test (research finding 2).
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
- Decision: on Kubernetes, agent pods get no DNS and reach the gateway through the `AGENT_GATEWAY_SERVICE_HOST` variable that Kubernetes injects for Services in the same namespace; the gateway runs in `os-agents`.
  Rationale: keeps the v0.1 gate "an agent cannot resolve internal names" meaningful.
  Date/Author: 2026-11-14 / research agent
- Decision: kind v0.33.0 with kindnet's built-in NetworkPolicy, not k3d.
  Rationale: kind runs upstream Kubernetes (`kindest/node:v1.37.0`) and enforces policies out of the box since v0.24.0.
  Date/Author: 2026-11-14 / research agent

## Outcomes & Retrospective

- Outcome: none yet. Nothing in this plan has been built or run.

## Context and Orientation

Relevant repo rules:

- Read `AGENTS.md` at the repository root before changing files. `docs/references/` is context, not authority.
- The owner's standing rule reserves local builds, whole test suites, coverage and `e2e/run.sh` for CI unless he names the command (`specs/agent-workspaces-v0.1.md:108-109`). Locally: `bun run check`, `bunx tsc --noEmit` in one package, and single test files.
- Every claim in a status update says whether it is written, type-checked, single-test-passed, CI-green or unproven.

Terms used here (v0.1 terms are in `docs/architecture.md:21-35`):

- **Trust domain**: a set of secrets and state that only one group of administrators controls. v0.1 has two: the control plane (server, Postgres, keyring) and the signer (vault, SQLite, token key, vault passphrase).
- **Split deployment**: the signer on one host, the control plane on another, each with its own administrators and backups.
- **Restore fence**: a time recorded in the signer's database; the signer refuses every envelope issued before it.
- **Key provider**: the code behind `KeyProvider` that wraps and unwraps data keys under a key-encryption key (KEK).
- **Replica**: one server process; several share one Postgres.
- **CNPG**: CloudNativePG, the Kubernetes operator for Postgres clusters.

Current behavior (each line is source-read; see the research report for detail):

- The signer serves plain HTTP on `0.0.0.0:8787` and relies on a Docker `internal` network (`apps/signer/src/main.ts:34`; `compose.yaml:181-182`).
- One `init` container writes both trust domains' secrets on one host (`deploy/init/init.mjs:35-59`).
- The keyring is one JSON file read at boot by the server, the World target and the keys CLI (`apps/server/src/main.ts:30`; `packages/world/src/target.ts:53`; `packages/keys/src/cli.ts:66-68`).
- Rate limits are in process memory (`apps/server/src/mcp/gateway.ts:388-448`); the setup token is re-minted by every boot (`apps/server/src/identity/setup.ts:21-33`); the key cache is per process and a shred evicts only locally (`packages/keys/src/data-key-store.ts:264-266`).
- Sessions, WebAuthn ceremonies, nonce reservations, audit appends, run starts and migrations are coordinated in Postgres (`docs/threat-model.md:31-33`; `apps/server/src/identity/ceremonies.ts:42-57`; `intents.ts:648-697`; `audit.ts:55-108`; `approvals.ts:198-210`; `db/migrate.ts:13-50`).
- The Workflow queue is Graphile Worker 0.16.6 with in-process delivery for the only queue prefix, `jobLockStaleSeconds: 30` (`apps/server/src/execution/index.ts:114-121`; `workflow-runtime.ts:118-131`).
- The operator recovery command shown in the UI is hard-coded to Compose (`apps/web/src/lib/operator.ts:25`).

How the pieces fit together after the plan:

```text
 people  --HTTPS-->  edge (Caddy or ingress)  -->  server replicas  -->  Postgres (single, or CNPG primary)
 agents  -->  agent-gateway (os-agents)  --/mcp-->  server replicas
 server replicas  --wrap/unwrap-->  OpenBao Transit (optional; otherwise the keyring file)
 server replicas  ==mutual TLS + HMAC==>  signer (own host; SQLite and OWS vault; no outbound)
```

Assumptions:

- Hosts in a split deployment keep clocks within 30 seconds (NTP). The request signature allows 60 seconds and the fence uses 30.
- The signer host has local block storage. SQLite over a network file system is not supported.
- Postgres poolers, if any, run in session mode: migrations take session advisory locks and Graphile uses `LISTEN`.
- The operator runs OpenBao themselves; this plan does not deploy or operate OpenBao.

## Plan of Work

Milestones are ordered by the recommended D1. Milestones 1 and 2 are one release. Milestones 3 and 4 are independent of each other. Milestone 5 depends on 1 (external signer) and 4 (replicas). Milestone 6 depends on 5.

### Milestone 1: The signer on its own host

Scope: mutual TLS between server and signer, one `init` per trust domain, a Compose file per host, the operator command shown for the signer host, and a CI job that runs the release gates across two Compose projects. First because it is the security gain.

Files and interfaces:

- `apps/signer/src/config.ts`: new variables `SIGNER_HOST` (default `0.0.0.0`), `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_PEER_CERT_FILE` (all three or none; otherwise `ConfigError("SIGNER_TLS_*: set all three or none")`), `SIGNER_HEALTH_PORT` (default `8788`, used only with TLS). `SignerConfig` gains `host: string` and `tls: { cert: Buffer; key: Buffer; peerCert: Buffer } | null`.
- `apps/signer/src/main.ts`: with `tls`, serve with `createServer: https.createServer` and `serverOptions: { cert, key, ca: [peerCert], requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }` (supported by `@hono/node-server` 2.1.8), plus a second plain listener on `127.0.0.1:SIGNER_HEALTH_PORT` whose Hono app answers only `GET /healthz`. Without `tls`, unchanged. At start, log `signer.tls_expiry` with the days left on both certificates; refuse to start if either has expired.
- `apps/server/src/config.ts`: `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_PEER_CERT_FILE`. An `https:` `SIGNER_URL` requires all three; an `http:` one refuses them (a half-configured split fails at boot, not silently in clear text). `SIGNER_ADMIN_COMMAND` (default `docker compose exec signer node src/admin.ts`).
- `apps/server/src/signer-transport.ts` (new): `createSignerFetch(tls, servername): typeof fetch` built from `undici` 8.12.4 (`Agent({ connect: { cert, key, ca: [peerCert], servername, minVersion: "TLSv1.3" } })` with undici's own `fetch`, so the dispatcher and fetch come from one package). Add `"undici": "8.12.4"` to `apps/server/package.json`.
- `apps/server/src/main.ts`: pass `fetch: createSignerFetch(...)` to `createSignerClient` (`packages/protocol/src/signer/client.ts:42` already accepts it).
- `packages/api/src/routes.ts` and the members page (`apps/web/src/routes/members.tsx:234`, `apps/web/src/lib/operator.ts:15-32`): the response that lists pending approvers carries `signerAdminCommand`; `enrollApproverCommand` takes it as its prefix instead of the hard-coded Compose text.
- `deploy/init/init.mjs`: `--domain=all|control|signer` (default `all`, today's behaviour). `signer` writes `/secrets/signer/*` only. `control` writes server and db secrets and requires `signer-request-secret` to be present already (copied from the signer host), never generating a second one.
- `deploy/split/make-peer-certs.sh` (new): two `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 730` invocations (`CN=os-signer` with `subjectAltName=DNS:<signer host>`, and `CN=os-control`), files written `0400`, SHA-256 fingerprints printed.
- `deploy/split/signer.compose.yaml` (new): `init` (`--domain=signer`) and `signer` with the TLS variables, the hardening anchor from `compose.yaml`, and `ports: ["${SIGNER_BIND_ADDRESS}:8787:8787"]` on the private interface. `deploy/split/nftables-signer.conf` (new): example rules that drop outbound traffic from the signer's bridge.
- `deploy/split/control.compose.yaml` (new): `postgres`, `server`, `caddy`, `agent-gateway`, `anvil` via `extends` from `../../compose.yaml`, with `SIGNER_URL=https://${SIGNER_HOSTNAME}:8787`, the server's TLS files, and no `signer` service or `depends_on` on it; `init` with `--domain=control`.
- `e2e/run.sh`, `e2e/src/stack.ts`: `E2E_SPLIT=1` brings up the two projects with an external network `os-e2e-wire` that only `server` and `signer` join, so nothing else connects them.
- `e2e/test/split.spec.ts` (new): the split-only gates below.
- `.github/workflows/ci.yml`: matrix entry `{ name: split, runner: ubuntu-latest, tls: "0", split: "1" }` in `stack`.

Work:

The signer checks the peer certificate at the TLS layer, so an unauthenticated client never reaches the HTTP parser. The control plane checks the signer's certificate and host name. Both keep the HMAC signature. The health check moves to a loopback listener because the main port now requires a client certificate. Compose healthchecks in `deploy/split/signer.compose.yaml` call `http://127.0.0.1:8788/healthz`.

Acceptance:

- In CI job `test`: `apps/signer/test/tls.test.ts` passes: a client with the trusted certificate gets 200 from `GET /healthz` and a signed request through; no client certificate, an untrusted self-signed one, and plain HTTP each fail before any HTTP response; the health listener answers only `/healthz` and only on `127.0.0.1`; an expired certificate stops boot.
- In CI job `test`: `apps/server/test/support/signer-transport.test.ts` passes: config refuses `https:` without the three files and `http:` with them; a signer client using `createSignerFetch` completes a request to a TLS test signer and fails against one presenting another certificate.
- CI `stack (split)` is green: every release gate passes, and `e2e/test/split.spec.ts` shows that a container on `os-e2e-wire` without the control plane's key cannot complete a handshake with the signer; that the control project has no volume holding `token-key`, `vault-passphrase` or the vault; and that the signer container cannot reach `https://example.com/` when the example nftables rules are applied.

### Milestone 2: The restore fence

Scope: a signer that is restored or moved cannot repeat a signature from the lost timeline. Depends on D5 for the restore gate's wording.

Files and interfaces:

- `apps/signer/src/db.ts`: `CREATE TABLE IF NOT EXISTS signer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;` with key `fence_at` (seconds since the epoch, decimal text).
- `apps/signer/src/admin.ts`: command `fence` (optional `--at <epoch>`, default now). Sets `fence_at = max(current, at)` and appends `fence-set-by-operator` to every workspace's decision log in one transaction. Prints one JSON line `{ event: "signer.fenced", fenceAt }`. Idempotent.
- `apps/signer/src/signer.ts`: for every envelope kind, after the replay check and before assertions are verified: if `fence_at` is set and `envelope.issuedAt < fence_at + CLOCK_SKEW_SECONDS`, throw `SignerFailure("envelope_fenced")`, recorded in the decision log like other refusals. Re-checked inside the signing transaction.
- `packages/protocol/src/signer/api.ts`: `envelope_fenced` added to `SignerErrorCode` (HTTP 403).
- `apps/server/src/execution/intents.ts` and `apps/server/src/execution/approvals.ts`: `envelope_fenced` is a permanent refusal; the intent ends `failed` with `failureCode: "approval_fenced"`; an administrative approval ends failed; the nonce reservation is released.
- `e2e/test/release-gates.spec.ts`: the gate "a restored backup keeps wallets and waiting approvals, and refuses a spent one" becomes, under D5 (a), "a restored and fenced backup keeps wallets, refuses an approval used after the backup and every approval issued before the restore, and signs a new proposal".
- `deploy/README.md` restore steps: run `node src/admin.ts fence` on the signer before it serves.

Work:

`issuedAt` is covered by the passkey assertion and may not be more than 30 seconds in the future at verification (`verify-authorization.ts:62-64`). Everything used before the restore was verified before it, so its `issuedAt` is below `fence + 30`. Approvals opened in the 30 seconds after the fence are refused too; the control plane's failure path makes the agent propose again.

Acceptance:

- In CI job `test`: `apps/signer/test/fence.test.ts` passes: copy the SQLite file, sign approval A, put the copy back; without a fence the restored signer signs A a second time (the hazard, kept as a characterization test); after `fence` it refuses A with `envelope_fenced` and the decision log records it; an envelope issued 31 seconds after the fence signs; on the original database, A returns its stored transaction even after a fence.
- CI `stack (amd64)` is green with the updated restore gate.

### Milestone 3: Key providers and OpenBao Transit

Scope: a provider interface that allows network providers, an OpenBao Transit provider, a composite for migration, and CI against a real OpenBao. Depends on D2.

Files and interfaces:

- `packages/keys/src/keyring.ts`: `KeyProvider` becomes `{ ready(): Promise<void>; activeKekId(): string; wrap(kekId, dataKey, aad): Promise<Uint8Array>; unwrap(kekId, wrapped, aad): Promise<Uint8Array>; close(): Promise<void> }`. `hasKek` is removed with its test case (`packages/keys/test/keyring.test.ts:64-71`; run LSP references first). New exported errors `KeyProviderUnavailableError` (retryable) and `KeyProviderRefusedError` (permanent); messages carry ids and HTTP status, never key material or AAD bytes. `LocalKeyring.ready()` and `close()` resolve. `parseKeyringFile` refuses ids outside `^[A-Za-z0-9_-]+$`, so a file id can never be mistaken for a `bao:` id.
- `packages/keys/src/transit.ts` (new): `TransitKeyProvider`. Options: `address: URL`, `mount` (default `transit`), `key` (default `os-kek`), `auth: { kind: "token"; tokenFile } | { kind: "approle"; roleIdFile; secretIdFile } | { kind: "kubernetes"; role; jwtFile }`, `caFile?`, `timeoutMs` (default 2000), `refreshSeconds` (default 300). `ready()` logs in when needed and reads `GET /v1/<mount>/keys/<key>`; the active KEK id is `bao:<mount>/<key>@<latest>`. `wrap` calls `POST /v1/<mount>/encrypt/<key>` with `plaintext`, `associated_data` and `key_version`, checks the returned `vault:v<version>:` prefix, and stores the ciphertext as UTF-8 bytes. `unwrap` calls `POST /v1/<mount>/decrypt/<key>` with `ciphertext` and `associated_data` and checks for 32 bytes. Network errors, timeouts, 429, 5xx and 503 (sealed) throw `KeyProviderUnavailableError` after one retry with 100 to 300 ms jitter; 400 and 403 throw `KeyProviderRefusedError` (403 first triggers one re-login). Token renewal at two thirds of its TTL. Refresh is an unref'd timer.
- `packages/keys/src/composite.ts` (new): `CompositeKeyProvider({ active, legacy })`. Wraps only under `active.activeKekId()`; unwraps ids starting `bao:` with the Transit provider and bare ids with `LocalKeyring`.
- `packages/keys/src/providers.ts` (new): `keyProviderFromEnv(env, { keyringFileVariable }): KeyProvider`. `KEY_PROVIDER=file` (default) needs the keyring file variable; `KEY_PROVIDER=openbao` needs `OPENBAO_ADDR`, `OPENBAO_AUTH` and its files, and becomes a composite when the keyring file variable is also set.
- `packages/keys/src/data-key-store.ts`: `ensureMigrated()` also awaits `provider.ready()`.
- `packages/keys/src/cli.ts`, `packages/world/src/target.ts` (keyring variable `WORLD_KEYRING_FILE`), `apps/server/src/main.ts`, `apps/server/src/config.ts` (keyring variable `KEYRING_FILE`, now optional when `KEY_PROVIDER=openbao`): use the factory. `main.ts` closes the provider on stop.
- `deploy/openbao/policy.hcl` (new): `update` on `<mount>/encrypt/<key>` and `<mount>/decrypt/<key>`, `read` on `<mount>/keys/<key>`.
- `deploy/compose.test.yaml`: service `openbao`, image `quay.io/openbao/openbao:2.7.2` pinned by digest at implementation time, `server -dev -dev-root-token-id=test-root -dev-listen-address=0.0.0.0:8200`, port `127.0.0.1:55820:8200`, healthcheck. `packages/testkit/src/openbao.ts` (new): enables Transit and creates the key idempotently; `pause()`/`unpause()` helpers using `docker pause`.
- `e2e/compose.openbao.yaml` (new) and a `stack` matrix entry `{ name: openbao, ... }`: OpenBao in dev mode on the `control` network, AppRole credentials written by a one-shot service, the server with `KEY_PROVIDER=openbao`.

Work:

Migration from the file keyring: set `KEY_PROVIDER=openbao` and keep `KEYRING_FILE`; restart; run `node packages/keys/src/cli.ts rewrap` until `failedCount` is 0; remove `KEYRING_FILE`; restart. Transit rotation: `bao write -f transit/keys/os-kek/rotate`; wait one `refreshSeconds` (or restart); run `rewrap`; then raise `min_decryption_version`.

Acceptance:

- In CI job `test`: `packages/keys/test/transit.test.ts` passes against the OpenBao service: round trip; a wrapped key presented with another row's AAD is refused with `KeyProviderRefusedError`; after rotation and `ready()` the active id ends `@2` and `rewrap()` returns `{ rewrapped: n, failed: [] }`; after `min_decryption_version=2` an old wrapped copy is refused; with OpenBao paused, `getOrCreate` rejects with `KeyProviderUnavailableError` within `timeoutMs + 500` ms and never resolves to a value; after unpause it resolves.
- In CI job `test`: `packages/keys/test/composite.test.ts` passes: keys created under `LocalKeyring` are readable through the composite, `rewrap` moves every row to `bao:`, and with the file removed every key still reads.
- In CI job `test`: `packages/world/test/ciphertext-at-rest.test.ts` runs for `file` and `openbao`: zero marker hits on the encrypting World and all ten on the stock World for both; a run with OpenBao paused for 20 seconds in the middle completes after unpause, and the test prints the delay for the record.
- CI `stack (openbao)` is green.

### Milestone 4: A replica-safe control plane

Scope: the five things that break with several replicas (research finding 7), and a CI stack with two replicas.

Files and interfaces:

- `packages/keys/src/data-key-store.ts`: `shred()` issues `pg_notify('os_keys_shred', scope || ':' || key_id)` in the same transaction as the tombstone. New option `listen?: boolean`; with it, `start()` holds one dedicated client on `LISTEN os_keys_shred` and evicts the named entry; on that client's error it clears the whole cache and reconnects with backoff; `close()` releases it. The TTL stays the upper bound.
- `apps/server/src/config.ts`: `DATA_KEY_CACHE_SECONDS` (default 60, 0 to 600), `FORWARDED_HOPS` (default 1, 1 to 5), `SETUP_TOKEN_IN_LOG` (default `true`; empty means unset).
- `apps/server/src/db/migrations/0002_rate_limits.sql` and `apps/server/src/db/schema.ts`: `CREATE UNLOGGED TABLE IF NOT EXISTS os.rate_limits (bucket text PRIMARY KEY, tokens double precision NOT NULL, at timestamptz NOT NULL)`.
- `apps/server/src/rate-limit.ts` (new): `takeToken(db, bucket, perMinute): Promise<boolean>`, one `INSERT ... ON CONFLICT DO UPDATE ... WHERE <refilled tokens> >= 1 RETURNING tokens` statement; a missing row in the result means limited.
- `apps/server/src/mcp/gateway.ts`: the `buckets` and `failures` maps are replaced with `takeToken` on `agent:<id>` (120 per minute) and `auth-fail:<client>` (10 per minute, checked before the database lookup as today); `clientOf` takes the entry `FORWARDED_HOPS` from the end of `X-Forwarded-For`.
- `apps/server/src/identity/setup.ts`: `prepareSetup` mints only when no token row exists, inside `pg_advisory_xact_lock(SETUP_LOCK)`; it logs the token only when `SETUP_TOKEN_IN_LOG`, otherwise logs `setup.token_pending`. New `rotateSetupToken(ctx)`.
- `apps/server/src/cli.ts` (new): `node apps/server/src/cli.ts setup-token` rotates and prints the token on stdout of the command, not the server log.
- `apps/server/src/execution/bundle-guard.ts` (new): `holdBundleLock(pool, flowFile)`: SHA-256 of `flow.mjs`, low 31 bits as `objid`; takes `pg_advisory_lock_shared(18680, objid)` on a dedicated client; refuses with `BundleMismatchError` if `pg_locks` shows a granted advisory lock with `classid = 18680` and another `objid`. Called by `startBackground` before `world.start()`; on the client's loss it re-acquires and re-checks before the queue keeps running.
- `apps/server/src/http/app.ts`: `GET /readyz`, 200 when `SELECT 1` succeeds and the World has started, else 503. `/healthz` unchanged.
- `apps/server/src/execution/intents.ts`: log `step.started` with `approvalId`, `step` and `replica` (host name) when the signing step begins. Identifiers only.
- `deploy/init/rotate-keyring.mjs`: `add` adds an inactive key; new `activate <id>`. `deploy/README.md` rotation becomes: add, restart every replica, activate, restart every replica, rewrap, prune, restart every replica.
- `deploy/Caddyfile` and `deploy/Caddyfile.agents`: Caddy's `dynamic a` upstream for `server` on port 3000, so every replica receives requests.
- `e2e/compose.replicas.yaml` (new): `server: { deploy: { replicas: 2 } }`. `e2e/test/replicas.spec.ts` (new). A `stack` matrix entry `{ name: replicas, ... }`.

Work:

Nothing else in the server keeps per-process state that decides anything: the MCP handler cache and the chain client cache are performance only (`gateway.ts:389,480-495`; `apps/server/src/execution/chains.ts:57-58`). The sweeper runs in every replica; that is accepted (research finding 7.7).

Acceptance:

- In CI job `test`: `packages/keys/test/data-key-store.test.ts` gains "a shred in one store is seen by another within one second": two stores on one database cache a workspace key; after `shred` in the first, the second's `getOrCreate` rejects with `DataKeyUnavailableError` within 1 s.
- In CI job `test`: `apps/server/test/support/rate-limit.test.ts` (new): two app instances on one database; 120 requests for one agent split across them pass and the 121st within the minute gets 429; the failed-authentication limit is shared the same way; `FORWARDED_HOPS=2` charges the second-to-last address.
- In CI job `test`: `apps/server/test/identity/identity.test.ts` gains "two boots at once mint one setup token".
- In CI job `test`: `apps/server/test/execution/workflow.test.ts` gains "a second start with another workflow bundle is refused while the first runs, and the same bundle is accepted".
- CI `stack (replicas)` is green: every release gate passes against two replicas, and `e2e/test/replicas.spec.ts` passes: after an approval, the replica that logged `step.started` for it is killed with `docker kill`, and the intent is `confirmed` with exactly one transaction within 90 seconds; exactly one `setup.token_issued` line exists across both replicas.

### Milestone 5: Kubernetes manifests proven on kind

Scope: Kustomize manifests for the control plane, NetworkPolicies, an e2e driver for Kubernetes, and a CI job on kind. Depends on D3 and D4, and on milestones 1 and 4.

Files and interfaces (all new unless stated):

- `deploy/k8s/base/kustomization.yaml`, `namespaces.yaml`: namespaces `os` and `os-agents`, both labelled `pod-security.kubernetes.io/enforce: restricted`.
- `deploy/k8s/base/server.yaml`: Deployment `server` (2 replicas, `strategy: Recreate`, `terminationGracePeriodSeconds: 10`, non-root, read-only root file system, all capabilities dropped, `seccompProfile: RuntimeDefault`, labels `sidecar.istio.io/inject: "false"` and annotation `linkerd.io/inject: disabled`, readiness `/readyz`, liveness `/healthz`); environment from ConfigMap `os-server` with `SETUP_TOKEN_IN_LOG=false`; files from Secret `os-server-secrets` (operator-created; names documented); Service `server` on 3000.
- `deploy/k8s/base/edge.yaml`: Caddy Deployment and Service with `deploy/k8s/base/files/Caddyfile`. `deploy/k8s/base/agents.yaml`: `agent-gateway` Deployment, Service and `files/Caddyfile.agents` in `os-agents`. `deploy/k8s/test/files.test.ts` checks both files equal `deploy/Caddyfile` and `deploy/Caddyfile.agents` byte for byte.
- `deploy/k8s/base/network-policies.yaml`: default deny (ingress and egress) in both namespaces; agent pods (`os.askgina/role: agent`) egress only to gateway pods on 80, no DNS; gateway egress only to server pods in `os` on 3000; server ingress from edge and gateway pods on 3000; server egress to Postgres pods on 5432, to the signer (component-specific), to DNS, and to RPC and OpenBao endpoints by CIDR (`OS_EGRESS_CIDRS` replacement); edge ingress from anywhere on 8080 and egress to server.
- `deploy/k8s/components/signer-in-cluster/`: namespace `os-signer`; StatefulSet `signer` with 1 replica and a `volumeClaimTemplate` with `accessModes: [ReadWriteOncePod]`; Secret `os-signer-secrets`; policy: ingress only from `os` server pods on 8787, no egress. A header comment states D4: for CI and evaluation only.
- `deploy/k8s/components/signer-external/`: server egress to `SIGNER_CIDR` on 8787; `SIGNER_URL` and the TLS files in `os-server-secrets`.
- `deploy/k8s/components/postgres-single/`: a one-replica Postgres 18 StatefulSet (image digest as in `compose.yaml:29`) for kind; ingress from server pods only.
- `deploy/k8s/components/dev-chain/`: anvil (image digest as in `compose.yaml:148`); server egress to it.
- `deploy/k8s/overlays/kind/` (base, signer-in-cluster, postgres-single, dev-chain) and `deploy/k8s/overlays/production-example/` (base, signer-external, CNPG from milestone 6).
- `deploy/k8s/isolation-probe.yaml`: a Job operators run after install; it runs the same checks as the e2e gate and exits non-zero on any reachable target.
- `e2e/src/driver.ts`: `interface StackDriver { origin: string; databaseUrl(): Promise<string>; chainUrl(): Promise<string>; setupToken(): Promise<string>; kill(service: string, which?: string): Promise<void>; logs(service: string): Promise<string>; runAsAgent(script: string, env: Record<string, string>): Promise<{ code: number; output: string }>; capabilities: Set<"backup" | "compose-networks" | "kubernetes"> }` with `compose` (the code now in `e2e/src/stack.ts`) and `k8s` (`kubectl port-forward`, `kubectl delete pod --grace-period=0 --force`, `kubectl logs`, `kubectl run` in `os-agents`, `kubectl exec ... node apps/server/src/cli.ts setup-token`).
- `e2e/test/release-gates.spec.ts`: gates declare the capabilities they need; gates needing `backup` or `compose-networks` are skipped on Kubernetes with a stated reason.
- `e2e/test/kubernetes.spec.ts`: an agent pod cannot resolve `server.os.svc.cluster.local`, gets 401 from `http://$AGENT_GATEWAY_SERVICE_HOST/mcp`, 404 for the API, the UI and the delivery routes, and cannot reach the internet; a pod in `os` without the server label cannot reach the signer on 8787; `kubectl exec` into the signer cannot reach anything; the server pod has exactly one container; a NetworkPolicy deleted on purpose makes the probe Job fail (the probe is not blind).
- `.github/workflows/ci.yml`: job `k8s` on `ubuntu-latest`: install kind v0.33.0 and kubeconform v0.8.0 with checksums; `kubectl kustomize deploy/k8s/overlays/kind | kubeconform -strict -summary -kubernetes-version 1.37.0`; `kind create cluster --image kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`; build the server, signer and scripted-agent images; `kind load docker-image`; create the Secrets from a script that reuses `deploy/init/init.mjs` output; `kubectl apply -k deploy/k8s/overlays/kind`; wait for rollout; `E2E_DRIVER=k8s ./e2e/run.sh`.

Work:

Server, signer and gateway images are the Compose ones. The kind overlay runs the signer in the cluster only because CI has one machine. Production uses `signer-external`.

Acceptance:

- In CI job `test`: `deploy/k8s/test/files.test.ts` passes.
- CI `k8s` is green: kubeconform passes; every applicable release gate passes with `E2E_DRIVER=k8s`; `e2e/test/kubernetes.spec.ts` passes; the replica crash gate of milestone 4 passes with `kubectl delete pod`.

### Milestone 6: HA Postgres with CloudNativePG

Scope: a three-instance Postgres with synchronous replication on kind, and two gates on lost and kept commits. Depends on D6 and milestone 5.

Files and interfaces:

- `deploy/k8s/components/cnpg/cluster.yaml` (new): `Cluster os-db`, `instances: 3`, `postgresql.synchronous: { method: any, number: 1, dataDurability: required }`, `postgresql.parameters.max_connections: "200"`; the server's `DATABASE_URL` points at `os-db-rw.os.svc:5432` and `DATABASE_PASSWORD_FILE` at the CNPG application Secret's `password` key.
- `deploy/k8s/components/cnpg/network-policies.yaml` (new): instance ingress on 5432 from server pods and from the other instances (`cnpg.io/cluster: os-db`), on 8000 from the operator namespace `cnpg-system`; instance egress to the other instances and to the Kubernetes API.
- `deploy/k8s/overlays/kind-ha/` (new): the kind overlay with `cnpg` instead of `postgres-single`.
- `.github/workflows/ci.yml`: job `k8s` gains a matrix `db: [single, cnpg]`; for `cnpg`, install the CloudNativePG v1.30.1 release manifest pinned by SHA-256 before applying.
- `e2e/test/postgres-ha.spec.ts` (new, `kubernetes` capability): record the audit head through the API; propose and approve; when `step.started` appears, delete the primary pod with `--grace-period=0 --force`; expect `confirmed` and exactly one transaction within 180 seconds, `verifyAudit` ok, the audit sequence at least the one recorded plus the events the API acknowledged before the failover, and no server pod restarted.
- `e2e/test/release-gates.spec.ts` (Compose, `backup` capability): new gate "a database rolled back to before the signature, with a current signer, ends in one transaction": snapshot `postgres-data` after the approval opens, approve, wait for `confirmed`, stop, restore only `postgres-data`, start, approve again; the signer returns the stored transaction, the chain shows one transfer, and the audit chain verifies.

Work:

The server already reconnects idle clients (`apps/server/src/main.ts:26-27`), and Graphile polls every 500 ms (`queue.js:1159`). Whether the World's run-status and stream listeners reconnect on their own is unknown; the failover gate settles it. If they do not, the fix goes upstream or into `packages/world`, and this milestone records it.

Acceptance:

- CI `k8s (cnpg)` is green, including `e2e/test/postgres-ha.spec.ts`.
- CI `stack (amd64)` is green with the rolled-back-database gate.

### Milestone 7: Documentation matches the code

Scope: the threat model, architecture, protocol and deployment guide describe what milestones 1 to 6 built, and a test keeps configuration and documentation in step.

Files and interfaces:

- `docs/threat-model.md`: "One machine running everything" becomes a section on the two-host form; new limits for Kubernetes (Secrets in etcd, policies need an enforcing CNI, no `localhost` blocking), the key provider row, the restore fence, and lost commits under asynchronous replication.
- `docs/architecture.md`: the state table gains OpenBao as a KEK location; the network section gains the NetworkPolicy table.
- `docs/approval-protocol.md`: §8 gains the fence step; §10 states that between hosts requests travel inside mutual TLS.
- `deploy/README.md`: "Signer on its own machine", "OpenBao", "Several server replicas", two-phase keyring rotation, restore with `fence`, and a pointer to `deploy/k8s/`.
- `apps/server/test/support/config-docs.test.ts` (new): every variable accepted by `apps/server/src/config.ts` and `apps/signer/src/config.ts` appears in `deploy/README.md` or `docs/`, and every `SIGNER_*`, `OPENBAO_*`, `KEY_PROVIDER`, `FORWARDED_HOPS`, `SETUP_TOKEN_IN_LOG` and `DATA_KEY_CACHE_SECONDS` named there exists in a schema.

Acceptance:

- In CI job `test`: `apps/server/test/support/config-docs.test.ts` passes. CI `check` passes.

## Interfaces and Dependencies

Local interfaces:

- `KeyProvider` (`packages/keys/src/keyring.ts`): `ready(): Promise<void>`; `activeKekId(): string`; `wrap(kekId: string, dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array>`; `unwrap(kekId: string, wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array>`; `close(): Promise<void>`. Every failure throws `KeyProviderUnavailableError` or `KeyProviderRefusedError`; nothing resolves to "no key".
- KEK id grammar: Transit ids match `^bao:[a-z0-9/_-]+@[1-9][0-9]*$`. `LocalKeyring` ids must match `^[A-Za-z0-9_-]+$`; today `parseKeyringFile` accepts any string (`packages/keys/src/keyring.ts:36-39`), so it gains that check, and the ids `rotate-keyring.mjs` writes (`k1`, `k2`, ...) already pass it.
- `DataKeyStoreOptions` (`packages/keys/src/data-key-store.ts`): adds `listen?: boolean`. Channel `os_keys_shred`, payload `<scope>:<keyId>`.
- `SignerErrorCode` (`packages/protocol/src/signer/api.ts`): adds `envelope_fenced` (403).
- Signer SQLite: `signer_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`, key `fence_at`.
- Signer admin CLI: `node src/admin.ts fence [--at <epoch>]`.
- Server CLI: `node apps/server/src/cli.ts setup-token`.
- Server HTTP: `GET /readyz` (200 or 503, body `{ ok: boolean }`).
- Postgres: `os.rate_limits` (UNLOGGED); advisory lock class `18680` for the bundle guard.
- Configuration, server: `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_PEER_CERT_FILE`, `SIGNER_ADMIN_COMMAND`, `KEY_PROVIDER`, `OPENBAO_ADDR`, `OPENBAO_TRANSIT_MOUNT`, `OPENBAO_TRANSIT_KEY`, `OPENBAO_AUTH`, `OPENBAO_TOKEN_FILE`, `OPENBAO_ROLE_ID_FILE`, `OPENBAO_SECRET_ID_FILE`, `OPENBAO_KUBERNETES_ROLE`, `OPENBAO_CA_FILE`, `OPENBAO_TIMEOUT_MS`, `DATA_KEY_CACHE_SECONDS`, `FORWARDED_HOPS`, `SETUP_TOKEN_IN_LOG`. Signer: `SIGNER_HOST`, `SIGNER_TLS_CERT_FILE`, `SIGNER_TLS_KEY_FILE`, `SIGNER_TLS_PEER_CERT_FILE`, `SIGNER_HEALTH_PORT`. Every default keeps today's single-machine Compose behaviour.

External dependencies:

- OpenBao 2.7.2 Transit secrets engine ([API](https://openbao.org/api-docs/secret/transit/)): `POST /v1/<mount>/encrypt/<key>` (`plaintext`, `associated_data`, `key_version`), `POST /v1/<mount>/decrypt/<key>` (`ciphertext`, `associated_data`), `GET /v1/<mount>/keys/<key>` (`keys`, `min_decryption_version`), `POST /v1/<mount>/keys/<key>/rotate`; auth `approle` and `kubernetes`. Constraint: `rewrap` has no `associated_data`; a sealed server answers nothing useful until unsealed. Image `quay.io/openbao/openbao:2.7.2`.
- `undici` 8.12.4 (already in `bun.lock` as a transitive dependency): `Agent`, `fetch`.
- `@hono/node-server` 2.1.8: `serve({ createServer, serverOptions })` for HTTPS.
- `graphile-worker` 0.16.6 and `@workflow/world-postgres` 5.2.0: `jobLockStaleSeconds` must be equal on every process; deployment id is constant.
- kind v0.33.0 with `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`; kindnet NetworkPolicy via kube-network-policies (since kind v0.24.0).
- kubeconform v0.8.0; Kustomize as built into `kubectl`.
- CloudNativePG v1.30.1: `spec.postgresql.synchronous` with `method`, `number`, `dataDurability`.
- `openssl` on the operator's machine for `deploy/split/make-peer-certs.sh`.

## Concrete Steps

Locally, only what the standing rule allows, from the repository root:

    bun run check
    (cd packages/keys && bunx tsc --noEmit)
    (cd apps/signer && bunx tsc --noEmit)
    (cd apps/server && bunx tsc --noEmit)
    bunx vitest run packages/keys/test/transit.test.ts     # one file; needs `bun run services:up`

Everything else runs in CI on push:

    test                 # unit and package suites, OpenBao service included
    stack (amd64|arm64|tls|split|openbao|replicas)
    k8s (single|cnpg)

Expected evidence (to be recorded here when it exists):

    stack (split): release gates N passed; split.spec.ts 3 passed
    k8s (cnpg): postgres-ha.spec.ts 1 passed; audit verified; transactions 1

## Validation and Acceptance

Automated validation:

- `apps/signer/test/tls.test.ts`, `apps/signer/test/fence.test.ts`: in `test`.
- `apps/server/test/support/signer-transport.test.ts`, `rate-limit.test.ts`, `config-docs.test.ts`; new cases in `identity.test.ts` and `workflow.test.ts`: in `test`.
- `packages/keys/test/transit.test.ts`, `composite.test.ts`; new case in `data-key-store.test.ts`; `packages/world/test/ciphertext-at-rest.test.ts` on both providers: in `test`.
- `deploy/k8s/test/files.test.ts`: in `test`.
- `e2e/test/split.spec.ts`: in `stack (split)`.
- `e2e/test/replicas.spec.ts`: in `stack (replicas)` and `k8s`.
- `e2e/test/kubernetes.spec.ts`: in `k8s`.
- `e2e/test/postgres-ha.spec.ts`: in `k8s (cnpg)`.
- The updated restore gate and the rolled-back-database gate: in `stack (amd64)`.

Manual or runtime validation (cannot be automated):

- Two real hosts with different administrators run the split deployment: the control host has no account that can log into the signer host. Record who administers each.
- A real OpenBao with auto-unseal survives a restart of OpenBao while the stack runs; record the delay before runs resume.

Regression checks:

- Every v0.1 release gate still passes in `stack (amd64)`, `stack (arm64)` and `stack (tls)` with default settings (single machine, file keyring, one replica).
- The README quickstart still prints the setup token in the server log.

## Threat Model After the Change

| If this is compromised                                                            | The attacker can                                                                                                                                                                                                                                                                                                  | The attacker cannot                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A control-plane replica, its host (split deployment) or its Kubernetes namespace  | Everything v0.1 lists for "the control plane process" (`specs/agent-workspaces-v0.1.md:247`): ask the signer anything the HMAC secret and client key allow, show a misleading card, pause, revoke, read sealed content (through the keyring file or by calling OpenBao with the server's token while it holds it) | Produce a passkey assertion; exceed a policy cap; reuse an approval; enroll an approver or set a fence (both are CLI-only on the signer host); read the vault, the token key or the vault passphrase (not on this host); reach the signer without the client key it holds anyway |
| The network between control host and signer host                                  | Drop or delay traffic                                                                                                                                                                                                                                                                                             | Read intents or assertions, or replay a captured request (mutual TLS)                                                                                                                                                                                                            |
| OpenBao, or the server's OpenBao token                                            | Decrypt every data key it is asked for; with a database copy, read all sealed content                                                                                                                                                                                                                             | Sign, approve or change policy; the signer does not use the keyring                                                                                                                                                                                                              |
| A Postgres replica, a CNPG backup or a WAL archive                                | Read what database read access gives (`docs/threat-model.md:69-80`); recover keys shredded after the backup                                                                                                                                                                                                       | Read sealed content without the KEKs; make the signer sign                                                                                                                                                                                                                       |
| Kubernetes cluster administration, signer outside the cluster                     | Everything the control plane can                                                                                                                                                                                                                                                                                  | Everything in the "cannot" column of the first row                                                                                                                                                                                                                               |
| Kubernetes cluster administration, signer in the cluster (CI and evaluation only) | Everything for every wallet (Secrets and the signer volume are in the cluster)                                                                                                                                                                                                                                    | Nothing is protected                                                                                                                                                                                                                                                             |
| The signer host                                                                   | Everything for the wallets on it, including enrolling approvers and setting the fence                                                                                                                                                                                                                             | Nothing is protected (unchanged from v0.1)                                                                                                                                                                                                                                       |

The invariant holds in every row: whether a human approved is decided by the signer from passkey assertions it verifies itself (`docs/architecture.md:161-164`), and the signer builds every transaction from the approved intent. The fence adds one more refusal and removes none.

## Idempotence and Recovery

- `init --domain=...` never overwrites an existing secret (as today); `--domain=control` refuses to generate a request secret it should have received.
- `fence` sets `max(current, at)`; running it twice changes nothing.
- `rewrap` can be repeated; rows already under the active KEK are skipped; failures are reported and not fatal (`packages/keys/src/data-key-store.ts:202-256`).
- Migration `0002_rate_limits.sql` uses `IF NOT EXISTS`; the table can be truncated at any time.
- `kubectl apply -k` is idempotent. CNPG manages its own instances.
- Backout per milestone: TLS is off when the TLS variables are unset; `KEY_PROVIDER=file` with the keyring file restores the file provider while the composite still has both (do not remove the file until `rewrap` reported zero failures); one replica is the v0.1 configuration; Kubernetes and CNPG are separate deploy targets and leave Compose untouched.
- Restoring the signer: stop it; restore `signer-data` and `signer-secrets`; run `fence`; start it. Agents re-propose what was waiting.

## Rollout and Operations

- Feature flags/config/env vars: listed under `Interfaces and Dependencies`. Defaults keep today's behaviour.
- Split deployment steps: on the signer host, `init --domain=signer`, generate peer certificates, start `deploy/split/signer.compose.yaml`, apply the nftables example; copy `signer-request-secret`, the control certificate and key, and the signer certificate to the control host; there, `init --domain=control` and start `deploy/split/control.compose.yaml`. Moving an existing single-machine install: stop the stack, move `signer-data` and `signer-secrets` to the new host, run `fence`, start both sides.
- Monitoring: log events `keys.provider_unavailable` (count and duration), `signer.tls_expiry` (days left, at start), `workflow.bundle_mismatch`, `setup.token_pending`; `/readyz` for load balancers and Kubernetes; Graphile job attempts above 5 for any run means it is backing off.
- Clock: NTP on both hosts; a skew above 60 seconds shows as `unauthenticated` signer refusals, which the server retries (`apps/server/src/execution/intents.ts:639`).
- Certificates: valid 730 days; rotation is "generate a new pair, copy, restart both sides".

## Risks and Open Questions

- Risk: a key-provider outage leaves runs backing off for hours after it ends.
  Mitigation: the 20-second outage test in milestone 3 measures the delay; if long, add a bounded in-provider retry before throwing, or an operator command that resets the backoff of active runs. Alert on `keys.provider_unavailable`.
- Risk: OpenBao with a Shamir seal stays sealed after its restart.
  Mitigation: document auto-unseal; treat sealed as an outage.
- Risk: certificate expiry stops all signing.
  Mitigation: the expiry log at start and a refusal to start with an expired certificate, so it is seen at the next restart at the latest; a two-year validity.
- Risk: the signer is a single point of failure; approvals expire while it is down.
  Mitigation: accepted (D1, signer not replicated); restore with a fence; document the recovery time.
- Risk: a wallet created after the last signer backup is lost on restore, with its funds.
  Mitigation: document "back up the signer after creating a wallet and before funding it"; a later ticket can make the control plane show wallets created since the signer's last backup.
- Risk: NetworkPolicies are silently ignored by a CNI that does not implement them.
  Mitigation: `deploy/k8s/isolation-probe.yaml` must pass after every install; it fails when a policy is missing.
- Risk: a service mesh injects a sidecar into the server pod and reaches the loopback delivery listener.
  Mitigation: injection disabled by label and annotation; the Kubernetes gate checks the server pod has one container.
- Risk: synchronous replication pauses writes when no standby is available.
  Mitigation: accepted under D6 (a); three instances tolerate one loss.
- Risk: connection count grows with replicas (22 per replica by default).
  Mitigation: `max_connections: 200` in the CNPG cluster; document the formula.
- Risk: `Recreate` gives a short outage on every server upgrade.
  Mitigation: accepted; in-flight steps rerun after the restart as in v0.1.
- Risk: the `k8s` CI job is slow.
  Mitigation: measure on the first run; if needed run it on pushes to `main`, nightly, and on pull requests that touch `deploy/k8s/**`.
- Open question: whether the World's run-status and stream listeners reconnect after a Postgres failover. Owner/next step: milestone 6 gate.
- Open questions D1 to D6: see `Decision Log`. Owner/next step: the owner.

## Artifacts and Notes

    docs/threat-model.md:216-218
      One machine running everything gives no protection against that machine. The network
      separation between server and signer protects only when they run on different hosts with
      separate administration.

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
