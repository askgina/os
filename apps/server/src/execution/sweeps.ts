import type { ApprovalSummary } from "@askgina/os-api";
import {
  type Address,
  type AssetRef,
  type ChainId,
  PROTOCOL_VERSION,
  Sweep,
  sweepHash,
  type UserId,
  type WorkspaceId,
} from "@askgina/os-protocol";
import { SignerError } from "@askgina/os-protocol/signer";
import { and, eq, ne } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { z } from "zod";
import { ApprovalFailure, type ApprovalKindHandler } from "../approvals/kinds.ts";
import { appendAudit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { wallets, workspaces } from "../db/schema.ts";
import { loadWallet, walletSummary } from "../directory/views.ts";
import { HttpError } from "../http/errors.ts";
import { engineOf } from "./approvals.ts";
import { ChainError, chainAccess } from "./chains.ts";
import {
  type ExecutionOptions,
  FALLBACK_GAS,
  followUpTransaction,
  GAS_MARGIN_PERCENT,
  releaseNonce,
  signOnce,
  transactionInfo,
  transactionOf,
} from "./transactions.ts";

/**
 * `sweep-wallet`: a person empties one asset of a wallet, with no agent and no cap, at the
 * workspace's admin threshold. The signer sends only to an address on the wallet's recipient
 * allowlist or to a treasury wallet of the same workspace, so the control plane does not filter
 * the destination itself: a refusal comes back from the signer and ends the request as failed.
 * Signing, the nonce, the broadcast and the follow-up are the same as an intent's.
 */

/**
 * What `sweep-wallet` keeps sealed in its approval's detail. The sweep was sealed as `Sweep`
 * parsed it, so parsing it again changes nothing that is hashed or sent.
 */
const SweepDetail = z.object({
  sweep: Sweep,
  assetSymbol: z.string(),
  assetDecimals: z.number(),
  /** The simulation's gas estimate, decimal, or the fallback when it failed. */
  gasEstimate: z.string(),
});

type SweepDetail = z.infer<typeof SweepDetail>;

/**
 * Open a request to sweep `asset` from the wallet to `to`. The amount is fixed now, from the
 * chain: all of a token, or the native coin less the fee ceiling, so the transfer and its fee
 * fit what the wallet holds. Allowed while the workspace is paused: emptying a wallet is how a
 * paused workspace is wound down.
 */
export async function requestSweep(
  ctx: AppContext,
  input: {
    workspaceId: WorkspaceId;
    walletId: string;
    chainId: ChainId;
    asset: AssetRef;
    to: Address;
    requestedBy: UserId;
  },
): Promise<ApprovalSummary> {
  const chains = chainAccess(ctx);

  if (!chains.has(input.chainId)) {
    throw new HttpError("invalid_request", "chainId: this chain is not configured");
  }

  const { wallet } = await loadWallet(ctx, input.workspaceId, input.walletId);

  const [workspace] = await ctx.db
    .select({ adminThreshold: workspaces.adminThreshold })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId));

  if (!workspace) throw new HttpError("not_found", "no such workspace");

  // The signer's copy of the policy decides the fee ceiling it will accept.
  const state = await ctx.signer.getWallet(wallet.id).catch((cause: unknown) => {
    throw new HttpError(
      "internal",
      "the signer could not be reached",
      cause instanceof SignerError ? cause.code : undefined,
    );
  });

  const read = async () => {
    const [balance] = await chains.balances(wallet.address, [
      { chainId: input.chainId, asset: input.asset },
    ]);

    if (!balance) throw new HttpError("internal", "the balance could not be read");

    // The gas of the transfer does not depend on the amount, so one base unit stands in for it.
    const transfer =
      input.asset === "native"
        ? { to: input.to, value: 1n, data: undefined }
        : {
            to: input.asset,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [input.to, 1n],
            }),
          };

    const simulated = await chains.simulate({
      chainId: input.chainId,
      from: wallet.address,
      ...transfer,
    });

    return { balance, simulated, fees: await chains.fees(input.chainId) };
  };

  const { balance, simulated, fees } = await read().catch((cause: unknown) => {
    if (cause instanceof ChainError) {
      throw new HttpError("internal", "the chain could not be read", cause.code);
    }

    throw cause;
  });

  const estimate = simulated.gasEstimate ?? FALLBACK_GAS;
  const gas = (estimate * GAS_MARGIN_PERCENT) / 100n;
  const wanted = 2n * gas * (2n * fees.baseFeePerGas + fees.maxPriorityFeePerGas);
  const ceiling = state.policy ? BigInt(state.policy.fees.maxPerTxWei) : wanted;
  // biome-ignore lint/complexity/useMathMinMax: Math.min does not take bigints
  const maxFeeWei = wanted < ceiling ? wanted : ceiling;
  const held = BigInt(balance.amount);
  const amount = input.asset === "native" ? held - maxFeeWei : held;

  if (amount <= 0n) {
    throw new HttpError(
      "conflict",
      input.asset === "native"
        ? "the wallet holds no more than the network fee"
        : "the wallet holds none of this token",
      "nothing_to_sweep",
    );
  }

  const parsed = Sweep.safeParse({
    v: PROTOCOL_VERSION,
    workspaceId: input.workspaceId,
    walletId: wallet.id,
    chainId: input.chainId,
    asset: input.asset,
    amount: amount.toString(),
    to: input.to,
    maxFeeWei: maxFeeWei.toString(),
  });

  if (!parsed.success) {
    // The zero address, or a token sent to its own contract: both lose the funds.
    throw new HttpError("invalid_request", "to: a sweep cannot be sent there");
  }

  const sweep = parsed.data;

  const detail: SweepDetail = {
    sweep,
    assetSymbol: balance.symbol,
    assetDecimals: balance.decimals,
    gasEstimate: estimate.toString(),
  };

  return ctx.approvals.open({
    workspaceId: input.workspaceId,
    kind: "sweep-wallet",
    subjectId: wallet.id,
    envelope: { walletId: wallet.id, chainId: input.chainId, sweepHash: sweepHash(sweep) },
    threshold: workspace.adminThreshold,
    ttlSeconds: ctx.config.adminApprovalTtlSeconds,
    detail,
    requestedBy: { type: "user", id: input.requestedBy },
    alongside: (tx) =>
      appendAudit(
        ctx,
        {
          workspaceId: input.workspaceId,
          actor: { type: "user", id: input.requestedBy },
          action: "wallet.sweep_requested",
          subject: { type: "wallet", id: wallet.id },
          detail: { sweep },
        },
        tx,
      ),
  });
}

