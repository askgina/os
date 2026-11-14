import { defineTool } from "eve/tools";
import { z } from "zod";
import { callGateway } from "../../lib/gateway.ts";

export default defineTool({
  description:
    "Read one of your proposals. With waitSeconds (up to 50), wait for its status to change first. Final statuses: confirmed, reverted, stuck, rejected, expired, cancelled, denied, failed.",
  inputSchema: z.object({
    intentId: z.string().describe("The intentId propose_transfer returned."),
    waitSeconds: z.number().int().min(0).max(50).optional(),
  }),
  async execute(input) {
    return callGateway("get_intent", { ...input });
  },
});
