import { defineTool } from "eve/tools";
import { z } from "zod";
import { callGateway } from "../../lib/gateway.ts";

/**
 * Proposes a transfer to the askgina/os control plane and returns at once with the intent id
 * and the link where a person approves it.
 *
 * There is deliberately no eve `approval` on this tool. eve's approval is consent inside eve's
 * own chat, answered over eve's HTTP API; it proves nothing to the signer. The approval that
 * counts is the passkey assertion a person makes in the askgina/os inbox, which the signer
 * verifies itself. Adding eve's gate here would only ask the same person twice and suggest that
 * eve's answer authorizes the payment, which it never does.
 */
export default defineTool({
  description:
    "Propose sending the chain's native coin or an ERC-20 token from your wallet. Nothing is sent: a person must approve the proposal with their passkey. Tell the person the approvalUrl, then use check_intent with the intentId to follow it.",
  inputSchema: z.object({
    chainId: z.string().describe('The chain, as "eip155:<number>".'),
    to: z.string().describe("The recipient's 0x address."),
    amount: z.string().describe('How much, in whole units of the asset, for example "0.05".'),
    asset: z.string().optional().describe('"native" (the default) or the ERC-20 token address.'),
    memo: z
      .string()
      .max(280)
      .describe("Why, in one or two sentences. People read it before approving."),
    walletId: z.string().optional().describe("A wallet id; defaults to yours."),
  }),
  async execute(input) {
    return callGateway("propose_transfer", { ...input });
  },
});
