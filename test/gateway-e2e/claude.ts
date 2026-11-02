import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, PROMPT, fail, gatewayEnv, modelFor, printResult } from "./common.ts";

const provider = "claude";
const model = modelFor("claude-haiku-4-5");
const client = new Anthropic(gatewayEnv());
// A Claude OAuth login only serves requests whose first system block is Claude Code's identity line; the app supplies it (docs/agents/gateway.md).
const system = [{ type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }];
try {
  const request = { model, max_tokens: MAX_TOKENS, system, messages: [{ role: "user" as const, content: PROMPT }] };
  const plain = await client.messages.create(request);
  const stream = client.messages.stream(request);
  const final = await stream.finalMessage();
  printResult(provider, model, plain.usage, final.usage);
} catch (e) {
  fail(provider, e);
}
