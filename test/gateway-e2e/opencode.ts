import OpenAI from "openai";
import { MAX_TOKENS, PROMPT, fail, gatewayEnv, modelFor, printResult } from "./common.ts";

const provider = "opencode";
const model = modelFor("glm-5.3-flash");
// OpenCode Go refuses requests without a session id header (400 MissingSessionID); the app
// supplies one (docs/agents/gateway.md).
const client = new OpenAI({ ...gatewayEnv(), defaultHeaders: { "x-opencode-session": crypto.randomUUID() } });

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
