import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../../src/identities/types.ts";
import { AuthRefreshScheduler, type StoreOwnership } from "../../src/server/auth-refresh.ts";
import { gatewayOwnership, type GatewayRenewalView } from "../../src/server/gateway-renewal.ts";

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

const login = (provider: string, identity: string) => ({ provider, identity, lastRefreshAt: null, lastRefreshReplica: null, lastError: null, expiresAt: null, nextRefreshAt: null, revoked: false });

test("ownership is the gateway's own renewal list: a login that only has store rows is still renewed by the console", async () => {
  // claude/local has a (stale) row in the credential store, but the gateway does not list it.
  const view: GatewayRenewalView = { state: "ok", logins: [login("claude", "owned"), login("kimi", "owned")] };
  const { s, calls } = await scheduler(gatewayOwnership(async () => view));
  await s.tick();
  expect(calls.sort()).toEqual(["ali/local", "ali/owned", "claude/local", "kimi/local"]);
});

test("an unreadable renewal list stands down for every gateway-refreshed tool, and a later good read is used", async () => {
  let view: GatewayRenewalView = { state: "unavailable", logins: [], error: "gateway admin unreachable" };
  let t = 0;
  const owned = gatewayOwnership(async () => view, 60_000, () => t);
  expect(await owned()).toBeUndefined();
  t += 1_000;
  view = { state: "ok", logins: [login("claude", "owned")] };
  expect(await owned()).toBeUndefined(); // a failed read is not retried for 15 s
  t += 20_000;
  expect([...(await owned())!]).toEqual(["claude/owned"]);
  view = { state: "ok", logins: [] };
  t += 30_000;
  expect([...(await owned())!]).toEqual(["claude/owned"]); // cached for 60 s
  t += 60_000;
  expect((await owned())!.size).toBe(0);
  const unconfigured = gatewayOwnership(async () => ({ state: "unconfigured", logins: [] }));
  expect(await unconfigured()).toBeUndefined();
  const throwing = gatewayOwnership(async () => Promise.reject(new Error("boom")));
  expect(await throwing()).toBeUndefined();
});
