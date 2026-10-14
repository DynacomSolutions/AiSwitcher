// Test-only claude entrypoint: a pool adapter whose usage fetch is slower than
// the 4 s launch-check budget and whose credential swap is a two-step write,
// so a process replacement that cuts in-flight swap work is detectable.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { registerAdapter } from "../../src/identities/pool/registry.ts";
import type { PoolAdapter } from "../../src/identities/pool/adapter.ts";
import { CLAUDE_CONFIG } from "../../src/identities/tool-configs.ts";
import { runWrapper } from "../../src/shared/run-wrapper.ts";

const marks = process.env.FAKE_MARK_DIR!;
const adapter: PoolAdapter = {
  tool: "claude",
  config: CLAUDE_CONFIG,
  liveSwap: false,
  hasCredentials: () => true,
  swapCredentials: async ({ pool, target }) => {
    writeFileSync(join(marks, "swap-1"), "1");
    await Bun.sleep(400);
    writeFileSync(join(marks, "swap-2"), "2");
    return { pool: pool.name, from: pool.swapPool.active ?? null, to: target.name, noop: false, writeBack: "none-identical", notes: [] };
  },
  fetchUsage: async (member) => {
    await Bun.sleep(4_500);
    return { status: "live", maxUtilization: member.name === "a" ? 99 : 5, capturedAt: "x" };
  },
};
registerAdapter(adapter);
await runWrapper(CLAUDE_CONFIG, "Claude");
