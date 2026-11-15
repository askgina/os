import type { DatabaseSync } from "node:sqlite";
import {
  type Address,
  type ApprovalId,
  type Authorization,
  type Cloid,
  type Envelope,
  evaluateIntent,
  type Hex32,
  intentHash,
  intentSpend,
  type VenueIntent,
  type VenueNetwork,
  type WalletId,
  type WalletPolicy,
  type WorkspaceId,
} from "@askgina/os-protocol";
import {
  type CancelVenueOrderResponse,
  HyperliquidAction,
  HyperliquidRequest,
  type SignVenueRequest,
  type SignVenueResponse,
} from "@askgina/os-protocol/signer";
import { transaction } from "./db.ts";
import { SignerFailure } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { ApprovalRow, WalletRow, WorkspaceRow } from "./signer.ts";
import {
  cancelByCloidAction,
  cloidFor,
  type HyperliquidPayload,
  type HyperliquidSignature,
  l1ActionHash,
  nextNonce,
  orderAction,
  withdrawAction,
} from "./venues/hyperliquid.ts";
import { encodeMsgpack, jsonToMsgpack, MsgpackMap, msgpackToJson } from "./venues/msgpack.ts";

/**
 * Venue actions (`docs/approval-protocol.md`, section 8, "Venue orders"). The signer takes an
 * approved venue intent and returns the exact request body to post to the venue: it builds the
 * action from the intent with its own code, picks the nonce and the expiry, signs exactly one
 * action per approval, and records it. There is no route that takes an action, typed data, a
 * message or a hash from the caller.
 *
 * Approving an order includes the right to cancel it (owner decision D4): the signer signs
 * `cancelByCloid` for an order it signed, with no passkey, also while the workspace is paused.
 */

/** Decision-log actions, distinct from the EVM `sign`, `reprice` and `cancel-transaction`. */
export const VENUE_ACTIONS = { sign: "sign-venue", cancel: "cancel-venue-order" } as const;

/**
 * The venue networks this signer signs for. Mainnet waits on owner decision D2 (legal and
 * geographic, `specs/non-evm-operations.md`): until it is answered, a mainnet venue intent is
 * refused as `policy_denied` with `venue_not_allowed`, whatever the wallet's policy names.
 */
export const SIGNABLE_VENUE_NETWORKS: readonly VenueNetwork[] = ["hyperliquid:testnet"];

const DAY_SECONDS = 86_400;

/** The submit window a policy may set, in seconds (`HyperliquidRules.submitWindowSeconds`). */
const MIN_WINDOW_SECONDS = 5;
const MAX_WINDOW_SECONDS = 300;

type VenueSignatureRow = {
  approval_id: string;
  wallet_id: string;
  network: string;
  kind: "order" | "withdraw";
  asset: number | null;
  cloid: string | null;
  action_nonce: number;
  expires_after: number | null;
  connection_hash: string | null;
  request: string;
  signed_at: number;
};

type VenueCancelRow = {
  approval_id: string;
  seq: number;
  action_nonce: number;
  expires_after: number;
  request: string;
  signed_at: number;
};

/** What the venue operations need from the signer core (`signer.ts`). */
export interface VenueInternals {
  db: DatabaseSync;
  /** The signer's clock, in seconds. Venue nonces and expiries are this times 1000. */
  now: () => number;
  log: Logger;
  maxIntentTtlSeconds: number;
  decide<T>(
    workspaceId: string,
    approvalId: string | null,
    action: string,
    work: (allow: () => void) => T | Promise<T>,
  ): Promise<T>;
  verify(
    authorization: Authorization,
    workspaceId: string,
    threshold: number,
    maxTtlSeconds: number,
  ): Promise<void>;
  requireWorkspace(workspaceId: string): WorkspaceRow;
  assertNotDeleted(workspaceId: string): WorkspaceRow;
  assertCanSign(workspaceId: string, walletId: string): void;
  findWallet(walletId: string): WalletRow | undefined;
  currentPolicy(walletId: string): { policy: WalletPolicy; hash: string } | null;
  spentSince(walletId: string, since: number): Map<string, bigint>;
  findApproval(approvalId: string): ApprovalRow | undefined;
  priorOutcome(envelope: Envelope, state: "signed" | "applied"): "replay" | null;
  assertNotFenced(envelope: Envelope): void;
  assertApproversStillPresent(authorization: Authorization, workspaceId: string): void;
  consumeNonce(envelope: Envelope): void;
  recordApproval(
    approvalId: string,
    workspaceId: string,
    state: "signed" | "applied",
    digest: string,
  ): void;
  envelopeDigest(envelope: Envelope): string;
  /** Sign with the wallet's key and check the signature (`vault_error`); records nothing. */
  signHyperliquidWith(wallet: WalletRow, payload: HyperliquidPayload): HyperliquidSignature;
}

