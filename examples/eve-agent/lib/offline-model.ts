/**
 * FOR THE SMOKE TEST ONLY. A deterministic stand-in for a language model, so the example can be
 * built and exercised with no model provider and no network.
 *
 * It understands one request: "pay <amount> to <0x address>" (or "send …"). It answers with a
 * `propose_transfer` call for exactly that, and after the tool has answered it replies with the
 * approval link. Anything else gets a one-line refusal. It never calls any other tool.
 */
import { MockLanguageModelV4 } from "ai/test";

type StreamOptions = Parameters<MockLanguageModelV4["doStream"]>[0];

type Message = StreamOptions["prompt"][number];

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

/** One part of the stream the model answers with. */
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** The text a person typed in a user message; nothing for any other message. */
function textOf(message: Message | undefined): string {
  if (message?.role !== "user") return "";

  return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

function reply(text: string): Part[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  ];
}

function respond(prompt: readonly Message[]): Part[] {
  const lastUser = prompt.findLastIndex((message) => message.role === "user");
  const request = textOf(prompt[lastUser]);
  const toolResult = prompt.slice(lastUser + 1).find((message) => message.role === "tool");

  if (toolResult) {
    const output = JSON.stringify(toolResult.content);
    const url = /"approvalUrl":"([^"]+)"/.exec(output)?.[1];
    const mandate = /"mandateId":"(mnd_[^"]+)"/.exec(output)?.[1];

    if (url) return reply(`I proposed it. Nothing is sent until a person approves it here: ${url}`);

    return reply(
      mandate
        ? `I proposed it. A mandate people approved in advance covers it (${mandate}), so it is being sent without asking again.`
        : "The proposal was refused.",
    );
  }

  const to = /0x[0-9a-fA-F]{40}/.exec(request)?.[0];
  const amount = /\b(?:pay|send)\s+([0-9]+(?:\.[0-9]+)?)/i.exec(request)?.[1];

  if (!to || !amount)
    return reply("I can only propose transfers: say 'pay <amount> to <address>'.");

  // The memo quotes the request so the approver sees why; characters the gateway refuses are dropped.
  const memo = `Requested in chat: ${request.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")}`.slice(
    0,
    280,
  );

  const input = {
    chainId: process.env.OFFLINE_CHAIN_ID || "eip155:31337",
    to,
    amount,
    memo,
  };

  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call_${lastUser}`,
      toolName: "propose_transfer",
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
  ];
}

export const offlineModel = new MockLanguageModelV4({
  provider: "askgina-os-offline",
  modelId: "smoke-test",
  doStream: async (options) => {
    const parts = respond(options.prompt);

    return {
      stream: new ReadableStream<Part>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    };
  },
});
