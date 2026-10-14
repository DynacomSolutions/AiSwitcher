import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwapCommand } from "../../src/cli/swap/dispatch.ts";
import { poolMemberUsageSplit } from "../../src/cli/claude-swap/attribution.ts";
import { codexAdapter } from "../../src/identities/pool/codex-adapter.ts";
import { appendSwapEvent } from "../../src/identities/pool/ledger.ts";
import { registerAdapter } from "../../src/identities/pool/registry.ts";
import { requirePool } from "../../src/identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../../src/identities/store.ts";

let root = "";
let registry = "";
let out: string[] = [];
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (account: string, iat: number) => `${b64({ alg: "none" })}.${b64({ iat, exp: iat + 3600, "https://api.openai.com/auth": { chatgpt_account_id: account } })}.SYNTHETIC_FIXTURE`;
const auth = (account: string, iat: number) =>
  JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: jwt(account, iat), access_token: jwt(account, iat), refresh_token: `SYNTHETIC_FIXTURE-rt-${account}`, account_id: account }, last_refresh: new Date(iat * 1000).toISOString() });
const T0 = 1_789_200_000;
const usage = (label: string, utilization: number) => ({ status: "live" as const, maxUtilization: utilization, windows: [{ label, utilization }], capturedAt: "x" });
const deps = () => ({ registryPath: registry, ledgerPath: join(root, "ledger.jsonl"), log: (l: string) => out.push(l), fetchUsage: async () => usage("5h", 12) });
const swap = (positionals: string[], flags: Record<string, string | true> = {}) => runSwapCommand("codex", positionals, flags, deps());

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-swap-codex-"));
  registry = join(root, "codex-identities.json");
  out = [];
  for (const n of ["a", "b"]) {
    await mkdir(join(root, n), { recursive: true });
    await writeFile(join(root, n, "auth.json"), auth(`acct-${n}`, T0));
  }
  await mkdir(join(root, "apikey"), { recursive: true });
  await writeFile(join(root, "apikey", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "SYNTHETIC_FIXTURE-key" }));
  const id = (name: string) => ({ name, label: name, configDir: join(root, name) });
  await writeFile(registry, JSON.stringify({ version: 1, identities: [id("a"), id("b"), id("apikey")] }));
});
afterEach(async () => {
  registerAdapter(codexAdapter);
  await rm(root, { recursive: true, force: true });
});

describe("ais swap codex", () => {
  test("pool create validates members, activates the first, and runs status/to/allow/auto", async () => {
    await expect(swap(["pool", "create", "shared"], { accounts: "a,apikey", "config-dir": join(root, "shared") })).rejects.toThrow(/no ChatGPT login/);
    await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
    expect(JSON.parse(await readFile(join(root, "shared", "auth.json"), "utf8")).tokens.account_id).toBe("acct-a");
    expect(requirePool(await loadIdentitiesFile(registry), undefined, "codex").swapPool).toEqual({ accounts: ["a", "b"], active: "a" });

    out = [];
    await swap(["status"]);
    expect(out.join("\n")).toContain("5h 12%");
    out = [];
    await swap(["status"], { json: true });
    expect(JSON.parse(out.join("\n")).accounts.map((r: { name: string }) => r.name)).toEqual(["a", "b"]);

    await swap(["disallow", "b"]);
    await expect(swap(["to", "b"])).rejects.toThrow(/ais swap codex allow b/);
    await swap(["allow", "b"]);
    out = [];
    await swap(["to", "b"]);
    expect(out[0]).toContain("shared: a -> b");
    expect(JSON.parse(await readFile(join(root, "shared", "auth.json"), "utf8")).tokens.account_id).toBe("acct-b");
    await swap(["auto", "on"], { threshold: "90" });
    expect(requirePool(await loadIdentitiesFile(registry), undefined, "codex").swapPool).toMatchObject({ active: "b", auto: true, thresholdPercent: 90 });
  });

  test("to and next print the running-sessions warning; hook is Claude-only", async () => {
    await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
    registerAdapter({ ...codexAdapter, notifySwapped: async () => ({ sessions: 2 }) });
    out = [];
    await swap(["to", "b"]);
    expect(out.join("\n")).toContain("2 running sessions keep the old account");
    out = [];
    await swap(["next"]);
    expect(out.join("\n")).toContain("2 running sessions");
    await expect(swap(["hook", "on"])).rejects.toThrow(/Claude-only/);
    await expect(runSwapCommand("nope", [], {}, deps())).rejects.toThrow(/No swap pool support/);
  });

  test("usage attributes rollout token_count events to the member active at their timestamp", async () => {
    await swap(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") });
    const ledger = join(root, "ledger2.jsonl");
    const now = Date.parse("2026-10-14T12:00:00Z");
    await appendSwapEvent({ ts: "2026-10-14T08:00:00Z", pool: "shared", from: null, to: "a", reason: "manual" }, ledger);
    await appendSwapEvent({ ts: "2026-10-14T10:00:00Z", pool: "shared", from: "a", to: "b", reason: "auto" }, ledger);
    const tc = (ts: string, input: number, cached: number, output: number) =>
      JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    const dir = join(root, "shared", "sessions", "2026", "10", "14");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-1.jsonl"),
      [
        tc("2026-10-14T07:00:00Z", 10, 0, 1),
        JSON.stringify({ timestamp: "2026-10-14T08:30:00Z", type: "turn_context", payload: { model: "gpt-x" } }),
        tc("2026-10-14T09:00:00Z", 100, 40, 7),
        tc("2026-10-14T11:00:00Z", 50, 0, 3),
        "{torn",
      ].join("\n"),
    );
    const pool = requirePool(await loadIdentitiesFile(registry), "shared", "codex");
    const split = await poolMemberUsageSplit(pool, { days: 30, ledgerPath: ledger, now, tool: "codex" });
    const by = Object.fromEntries(split.members.map((m) => [m.member, m]));
    expect(by["(before first swap)"]).toMatchObject({ messages: 1, input: 10, output: 1 });
    expect(by.a).toMatchObject({ messages: 1, input: 60, cacheRead: 40, output: 7 });
    expect(by.b).toMatchObject({ messages: 1, input: 50, output: 3 });
    out = [];
    await runSwapCommand("codex", ["usage"], { json: true, days: "36500" }, { ...deps(), ledgerPath: ledger });
    expect(JSON.parse(out.join("\n")).members.map((m: { member: string }) => m.member).sort()).toEqual(["(before first swap)", "a", "b"]);
  });
});
