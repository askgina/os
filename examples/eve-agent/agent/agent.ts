import { defineAgent } from "eve";
import { model } from "../lib/model.ts";

export default defineAgent({
  model,
  // Needed because the model is not looked up in the AI Gateway's catalog, which would also
  // mean a request to Vercel at build time.
  modelContextWindowTokens: Number(process.env.MODEL_CONTEXT_WINDOW_TOKENS || 64_000),
  experimental: {
    workflow: {
      // The encrypting Postgres World: everything the agent says, hears and passes to tools is
      // stored as ciphertext. EVE_WORKFLOW_WORLD exists only so the smoke test can build the
      // same agent on the stock World as a control for its plaintext scanner; never set it.
      world: process.env.EVE_WORKFLOW_WORLD || "@askgina/os-world/target",
    },
  },
});
