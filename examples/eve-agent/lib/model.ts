/**
 * The model the agent thinks with, chosen by the environment when the agent starts. eve
 * resolves a model given as a string through Vercel's AI Gateway, so this always hands eve a
 * provider object instead.
 *
 * - `OFFLINE_MODEL=1`: the deterministic smoke-test model in `offline-model.ts`.
 * - Otherwise `MODEL_BASE_URL`, `MODEL_API_KEY` and `MODEL_ID`: any OpenAI-compatible chat
 *   completions endpoint the operator runs or subscribes to.
 *
 * `eve build` evaluates the agent definition too, with none of these set (an image must not
 * contain a model key), so the choice is made on the first call rather than at import.
 */
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { MockLanguageModelV4 } from "ai/test";
import { offlineModel } from "./offline-model.ts";

type LanguageModel = Pick<MockLanguageModelV4, "doGenerate" | "doStream" | "supportedUrls">;

let chosen: LanguageModel | undefined;

function choose(): LanguageModel {
  if (chosen) return chosen;

  if (process.env.OFFLINE_MODEL === "1") {
    chosen = offlineModel;

    return chosen;
  }

  const baseURL = process.env.MODEL_BASE_URL;
  const modelId = process.env.MODEL_ID;

  if (!baseURL || !modelId) {
    throw new Error("no model configured: set MODEL_BASE_URL and MODEL_ID, or OFFLINE_MODEL=1");
  }

  const settings: OpenAICompatibleProviderSettings = { name: "operator", baseURL };

  if (process.env.MODEL_API_KEY) settings.apiKey = process.env.MODEL_API_KEY;
  chosen = createOpenAICompatible(settings).chatModel(modelId);

  return chosen;
}

export const model = {
  specificationVersion: "v4",
  provider: "operator",
  modelId: process.env.MODEL_ID || "configured-at-start",
  get supportedUrls() {
    return choose().supportedUrls;
  },
  doGenerate: (options) => choose().doGenerate(options),
  doStream: (options) => choose().doStream(options),
} satisfies Omit<MockLanguageModelV4, "doGenerateCalls" | "doStreamCalls">;