/** One signed venue action, before it is recorded. */
type SignedAction = {
  kind: "order" | "withdraw";
  asset: number | null;
  cloid: Cloid | null;
  nonce: number;
  expiresAfter: number | null;
  connectionId: Hex32 | null;
  request: HyperliquidRequest;
};

export function createVenueOperations(internals: VenueInternals) {
  const { db, now, log } = internals;

  function venueSignatureOf(approvalId: string): VenueSignatureRow | undefined {
    return db.prepare("SELECT * FROM venue_signatures WHERE approval_id = ?").get(approvalId) as
      | VenueSignatureRow
      | undefined;
  }

  /**
   * The wallet's next action nonce on the network, recorded as its last: the clock in
   * milliseconds, but always above every nonce this wallet used there (`nextNonce`). Runs inside
   * the signing transaction, so a refusal after it leaves the ledger as it was.
   */
  function takeNonce(walletId: string, network: VenueNetwork, nowMs: number): number {
    const row = db
      .prepare("SELECT last_nonce FROM venue_nonces WHERE wallet_id = ? AND network = ?")
      .get(walletId, network) as { last_nonce: number } | undefined;
    const nonce = nextNonce(row?.last_nonce ?? null, nowMs);
    db.prepare(
      "INSERT INTO venue_nonces (wallet_id, network, last_nonce) VALUES (?, ?, ?) ON CONFLICT (wallet_id, network) DO UPDATE SET last_nonce = excluded.last_nonce",
    ).run(walletId, network, nonce);
    return nonce;
  }

  /**
   * The action as the request body carries it, checked before anything is signed: it is one of
   * the contract's actions, and the body read back encodes to exactly the bytes that are hashed.
   * Only a defect in this signer can fail it (`internal`).
   */
  function actionBody(action: MsgpackMap | object): HyperliquidAction {
    const hashed = action instanceof MsgpackMap;
    const parsed = HyperliquidAction.safeParse(hashed ? msgpackToJson(action) : action);
    if (
      !parsed.success ||
      (hashed &&
        !Buffer.from(encodeMsgpack(jsonToMsgpack(parsed.data))).equals(
          Buffer.from(encodeMsgpack(action)),
        ))
    ) {
      log.error("venue action does not match its request body", {});
      throw new SignerFailure("internal");
    }
    return parsed.data;
  }

  /** The request body, checked against the contract after signing; `internal` otherwise. */
  function requestBody(body: HyperliquidRequest): HyperliquidRequest {
    const parsed = HyperliquidRequest.safeParse(body);
    if (!parsed.success) {
      log.error("venue request does not match the contract", {});
      throw new SignerFailure("internal");
    }
    return parsed.data;
  }

  /**
   * Build, sign and check the one action of an approved intent. An order is placed by client
   * order id `cloidFor(approvalId)`, unusable after the signer's clock plus the policy's submit
   * window; a withdrawal goes to the wallet's own address, which the intent has no field to
   * change, with its `time` as its nonce and no expiry (the venue does not support one there).
   */
  function signIntent(
    wallet: WalletRow,
    intent: VenueIntent,
    approvalId: ApprovalId,
    submitWindowSeconds: number,
    nowMs: number,
  ): SignedAction {
    const network = intent.chainId;
    const { operation } = intent;
    const nonce = takeNonce(wallet.wallet_id, network, nowMs);
    if (operation.type === "hyperliquid.order") {
      const cloid = cloidFor(approvalId);
      const action = orderAction(operation, cloid);
      const body = actionBody(action);
      const expiresAfter = nowMs + submitWindowSeconds * 1000;
      const connectionId = l1ActionHash(action, nonce, expiresAfter);
      const signature = internals.signHyperliquidWith(wallet, {
        kind: "l1",
        network,
        connectionId,
      });
      return {
        kind: "order",
        asset: operation.asset,
        cloid,
        nonce,
        expiresAfter,
        connectionId,
        request: requestBody({ action: body, nonce, signature, vaultAddress: null, expiresAfter }),
      };
    }
    const destination = wallet.address as Address;
    const body = actionBody(withdrawAction(network, destination, operation.amount, nonce));
    const signature = internals.signHyperliquidWith(wallet, {
      kind: "withdraw",
      network,
      destination,
      amount: operation.amount,
      time: nonce,
    });
    return {
      kind: "withdraw",
      asset: null,
      cloid: null,
      nonce,
      expiresAfter: null,
      connectionId: null,
      request: requestBody({
        action: body,
        nonce,
        signature,
        vaultAddress: null,
        expiresAfter: null,
      }),
    };
  }

  /** What a repeat of a signed venue approval gets: the same body, read back from the record. */
  function storedResponse(approvalId: string): SignVenueResponse {
    const row = venueSignatureOf(approvalId);
    // Signed with this envelope through another route: it was never a venue signature.
    if (!row) throw new SignerFailure("conflict");
    const wallet = internals.findWallet(row.wallet_id);
    if (!wallet) throw new SignerFailure("internal");
    // Emptied when the wallet's key was destroyed: there is nothing left to hand back.
    if (row.request === "") throw new SignerFailure("wallet_retired");
    return {
      approvalId: row.approval_id as ApprovalId,
      walletId: row.wallet_id as WalletId,
      network: row.network as VenueNetwork,
      account: wallet.address as Address,
      cloid: row.cloid as Cloid | null,
      request: JSON.parse(row.request) as HyperliquidRequest,
    };
  }

  /**
   * Sign the one action of an approved venue intent. The checks follow `sign` (`signer.ts`) in
   * the same order; every refusal is recorded under `sign-venue`.
   */
  async function signVenue(request: SignVenueRequest): Promise<SignVenueResponse> {
    const { intent, authorization } = request;
    const { envelope } = authorization;
    internals.requireWorkspace(envelope.workspaceId);
    return internals.decide(
      envelope.workspaceId,
      envelope.approvalId,
      VENUE_ACTIONS.sign,
      async (allow) => {
        internals.assertNotDeleted(envelope.workspaceId);
        // Idempotency first: a retry of an approval already signed gets the same body.
        if (internals.priorOutcome(envelope, "signed") === "replay") {
          return storedResponse(envelope.approvalId);
        }
        internals.assertNotFenced(envelope);

        if (envelope.type !== "approve-intent") throw new SignerFailure("envelope_mismatch");
        const wallet = internals.findWallet(envelope.walletId);
        if (!wallet) throw new SignerFailure("not_found");
        if (
          wallet.workspace_id !== envelope.workspaceId ||
          intent.workspaceId !== envelope.workspaceId ||
          intent.walletId !== envelope.walletId ||
          intent.agentId !== envelope.agentId ||
          intent.chainId !== envelope.chainId
        ) {
          throw new SignerFailure("envelope_mismatch");
        }
        if (intentHash(intent) !== envelope.intentHash) throw new SignerFailure("intent_mismatch");
        if (!SIGNABLE_VENUE_NETWORKS.includes(intent.chainId)) {
          throw new SignerFailure("policy_denied", "venue_not_allowed");
        }

        internals.assertCanSign(envelope.workspaceId, wallet.wallet_id);
        if (internals.requireWorkspace(envelope.workspaceId).paused === 1) {
          throw new SignerFailure("workspace_paused");
        }
        const policy = internals.currentPolicy(wallet.wallet_id);
        if (!policy) throw new SignerFailure("policy_missing");
        if (policy.hash !== envelope.policyHash) throw new SignerFailure("policy_changed");

        await internals.verify(
          authorization,
          envelope.workspaceId,
          policy.policy.approvals.threshold,
          Math.min(policy.policy.approvals.ttlSeconds, internals.maxIntentTtlSeconds),
        );

        // The critical section. Synchronous from here to COMMIT: the nonce, the ledger, the
        // venue nonce and the record cannot be seen half-done by another request.
        return transaction(db, () => {
          internals.assertNotDeleted(envelope.workspaceId);
          if (internals.priorOutcome(envelope, "signed") === "replay") {
            return storedResponse(envelope.approvalId);
          }
          internals.assertNotFenced(envelope);
          internals.assertCanSign(envelope.workspaceId, wallet.wallet_id);
          if (internals.requireWorkspace(envelope.workspaceId).paused === 1) {
            throw new SignerFailure("workspace_paused");
          }
          const live = internals.currentPolicy(wallet.wallet_id);
          if (!live || live.hash !== envelope.policyHash) {
            throw new SignerFailure("policy_changed");
          }
          internals.assertApproversStillPresent(authorization, envelope.workspaceId);
          internals.consumeNonce(envelope);

          const nowSeconds = now();
          const spent = internals.spentSince(wallet.wallet_id, nowSeconds - DAY_SECONDS);
          const decision = evaluateIntent(
            live.policy,
            intent,
            (chainId, asset) => spent.get(`${chainId}|${asset}`) ?? 0n,
          );
          if (!decision.allowed) throw new SignerFailure("policy_denied", decision.code);
          // `evaluateIntent` allows a venue intent only under the venue's rules.
          const rules = live.policy.venues?.hyperliquid;
          if (rules === undefined) throw new SignerFailure("internal");

          const signed = signIntent(
            wallet,
            intent,
            envelope.approvalId,
            rules.submitWindowSeconds,
            nowSeconds * 1000,
          );
          internals.recordApproval(
            envelope.approvalId,
            envelope.workspaceId,
            "signed",
            internals.envelopeDigest(envelope),
          );
          db.prepare(
            "INSERT INTO venue_signatures (approval_id, wallet_id, network, kind, asset, cloid, action_nonce, expires_after, connection_hash, request, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            envelope.approvalId,
            wallet.wallet_id,
            intent.chainId,
            signed.kind,
            signed.asset,
            signed.cloid,
            signed.nonce,
            signed.expiresAfter,
            signed.connectionId,
            JSON.stringify(signed.request),
            nowSeconds,
          );
          // A reduce-only order counts against its market's per-order cap only, and a
          // withdrawal against nothing: neither is a spend of the daily cap.
          const spend = intentSpend(intent);
          if (spend.daily) {
            db.prepare(
              "INSERT INTO spends (approval_id, wallet_id, chain_id, asset, amount, at) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              envelope.approvalId,
              wallet.wallet_id,
              intent.chainId,
              spend.asset,
              spend.amount.toString(),
              nowSeconds,
            );
          }
          allow();
          return {
            approvalId: envelope.approvalId,
            walletId: wallet.wallet_id as WalletId,
            network: intent.chainId,
            account: wallet.address as Address,
            cloid: signed.cloid,
            request: signed.request,
          };
        });
      },
    );
  }

  function cancelResponse(order: VenueSignatureRow, row: VenueCancelRow): CancelVenueOrderResponse {
    return {
      approvalId: order.approval_id as ApprovalId,
      cloid: order.cloid as Cloid,
      request: JSON.parse(row.request) as HyperliquidRequest,
    };
  }

  /**
   * Sign the cancel of an order this signer signed, by the order's approval id. Needs no passkey
   * and is allowed while the workspace is paused or being deleted and while the wallet is
   * retiring (owner decision D4): a cancel moves nothing and only removes what people approved.
   * Within a cancel's own expiry the same cancel is returned, so retries post identical bytes;
   * after it, a new cancel with a larger nonce. Refused once the key is destroyed.
   */
  function cancelVenueOrder(
    approvalId: ApprovalId,
    workspaceId: WorkspaceId,
  ): Promise<CancelVenueOrderResponse> {
    internals.requireWorkspace(workspaceId);
    return internals.decide(workspaceId, approvalId, VENUE_ACTIONS.cancel, (allow) =>
      transaction(db, () => {
        internals.assertNotDeleted(workspaceId);
        const approval = internals.findApproval(approvalId);
        const order = venueSignatureOf(approvalId);
        // Only what this database signed in this workspace: after a restore, an order signed
        // after the backup is unknown here and cannot be cancelled through the signer (D9).
        if (!approval || approval.workspace_id !== workspaceId || !order) {
          throw new SignerFailure("not_found");
        }
        if (
          order.kind !== "order" ||
          order.asset === null ||
          order.cloid === null ||
          order.expires_after === null
        ) {
          throw new SignerFailure("conflict");
        }
        const wallet = internals.findWallet(order.wallet_id);
        if (!wallet) throw new SignerFailure("internal");
        // A destroyed key signs nothing, and the requests signed with it were emptied.
        if (wallet.state === "destroyed") throw new SignerFailure("wallet_retired");

        const nowMs = now() * 1000;
        const latest = db
          .prepare("SELECT * FROM venue_cancels WHERE approval_id = ? ORDER BY seq DESC LIMIT 1")
          .get(approvalId) as VenueCancelRow | undefined;
        if (latest && latest.expires_after > nowMs) return cancelResponse(order, latest);

        // The order's own submit window, as people approved it with the order: a later policy
        // neither shortens nor lengthens how long its cancel may wait to be posted.
        const windowMs = order.expires_after - order.signed_at * 1000;
        if (windowMs < MIN_WINDOW_SECONDS * 1000 || windowMs > MAX_WINDOW_SECONDS * 1000) {
          throw new SignerFailure("internal");
        }
        const network = order.network as VenueNetwork;
        const nonce = takeNonce(wallet.wallet_id, network, nowMs);
        const expiresAfter = nowMs + windowMs;
        const action = cancelByCloidAction(order.asset, order.cloid as Cloid);
        const body = actionBody(action);
        const signature = internals.signHyperliquidWith(wallet, {
          kind: "l1",
          network,
          connectionId: l1ActionHash(action, nonce, expiresAfter),
        });
        const request = requestBody({
          action: body,
          nonce,
          signature,
          vaultAddress: null,
          expiresAfter,
        });
        const row: VenueCancelRow = {
          approval_id: approvalId,
          seq: (latest?.seq ?? 0) + 1,
          action_nonce: nonce,
          expires_after: expiresAfter,
          request: JSON.stringify(request),
          signed_at: now(),
        };
        db.prepare(
          "INSERT INTO venue_cancels (approval_id, seq, action_nonce, expires_after, request, signed_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          row.approval_id,
          row.seq,
          row.action_nonce,
          row.expires_after,
          row.request,
          row.signed_at,
        );
        allow();
        return cancelResponse(order, row);
      }),
    );
  }

  /** The client order id of a signed venue order, for `GET /v1/approvals/:id`; null otherwise. */
  function cloidOf(approvalId: string): Cloid | null {
    return (venueSignatureOf(approvalId)?.cloid as Cloid | null | undefined) ?? null;
  }

  /** True when the approval's one signature is a venue request, not a transaction. */
  function isVenueSigned(approvalId: string): boolean {
    return venueSignatureOf(approvalId) !== undefined;
  }

  return { signVenue, cancelVenueOrder, cloidOf, isVenueSigned };
}
