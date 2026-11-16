import {
  createPublicClient,
  createTestClient,
  type Hash,
  http,
  TransactionReceiptNotFoundError,
} from "viem";
import { foundry } from "viem/chains";
import { stack } from "./stack.ts";

/** The stack's local chain, read the way anyone reads a chain. */
export const chain = createPublicClient({
  chain: foundry,
  transport: http(stack.anvilUrl),
  cacheTime: 0,
});

/** Anvil's own controls (balances, mining, its pool), which only a local test chain has. */
export const chainAdmin = createTestClient({
  chain: foundry,
  mode: "anvil",
  transport: http(stack.anvilUrl),
});

/** The receipt of `hash`, or null while no block holds that transaction. */
export async function receiptOf(hash: Hash) {
  return chain.getTransactionReceipt({ hash }).catch((error: unknown) => {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  });
}

/**
 * Run `body` while the chain mines nothing by itself, so a transaction the server sends stays in
 * the node's pool, unmined, until the gate says otherwise. Every new attempt the server sends
 * replaces the older one in the pool: Anvil takes a replacement whose fee cap is higher.
 *
 * Why this way and not a raised base fee: the server's next fee is at least twice the latest
 * block's base fee plus the tip, cut to the fee ceiling the person approved, so a base fee raised
 * above the first attempt pushes the first reprice straight to that ceiling, and what Anvil does
 * with a pooled transaction the next block cannot pay for is its own business. With mining held,
 * nothing lands before the gate decides, whatever the fees are, and only the transactions the
 * stack sends meanwhile wait. The gates run one at a time, so no other gate sends any.
 *
 * `resume` mines one block with whatever the pool holds, then turns automatic mining back on, so
 * a held transaction lands once, at the moment the gate chooses. Whatever happens in `body`, the
 * chain mines by itself again afterwards, with nothing left in its pool, as every other gate
 * expects.
 */
export async function withMiningHeld<T>(
  body: (mining: { resume(): Promise<void> }) => Promise<T>,
): Promise<T> {
  let held = true;

  const resume = async () => {
    if (!held) return;
    await chainAdmin.mine({ blocks: 1 });
    await chainAdmin.setAutomine(true);
    held = false;
  };

  await chainAdmin.setAutomine(false);

  try {
    return await body({ resume });
  } finally {
    await resume();
  }
}
