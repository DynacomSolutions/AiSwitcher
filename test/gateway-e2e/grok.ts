import OpenAI from "openai";
import { MAX_TOKENS, PROMPT, fail, gatewayEnv, modelFor, printResult } from "./common.ts";

const provider = "grok";
const model = modelFor("grok-code-fast-1");
// The Grok subscription endpoint refuses callers that do not announce a Grok CLI version
// (426 "update to 1.0.13 or later"); the app supplies the header (docs/agents/gateway.md).
const client = new OpenAI({ ...gatewayEnv(), defaultHeaders: { "x-grok-client-version": "1.0.70" } });

try {
  const messages = [{ role: "user" as const, content: PROMPT }];
  const plain = await client.chat.completions.create({ model, max_tokens: MAX_TOKENS, messages });
  // Chat Completions streams carry usage only when the app asks for it.
  const stream = await client.chat.completions.create({ model, max_tokens: MAX_TOKENS, messages, stream: true, stream_options: { include_usage: true } });
  let usage: unknown = null;
  for await (const chunk of stream) if (chunk.usage) usage = chunk.usage;
  printResult(provider, model, plain.usage, usage);
} catch (e) {
  fail(provider, e);
}