const sweepWallet: ApprovalKindHandler<"sweep-wallet"> = {
  kind: "sweep-wallet",
  async title(_ctx, _approval, detail) {
    const { sweep, assetSymbol, assetDecimals } = SweepDetail.parse(detail);
    const amount = formatUnits(BigInt(sweep.amount), assetDecimals);

    return `Empty ${amount} ${assetSymbol} from the wallet to ${sweep.to.slice(0, 6)}…${sweep.to.slice(-4)}`;
  },
  async describe(ctx, approval, detail) {
    const { sweep, assetSymbol, assetDecimals } = SweepDetail.parse(detail);
    const { wallet, agentId } = await loadWallet(ctx, approval.workspaceId, sweep.walletId);

    const [treasury] = await ctx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.workspaceId, approval.workspaceId),
          eq(wallets.kind, "treasury"),
          eq(wallets.address, sweep.to),
          ne(wallets.id, wallet.id),
        ),
      );

    const recipients = wallet.policy?.recipients;
    const transaction = await transactionOf(ctx, approval.id);

    return {
      kind: "sweep-wallet",
      wallet: walletSummary(wallet, agentId),
      sweep,
      sweepHash: sweepHash(sweep),
      assetSymbol,
      assetDecimals,
      destination:
        recipients?.mode === "allowlist" && recipients.addresses.includes(sweep.to)
          ? "allowlist"
          : treasury
            ? "treasury"
            : null,
      transaction: transaction
        ? await transactionInfo(ctx, approval.workspaceId, transaction)
        : null,
    };
  },
  async confirmationSubject(_ctx, _approval, detail) {
    return { kind: "sweep-wallet", sweep: SweepDetail.parse(detail).sweep };
  },
  async execute(ctx, approval, authorization, detail) {
    const { sweep, gasEstimate } = SweepDetail.parse(detail);

    if (await transactionOf(ctx, approval.id)) return;

    const [wallet] = await ctx.db.select().from(wallets).where(eq(wallets.id, sweep.walletId));

    if (!wallet) throw new ApprovalFailure("wallet_missing", "the wallet no longer exists");
    await signOnce(ctx, {
      approval,
      wallet,
      chainId: sweep.chainId,
      maxFeeWei: BigInt(sweep.maxFeeWei),
      gasEstimate: BigInt(gasEstimate),
      intentId: null,
      sign: (transaction) => ctx.signer.sweep(wallet.id, { sweep, authorization, transaction }),
      stored: (tx) =>
        appendAudit(
          ctx,
          {
            workspaceId: approval.workspaceId,
            actor: { type: "system", id: null },
            action: "wallet.swept",
            subject: { type: "wallet", id: wallet.id },
            detail: { approvalId: approval.id },
          },
          tx,
        ),
    });
  },
  async abandon(ctx, approval) {
    // Ended without a signature we stored: a reserved nonce goes back to the wallet.
    await releaseNonce(ctx, approval.id);
  },
};

export function registerSweepKind(ctx: AppContext, options: ExecutionOptions): void {
  const engine = engineOf(ctx);
  engine.register(sweepWallet);
  engine.registerFollowUp("sweep-wallet", async (context, approval) => {
    const transaction = await transactionOf(context, approval.id);

    if (!transaction) return { done: true, waitSeconds: 0 };

    return followUpTransaction(context, approval, transaction, options);
  });
}
