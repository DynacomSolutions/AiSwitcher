import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolMemberModelUsage } from "../../../src/cli/claude-swap/attribution.ts";
import { pickProviderAccount, withoutEmptyProviders, type CredentialIndexEntry } from "../../../src/cli/usage/opencode-usage.ts";
import { eventsForPool } from "../../../src/identities/claude-swap.ts";
import type { PoolIdentity } from "../../../src/identities/swap-pool.ts";
import type { Identity } from "../../../src/identities/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const id = (name: string): Identity => ({ name, label: name, configDir: `/synthetic/${name}` });

describe("swap pool usage folds into members", () => {
  test("renamed pool ledger history attributes to members; no pool row", async () => {
    const root = await mkdtemp(join(tmpdir(), "ais-pool-usage-"));
    dirs.push(root);
    const configDir = join(root, "swap");
    await mkdir(join(configDir, "projects", "p"), { recursive: true });
    const pool: PoolIdentity = { name: "pool-x", label: "Pool", configDir, swapPool: { accounts: ["alice", "bob"], active: "bob" } };
    const ledger = join(root, "ledger.jsonl");
    // Ledger events carry the pool's OLD name ("swap" == configDir basename).
    await writeFile(
      ledger,
      [
        { ts: "2026-10-02T00:00:00.000Z", pool: "swap", from: null, to: "alice", reason: "manual" },
        { ts: "2026-10-03T00:00:00.000Z", pool: "swap", from: "alice", to: "bob", reason: "auto" },
        { ts: "2026-10-03T00:00:00.000Z", pool: "other", from: null, to: "carol", reason: "manual" },
      ].map((e) => JSON.stringify(e)).join("\n"),
    );
    const msg = (ts: string, mid: string, out: number) =>
      JSON.stringify({ timestamp: ts, message: { id: mid, model: "claude-opus-4-8", usage: { input_tokens: 1000000, output_tokens: out } } });
    await writeFile(
      join(configDir, "projects", "p", "s.jsonl"),
      [
        msg("2026-10-01T00:00:00Z", "m0", 1), // before first event -> first event's `to`
        msg("2026-10-02T12:00:00Z", "m1", 2), // alice
        msg("2026-10-02T12:00:00Z", "m1", 2), // duplicate id, ignored
        msg("2026-10-04T00:00:00Z", "m2", 4), // bob
      ].join("\n"),
    );

    expect(eventsForPool(await Bun.file(ledger).text().then((t) => t.split("\n").map((l) => JSON.parse(l))), pool).map((e) => e.to)).toEqual(["alice", "bob"]);

    const usage = await poolMemberModelUsage(pool, [id("alice"), id("bob")], ledger);
    const byMember = Object.fromEntries(usage.map((u) => [u.member, u]));
    expect(Object.keys(byMember).sort()).toEqual(["alice", "bob"]);
    expect(byMember.alice!.entries[0]).toMatchObject({ messageCount: 2, input: 2000000, output: 3, provider: "anthropic" });
    expect(byMember.alice!.entries[0]!.cost).toBeCloseTo(10, 3); // 2M input at $5/M
    expect(byMember.bob!.entries[0]).toMatchObject({ messageCount: 1, output: 4 });
  });

  test("a message from a member no longer in the pool is unattributed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ais-pool-usage-"));
    dirs.push(root);
    const configDir = join(root, "swap");
    await mkdir(join(configDir, "projects"), { recursive: true });
    const pool: PoolIdentity = { name: "pool-x", label: "Pool", configDir, swapPool: { accounts: ["alice"] } };
    const ledger = join(root, "ledger.jsonl");
    await writeFile(ledger, JSON.stringify({ ts: "2026-10-02T00:00:00.000Z", pool: "pool-x", from: null, to: "gone", reason: "manual" }));
    await writeFile(
      join(configDir, "projects", "s.jsonl"),
      JSON.stringify({ timestamp: "2026-10-03T00:00:00Z", message: { id: "x", model: "m", usage: { output_tokens: 1 } } }),
    );
    const usage = await poolMemberModelUsage(pool, [id("alice")], ledger);
    expect(usage.map((u) => u.member)).toEqual([undefined]);
  });
});

describe("pi/opencode provider rows map to the real account", () => {
  const index: CredentialIndexEntry[] = [
    { tool: "zai", identity: id("zai-main"), credentials: new Map([["zai", "KEY_A"]]) },
    { tool: "ali", identity: id("ali-main"), credentials: new Map([["alibaba", "KEY_B"]]) },
    { tool: "opencode", identity: id("wrapper-oc"), credentials: new Map() },
    { tool: "pi", identity: id("holder"), credentials: new Map([["zai", "KEY_A"]]) },
    { tool: "pi", identity: id("stranger"), credentials: new Map([["zai", "KEY_X"]]) },
  ];

  test("keyless source with a single native account is re-attributed", () => {
    expect(pickProviderAccount(index, "opencode", id("wrapper-oc"), "zai").name).toBe("zai-main");
    expect(pickProviderAccount(index, "pi", id("wrapper"), "alibaba").name).toBe("ali-main");
  });
  test("a matching key wins; a different key keeps the source; other providers untouched", () => {
    expect(pickProviderAccount(index, "pi", id("holder"), "zai").name).toBe("zai-main");
    expect(pickProviderAccount(index, "pi", id("stranger"), "zai").name).toBe("stranger");
    expect(pickProviderAccount(index, "pi", id("holder"), "anthropic").name).toBe("holder");
  });
  test("ambiguous native accounts keep the source", () => {
    const two = [...index, { tool: "zai" as const, identity: id("zai-2"), credentials: new Map() }];
    expect(pickProviderAccount(two, "opencode", id("wrapper-oc"), "zai").name).toBe("wrapper-oc");
  });
  test("zero-usage rows are dropped unless the tool was asked for", () => {
    const row = (cost: number, tokens: number) => ({
      report: { entries: [], totalInput: tokens, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 1, totalCost: cost },
    });
    expect(withoutEmptyProviders([row(0, 0), row(1, 0), row(0, 5)], false)).toHaveLength(2);
    expect(withoutEmptyProviders([row(0, 0)], true)).toHaveLength(1);
  });
});
