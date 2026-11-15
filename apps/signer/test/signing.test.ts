import {
  AssertionResponse,
  type Authorization,
  type EvmIntent,
  envelopeChallenge,
  newId,
  policyHash,
} from "@askgina/os-protocol";
import {
  SIGNATURE_HEADER,
  SignerErrorBody,
  signRequest,
  TIMESTAMP_HEADER,
} from "@askgina/os-protocol/signer";
import { b64url } from "@askgina/os-protocol/testing";
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ORIGIN,
  approveIntent,
  authorize,
  ETH,
  header,
  intentFor,
  ORIGIN,
  type Person,
  RECIPIENT,
  ROUTER,
  refused,
  setUpWorld,
  startSigner,
  TOKEN,
  txParams,
} from "./harness.ts";

describe("where an approval was made", () => {
  it("refuses an approval made on the control plane's page or in a frame, and signs nothing", async () => {
    const world = await setUpWorld(startSigner());
    const person = world.people[0] as Person;
    const intent = intentFor(world);
    const { envelope } = approveIntent(world, intent);
    // The control plane's own page: same RP ID, same passkey, but the control plane chose what
    // that page showed.
    const onControlPlane = authorize(envelope, [person], ORIGIN);
    // The confirmation page inside another page's frame: the browser stamps the confirmation
    // page's origin, and says it was framed.
    const framed: Authorization = {
      envelope,
      assertions: [
        {
          userId: person.userId,
          credentialId: person.credential.credentialId,
          response: AssertionResponse.parse(
            person.authenticator.authenticate({
              credentialId: person.credential.credentialId,
              challenge: b64url(envelopeChallenge(envelope)),
              origin: APPROVAL_ORIGIN,
              crossOrigin: true,
            }),
          ),
        },
      ],
    };
    for (const authorization of [onControlPlane, framed]) {
      await refused(
        world.t.client.sign({ intent, authorization, transaction: txParams() }),
        "assertion_invalid",
      );
    }
    expect((await world.t.client.getApproval(envelope.approvalId)).state).toBe("unknown");
    expect((await world.t.client.getWallet(world.walletId)).spent).toEqual([]);

    // The same envelope approved on the confirmation page itself is signed.
    const signed = await world.t.client.sign({
      intent,
      authorization: authorize(envelope, [person]),
      transaction: txParams(),
    });
    expect(signed.approvalId).toBe(envelope.approvalId);
  });
});

