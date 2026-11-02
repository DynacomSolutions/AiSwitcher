import Anthropic from "@anthropic-ai/sdk";
import { fail, gatewayEnv, modelFor } from "./common.ts";

// Long streamed request for the rollout-during-stream proof: ~400 tokens out so the
// stream stays open for several seconds. Prints one JSON line when the stream ends.
const model = modelFor("claude-haiku-4-5");
const client = new Anthropic(gatewayEnv());
const system = [{ type: "text" as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }];

try {
  const started = Date.now();
  const stream = client.messages.stream({
    model,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: "Count from 1 to 150, one number per line, with no other text." }],
  });
  let deltas = 0;
  stream.on("text", () => {
    deltas += 1;
  });
  const final = await stream.finalMessage();
  console.log(JSON.stringify({ provider: "claude", model, longStream: { deltas, ms: Date.now() - started, stopReason: final.stop_reason, usage: final.usage } }));
} catch (e) {
  fail("claude", e);
}
