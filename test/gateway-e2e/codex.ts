import OpenAI from "openai";
import { MAX_TOKENS, PROMPT, fail, gatewayEnv, modelFor, printResult } from "./common.ts";

const provider = "codex";
const model = modelFor("gpt-6-astra");
const client = new OpenAI(gatewayEnv());

// A ChatGPT login reaches the Codex backend, which wants what the Codex CLI sends:
// instructions, a list-shaped input, store: false and stream: true. It answers 400
// "Stream must be set to true" to a plain request, so there is no non-streamed proof
// for codex: both requests are streamed. The SDK's stream() helper throws on the
// backend's `response.metadata` event, so events are read from create({ stream: true }).
const base = { model, instructions: "You are a terse assistant.", input: [{ role: "user" as const, content: PROMPT }], store: false, max_output_tokens: MAX_TOKENS };

async function streamedUsage(): Promise<unknown> {
  const events = await client.responses.create({ ...base, stream: true });
  let usage: unknown = null;
  for await (const event of events) if (event.type === "response.completed") usage = event.response.usage;
  return usage;
}

try {
  printResult(provider, model, await streamedUsage(), await streamedUsage(), ["streamed1", "streamed2"]);
} catch (e) {
  fail(provider, e);
}
