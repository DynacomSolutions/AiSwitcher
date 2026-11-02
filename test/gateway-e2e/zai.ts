import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, PROMPT, fail, gatewayEnv, modelFor, printResult } from "./common.ts";

const provider = "zai";
const model = modelFor("glm-4.5-air");
const client = new Anthropic(gatewayEnv());

try {
  const request = { model, max_tokens: MAX_TOKENS, messages: [{ role: "user" as const, content: PROMPT }] };
  const plain = await client.messages.create(request);
  const stream = client.messages.stream(request);
  const final = await stream.finalMessage();
  printResult(provider, model, plain.usage, final.usage);
} catch (e) {
  fail(provider, e);
}
