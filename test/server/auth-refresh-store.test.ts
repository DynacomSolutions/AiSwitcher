import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../../src/identities/types.ts";
import { AuthRefreshScheduler, type StoreOwnership } from "../../src/server/auth-refresh.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scheduler(owned: StoreOwnership): Promise<{ s: AuthRefreshScheduler; calls: string[] }> {
  const stateHome = await mkdtemp(join(tmpdir(), "ais-refresh-store-"));
  dirs.push(stateHome);
  const calls: string[] = [];
  const refresher = (tool: string) => async (identity: Identity) => {
    calls.push(`${tool}/${identity.name}`);
    return "refreshed";
  };
  const ids: Identity[] = [
    { name: "owned", label: "owned", configDir: "/tmp/ais-owned" },
    { name: "local", label: "local", configDir: "/tmp/ais-local" },
  ];
  const s = new AuthRefreshScheduler(0, { claude: refresher("claude"), kimi: refresher("kimi"), ali: refresher("ali") }, async () => ids, stateHome, 24, async () => undefined, owned);
  return { s, calls };
}

test("the console never refreshes a login the gateway's credential store owns, not even a manual run", async () => {
  const { s, calls } = await scheduler(async () => new Set(["claude/owned", "kimi/owned"]));
  await s.tick();
  expect(await s.refreshNow("claude", "owned")).toBe(true);
  expect(calls.sort()).toEqual(["ali/local", "ali/owned", "claude/local", "kimi/local"]);
  expect(s.status().find((e) => e.tool === "claude" && e.identity === "owned")?.lastDetail).toBe("renewed by the gateway (credential store)");
});

test("an unreachable store stands down for every gateway-refreshed tool (fail closed); ali is untouched", async () => {
  const { s, calls } = await scheduler(async () => undefined);
  await s.tick();
  expect(calls.sort()).toEqual(["ali/local", "ali/owned"]);
});
