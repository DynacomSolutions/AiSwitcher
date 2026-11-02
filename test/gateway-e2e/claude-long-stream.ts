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
  // Read slowly (AIS_E2E_READ_DELAY_MS per event, default 60) so the stream stays open for
  // ~20 s whatever the model speed; the first delta is announced on stderr so a caller can
  // trigger a rollout while bytes are in flight.
  const delay = Number(process.env.AIS_E2E_READ_DELAY_MS ?? 60);
  let deltas = 0;
  for await (const event of stream) {
    if (event.type !== "content_block_delta") continue;
    if (deltas === 0) console.error("stream-open");
    deltas += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const final = await stream.finalMessage();
  console.log(JSON.stringify({ provider: "claude", model, longStream: { deltas, ms: Date.now() - started, stopReason: final.stop_reason, usage: final.usage } }));
} catch (e) {
  fail("claude", e);
}