describe("signing an approved intent", () => {
  it("signs exactly the approved transfer, from the wallet's own key", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world);
    const signed = await world.t.client.sign({
      intent,
      authorization: approveIntent(world, intent),
      transaction: txParams(),
    });
    const tx = parseTransaction(signed.signedTransaction);
    expect(tx.to).toBe(RECIPIENT);
    expect(tx.value).toBe(ETH);
    expect(tx.chainId).toBe(31337);
    expect(tx.data).toBeUndefined();
    const from = await recoverTransactionAddress({
      serializedTransaction: signed.signedTransaction as `0x02${string}`,
    });
    expect(from.toLowerCase()).toBe(world.address);
    expect(signed.from).toBe(world.address);
  });

  it("encodes ERC-20 transfer calldata itself, sending to the token contract", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world, {
      type: "evm.erc20.transfer",
      token: TOKEN,
      to: RECIPIENT,
      amount: "250000",
    });
    const signed = await world.t.client.sign({
      intent,
      authorization: approveIntent(world, intent),
      transaction: txParams({ gas: "60000" }),
    });
    const tx = parseTransaction(signed.signedTransaction);
    expect(tx.to).toBe(TOKEN);
    expect(tx.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data ?? "0x" });
    expect(call.functionName).toBe("transfer");
    expect(call.args.map((arg) => (typeof arg === "string" ? arg.toLowerCase() : arg))).toEqual([
      RECIPIENT,
      250000n,
    ]);
  });

  it("returns the same signed transaction for a repeated request and never signs twice", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world);
    const request = {
      intent,
      authorization: approveIntent(world, intent),
      transaction: txParams(),
    };
    const first = await world.t.client.sign(request);
    // A workflow retry may even arrive with different gas; the stored transaction still wins.
    const second = await world.t.client.sign({ ...request, transaction: txParams() });
    expect(second).toEqual(first);
    const state = await world.t.client.getApproval(first.approvalId);
    expect(state).toEqual({
      approvalId: first.approvalId,
      state: "signed",
      transactionHash: first.transactionHash,
      attempts: [
        {
          attempt: 0,
          kind: "original",
          transactionHash: first.transactionHash,
          gas: request.transaction.gas,
          maxFeePerGas: request.transaction.maxFeePerGas,
          maxPriorityFeePerGas: request.transaction.maxPriorityFeePerGas,
          signedAt: world.t.clock.value,
        },
      ],
    });
    const wallet = await world.t.client.getWallet(world.walletId);
    expect(wallet.spent).toEqual([
      { chainId: "eip155:31337", asset: "native", amount: String(ETH) },
    ]);
  });

  it("refuses a different envelope under an approval id that was already signed", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    await world.t.client.sign({ intent, authorization, transaction: txParams() });
    const other = intentFor(world);
    const reused = authorize(
      {
        ...approveIntent(world, other).envelope,
        approvalId: authorization.envelope.approvalId,
      },
      world.people,
    );
    await refused(
      world.t.client.sign({ intent: other, authorization: reused, transaction: txParams() }),
      "conflict",
    );
  });

  describe("refuses any field changed after approval", () => {
    const alterations = [
      [
        "amount",
        (i: EvmIntent): unknown => ({ ...i, operation: { ...i.operation, valueWei: "2" } }),
        "intent_mismatch",
      ],
      [
        "recipient",
        (i: EvmIntent): unknown => ({ ...i, operation: { ...i.operation, to: TOKEN } }),
        "intent_mismatch",
      ],
      ["memo", (i: EvmIntent): unknown => ({ ...i, memo: "something else" }), "intent_mismatch"],
      [
        "fee ceiling",
        (i: EvmIntent): unknown => ({ ...i, maxFeeWei: "999999999999999999" }),
        "intent_mismatch",
      ],
      ["chain", (i: EvmIntent): unknown => ({ ...i, chainId: "eip155:1" }), "envelope_mismatch"],
      [
        "wallet",
        (i: EvmIntent): unknown => ({ ...i, walletId: newId("wal") }),
        "envelope_mismatch",
      ],
      ["agent", (i: EvmIntent): unknown => ({ ...i, agentId: newId("agt") }), "envelope_mismatch"],
    ] as const;
    for (const [field, alter, code] of alterations) {
      it(field, async () => {
        const world = await setUpWorld(startSigner());
        const intent = intentFor(world);
        const authorization = approveIntent(world, intent);
        await refused(
          // The altered intent is still well formed; only the approval no longer covers it.
          world.t.client.sign({
            intent: alter(intent) as EvmIntent,
            authorization,
            transaction: txParams(),
          }),
          code,
        );
      });
    }

    it("token", async () => {
      const world = await setUpWorld(startSigner());
      const intent = intentFor(world, {
        type: "evm.erc20.transfer",
        token: TOKEN,
        to: RECIPIENT,
        amount: "1",
      });
      const authorization = approveIntent(world, intent);
      const altered = { ...intent, operation: { ...intent.operation, token: ROUTER } };
      await refused(
        world.t.client.sign({ intent: altered, authorization, transaction: txParams() }),
        "intent_mismatch",
      );
    });

    it("calldata", async () => {
      const world = await setUpWorld(startSigner());
      const intent = intentFor(world, {
        type: "evm.call",
        to: ROUTER,
        valueWei: "0",
        data: "0xa9059cbb00",
      });
      const authorization = approveIntent(world, intent);
      const altered = {
        ...intent,
        operation: { ...intent.operation, data: "0xa9059cbb01" as const },
      };
      await refused(
        world.t.client.sign({ intent: altered, authorization, transaction: txParams() }),
        "intent_mismatch",
      );
    });

    it("the wallet's policy", async () => {
      const world = await setUpWorld(startSigner());
      const intent = intentFor(world);
      const authorization = approveIntent(world, intent);
      const next = {
        ...world.policy,
        revision: 2,
        previousHash: policyHash(world.policy),
        fees: { maxPerTxWei: String(10n ** 17n) },
      };
      await world.t.client.setPolicy(world.walletId, {
        policy: next,
        authorization: authorize(
          {
            ...header(world.t.clock, newId("apr"), world.workspaceId),
            type: "set-policy",
            walletId: world.walletId,
            policyHash: policyHash(next),
            previousPolicyHash: policyHash(world.policy),
          },
          world.people,
        ),
      });
      await refused(
        world.t.client.sign({ intent, authorization, transaction: txParams() }),
        "policy_changed",
      );
    });
  });

  it("refuses a second approval that reuses an envelope nonce", async () => {
    const world = await setUpWorld(startSigner());
    const first = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "1" });
    const firstAuth = approveIntent(world, first);
    await world.t.client.sign({ intent: first, authorization: firstAuth, transaction: txParams() });
    const second = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "2" });
    const secondAuth = authorize(
      { ...approveIntent(world, second).envelope, nonce: firstAuth.envelope.nonce },
      world.people,
    );
    await refused(
      world.t.client.sign({ intent: second, authorization: secondAuth, transaction: txParams() }),
      "nonce_reused",
    );
  });

  it("lets a new approval use an account nonce again, but never re-signs for one approval", async () => {
    // A local chain that was reset counts from zero again, and replacing a transaction that
    // never landed needs its nonce, so the account nonce may repeat. The approval may not.
    const world = await setUpWorld(startSigner());
    const params = txParams();
    const a = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "1" });
    const aAuth = approveIntent(world, a);
    const first = await world.t.client.sign({
      intent: a,
      authorization: aAuth,
      transaction: params,
    });
    const b = intentFor(world, { type: "evm.transfer", to: RECIPIENT, valueWei: "2" });
    const second = await world.t.client.sign({
      intent: b,
      authorization: approveIntent(world, b),
      transaction: params,
    });
    expect(parseTransaction(second.signedTransaction).nonce).toBe(params.nonce);
    expect(second.transactionHash).not.toBe(first.transactionHash);

    // The first approval, asked again with other gas and nonce, still yields its one transaction.
    const again = await world.t.client.sign({
      intent: a,
      authorization: aAuth,
      transaction: txParams({ gas: "30000" }),
    });
    expect(again).toEqual(first);
  });

  it("refuses an expired envelope and one that lives longer than the policy allows", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    world.t.clock.value += 301;
    await refused(
      world.t.client.sign({ intent, authorization, transaction: txParams() }),
      "envelope_expired",
    );
    const long = approveIntent(world, intent, { ttlSeconds: 601 });
    await refused(
      world.t.client.sign({ intent, authorization: long, transaction: txParams() }),
      "envelope_ttl_too_long",
    );
  });

  it("refuses a revoked approval, and a revocation cannot undo a signature", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    const revoked = await world.t.client.revokeApproval(
      authorization.envelope.approvalId,
      world.workspaceId,
    );
    expect(revoked.state).toBe("revoked");
    await refused(
      world.t.client.sign({ intent, authorization, transaction: txParams() }),
      "approval_revoked",
    );

    const other = intentFor(world);
    const otherAuth = approveIntent(world, other);
    await world.t.client.sign({ intent: other, authorization: otherAuth, transaction: txParams() });
    await refused(
      world.t.client.revokeApproval(otherAuth.envelope.approvalId, world.workspaceId),
      "conflict",
    );
  });

  it("returns an already signed transaction while paused: pausing stops new signatures, not old ones", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    const transaction = txParams();
    const signed = await world.t.client.sign({ intent, authorization, transaction });
    await world.t.client.pauseWorkspace(world.workspaceId);
    // The transaction already exists; returning it again creates nothing new.
    expect(await world.t.client.sign({ intent, authorization, transaction })).toEqual(signed);
    const fresh = intentFor(world);
    await refused(
      world.t.client.sign({
        intent: fresh,
        authorization: approveIntent(world, fresh),
        transaction: txParams(),
      }),
      "workspace_paused",
    );
  });

  it("refuses while the workspace is paused and signs again after a passkey resume", async () => {
    const world = await setUpWorld(startSigner());
    await world.t.client.pauseWorkspace(world.workspaceId);
    const intent = intentFor(world);
    const authorization = approveIntent(world, intent);
    await refused(
      world.t.client.sign({ intent, authorization, transaction: txParams() }),
      "workspace_paused",
    );
    const resumed = await world.t.client.resumeWorkspace(
      world.workspaceId,
      authorize(
        { ...header(world.t.clock, newId("apr"), world.workspaceId), type: "resume-workspace" },
        world.people,
      ),
    );
    expect(resumed.paused).toBe(false);
    await world.t.client.sign({ intent, authorization, transaction: txParams() });
  });

  it("allows only one of two approvals against a daily cap that fits one", async () => {
    const world = await setUpWorld(startSigner());
    const a = intentFor(world);
    const b = intentFor(world);
    const results = await Promise.allSettled([
      world.t.client.sign({
        intent: a,
        authorization: approveIntent(world, a),
        transaction: txParams(),
      }),
      world.t.client.sign({
        intent: b,
        authorization: approveIntent(world, b),
        transaction: txParams(),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("policy_denied");
    expect(rejected?.status === "rejected" && rejected.reason.detail).toBe("over_daily_cap");
  });

  it("enforces the policy itself, whatever the approvers signed", async () => {
    const world = await setUpWorld(startSigner());
    const tooBig = intentFor(world, {
      type: "evm.transfer",
      to: RECIPIENT,
      valueWei: String(2n * ETH),
    });
    await refused(
      world.t.client.sign({
        intent: tooBig,
        authorization: approveIntent(world, tooBig),
        transaction: txParams(),
      }),
      "policy_denied",
      "over_per_tx_cap",
    );
    const call = intentFor(world, {
      type: "evm.call",
      to: RECIPIENT,
      valueWei: "0",
      data: "0x12345678",
    });
    await refused(
      world.t.client.sign({
        intent: call,
        authorization: approveIntent(world, call),
        transaction: txParams(),
      }),
      "policy_denied",
      "contract_call_not_allowed",
    );
  });

  it("needs two different people when the policy threshold is 2", async () => {
    const world = await setUpWorld(startSigner(), { people: 2, policyThreshold: 2 });
    const intent = intentFor(world);
    await refused(
      world.t.client.sign({
        intent,
        authorization: approveIntent(world, intent, { people: world.people.slice(0, 1) }),
        transaction: txParams(),
      }),
      "insufficient_approvals",
    );
    const signed = await world.t.client.sign({
      intent,
      authorization: approveIntent(world, intent, { people: world.people }),
      transaction: txParams(),
    });
    expect(signed.walletId).toBe(world.walletId);
  });

  it("refuses an assertion from an approver who was removed", async () => {
    const world = await setUpWorld(startSigner(), { people: 2 });
    const [alice, bob] = world.people as [(typeof world.people)[0], (typeof world.people)[0]];
    const intent = intentFor(world);
    const byBob = approveIntent(world, intent, { people: [bob] });
    await world.t.client.removeApprover(
      world.workspaceId,
      authorize(
        {
          ...header(world.t.clock, newId("apr"), world.workspaceId),
          type: "remove-approver",
          userId: bob.userId,
          credentialId: bob.credential.credentialId,
        },
        [alice],
      ),
    );
    await refused(
      world.t.client.sign({ intent, authorization: byBob, transaction: txParams() }),
      "approver_unknown",
    );
  });

  it("refuses fees above the approved ceiling", async () => {
    const world = await setUpWorld(startSigner());
    const intent = intentFor(world);
    // 21000 gas * 50 gwei is above the intent's 0.001 ETH ceiling.
    await refused(
      world.t.client.sign({
        intent,
        authorization: approveIntent(world, intent),
        transaction: txParams({ maxFeePerGas: "50000000000" }),
      }),
      "fee_cap_exceeded",
    );
    await refused(
      world.t.client.sign({
        intent,
        authorization: approveIntent(world, intent),
        transaction: txParams({ maxPriorityFeePerGas: "3000000000" }),
      }),
      "fee_cap_exceeded",
    );
  });

  it("refuses a wallet with no policy", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const bare = newId("wal");
    await t.client.createWallet({
      workspaceId: world.workspaceId,
      walletId: bare,
      kind: "treasury",
      label: "t",
    });
    const intent = { ...intentFor(world), walletId: bare };
    await refused(
      t.client.sign({
        intent,
        authorization: approveIntent(world, intent),
        transaction: txParams(),
      }),
      "policy_missing",
    );
  });
});

describe("request authentication and the route surface", () => {
  async function raw(
    t: ReturnType<typeof startSigner>,
    method: string,
    path: string,
    options: { body?: string; secret?: Uint8Array; timestamp?: number; signedBody?: string } = {},
  ) {
    const body = options.body ?? "";
    const timestamp = options.timestamp ?? t.clock.value;
    const signature = signRequest(options.secret ?? t.secret, {
      method,
      pathWithQuery: path,
      timestamp,
      body: new TextEncoder().encode(options.signedBody ?? body),
    });
    return t.signer.app.request(`http://signer.test${path}`, {
      method,
      headers: { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: String(timestamp) },
      ...(method === "GET" ? {} : { body }),
    });
  }

  it("answers the health check without a signature", async () => {
    const t = startSigner();
    const response = await t.signer.app.request("http://signer.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "0.1.0" });
  });

  it("refuses a bad, stale or replayed-with-another-body signature", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const path = `/v1/workspaces/${world.workspaceId}`;
    expect((await raw(t, "GET", path)).status).toBe(200);
    const wrongKey = await raw(t, "GET", path, { secret: new Uint8Array(32).fill(7) });
    expect(wrongKey.status).toBe(401);
    expect(await wrongKey.json()).toEqual({
      error: {
        code: "unauthenticated",
        message: "the request signature is missing, invalid or stale",
      },
    });
    expect((await raw(t, "GET", path, { timestamp: t.clock.value - 61 })).status).toBe(401);
    const unsigned = await t.signer.app.request(`http://signer.test${path}`);
    expect(unsigned.status).toBe(401);
    const swapped = await raw(t, "POST", `${path}/pause`, { body: "{}", signedBody: "{ }" });
    expect(swapped.status).toBe(401);
    expect((await t.client.getWorkspace(world.workspaceId)).paused).toBe(false);
  });

  it("refuses every mandate route without the control plane's valid request signature", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const mandateId = newId("mnd");
    const routes = [
      ["PUT", `/v1/mandates/${mandateId}`],
      ["GET", `/v1/mandates/${mandateId}`],
      ["GET", `/v1/wallets/${world.walletId}/mandates`],
      ["POST", `/v1/mandates/${mandateId}/revoke`],
      ["POST", `/v1/mandates/${mandateId}/sign`],
    ] as const;
    for (const [method, path] of routes) {
      const body = method === "GET" ? "" : JSON.stringify({ workspaceId: world.workspaceId });
      for (const response of [
        await t.signer.app.request(`http://signer.test${path}`, {
          method,
          ...(method === "GET" ? {} : { body }),
        }),
        await raw(t, method, path, { body, secret: new Uint8Array(32).fill(7) }),
        await raw(t, method, path, { body, timestamp: t.clock.value - 61 }),
        // The `approve` service's secret reaches the confirm routes only.
        await raw(t, method, path, { body, secret: t.confirmSecret }),
      ]) {
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(SignerErrorBody.parse(await response.json()).error.code).toBe("unauthenticated");
      }
    }
    // With the control plane's secret the same requests reach the mandate code.
    expect((await raw(t, "GET", `/v1/mandates/${mandateId}`)).status).toBe(404);
    expect((await raw(t, "GET", `/v1/wallets/${world.walletId}/mandates`)).status).toBe(200);
    expect((await raw(t, "GET", "/v1/mandates/not-an-id")).status).toBe(400);
  });

  it("answers 404 to every path and method outside the contract, signed or not", async () => {
    const t = startSigner();
    const world = await setUpWorld(t);
    const outside = [
      ["POST", "/v1/sign-message"],
      ["POST", "/v1/sign-typed-data"],
      ["POST", "/v1/sign-hash"],
      ["POST", "/v1/sign-authorization"],
      ["POST", `/v1/wallets/${world.walletId}/sign`],
      ["POST", `/v1/wallets/${world.walletId}/export`],
      ["GET", "/v1/sign"],
      ["DELETE", `/v1/wallets/${world.walletId}`],
      ["POST", "/healthz"],
      ["GET", "/"],
      ["GET", "/v1/mandates"],
      ["POST", "/v1/mandates"],
      ["DELETE", `/v1/mandates/${newId("mnd")}`],
      ["POST", `/v1/mandates/${newId("mnd")}/resume`],
      ["POST", `/v1/mandates/${newId("mnd")}/uses`],
      ["PUT", `/v1/wallets/${world.walletId}/mandates`],
    ] as const;
    for (const [method, path] of outside) {
      for (const response of [
        await raw(t, method, path, { body: method === "GET" ? "" : "{}" }),
        await t.signer.app.request(`http://signer.test${path}`, { method }),
      ]) {
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: "not_found", message: "not found" },
        });
      }
    }
  });

  it("refuses a malformed body as invalid_request", async () => {
    const t = startSigner();
    const response = await raw(t, "POST", "/v1/sign", { body: "{not json" });
    expect(response.status).toBe(400);
    const wrongShape = await raw(t, "POST", "/v1/sign", { body: JSON.stringify({ intent: 1 }) });
    expect(wrongShape.status).toBe(400);
  });
});
