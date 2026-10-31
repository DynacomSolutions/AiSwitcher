import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolMemberModelUsage, poolMemberUsageSplit } from "../../../src/cli/claude-swap/attribution.ts";
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

    const usage = await poolMemberModelUsage(pool, [id("alice"), id("bob")], ledger, { cachePath: join(root, "pool-cache.json") });
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
    const usage = await poolMemberModelUsage(pool, [id("alice")], ledger, { cachePath: join(root, "pool-cache.json") });
    expect(usage.map((u) => u.member)).toEqual([undefined]);
  });
});

describe("swap pool usage attribution cache", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "ais-pool-cache-"));
    dirs.push(root);
    const configDir = join(root, "swap");
    const projects = join(configDir, "projects", "p");
    await mkdir(projects, { recursive: true });
    const ledger = join(root, "ledger.jsonl");
    await writeFile(ledger, "");
    const pool: PoolIdentity = { name: "pool-x", label: "Pool", configDir, swapPool: { accounts: ["alice", "bob"], active: "alice" } };
    const transcript = join(projects, "s.jsonl");
    const cachePath = join(root, "cache", "pool.json");
    const msg = (id: string, output: number, model = "claude-opus-4-8") => JSON.stringify({ timestamp: "2026-10-03T00:00:00Z", message: { id, model, usage: { input_tokens: 10, output_tokens: output } } });
    return { root, pool, ledger, transcript, cachePath, msg };
  }

  test("recent split matches the live scan: window, dedup, pre-ledger label, departed members", async () => {
    const f = await fixture();
    await writeFile(f.ledger, JSON.stringify({ ts: "2026-10-20T00:00:00.000Z", pool: "pool-x", from: null, to: "gone", reason: "manual" }));
    const at = (ts: string, id: string, output: number) => JSON.stringify({ timestamp: ts, message: { id, model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: output } } });
    await writeFile(f.transcript, [
      at("2026-09-20T00:00:00Z", "outside", 5),
      at("2026-10-15T00:00:00Z", "early", 3), // inside the window, before the first ledger event
      at("2026-10-25T00:00:00Z", "dup", 7),
      at("2026-10-25T00:00:00Z", "dup", 7), // streaming copy
    ].join("\n"));
    const now = Date.parse("2026-11-01T00:00:00Z");
    let recent: unknown;
    await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, { cachePath: f.cachePath, now, onRecentSplit: (split) => { recent = split; } });
    const scan = await poolMemberUsageSplit(f.pool, { days: 30, ledgerPath: f.ledger, now });
    const project = (rows: Array<{ member: string; messages: number; input: number; output: number }>) => rows.map(({ member, messages, input, output }) => ({ member, messages, input, output })).sort((a, b) => a.member.localeCompare(b.member));
    expect(project(recent as never)).toEqual([
      { member: "(before first swap)", messages: 1, input: 10, output: 3 },
      { member: "gone", messages: 1, input: 10, output: 7 },
    ]);
    expect(project(scan.members)).toEqual(project(recent as never));
  });

  test("reuses unchanged files after restart without reopening transcripts", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("one", 2)}\n`);
    const reads: string[] = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (path: string) => reads.push(path) };
    const first = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    const second = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    expect(reads).toEqual([f.transcript]);
    expect(second).toEqual(first);
  });

  test("append reparses changed file, including a previously incomplete trailing line", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("one", 2)}\n{"timestamp":`);
    const reads: string[] = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (path: string) => reads.push(path) };
    const first = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    expect(first[0]?.entries[0]?.messageCount).toBe(1);
    await writeFile(f.transcript, `${f.msg("one", 2)}\n${f.msg("two", 7)}\n`);
    const second = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    expect(reads).toEqual([f.transcript, f.transcript]);
    expect(second[0]?.entries[0]?.messageCount).toBe(2);
    expect(second[0]?.entries[0]?.output).toBe(9);
  });

  test("same-size rewrite is detected and reparsed", async () => {
    const f = await fixture();
    const original = f.msg("same-id", 2);
    const replacement = f.msg("same-id", 9);
    expect(replacement.length).toBe(original.length);
    await writeFile(f.transcript, original);
    const reads: string[] = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (path: string) => reads.push(path) };
    await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    const fixedMtime = new Date("2026-10-03T00:00:00.000Z");
    await utimes(f.transcript, fixedMtime, fixedMtime);
    await writeFile(f.transcript, replacement);
    await utimes(f.transcript, fixedMtime, fixedMtime);
    const usage = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    expect(reads).toEqual([f.transcript, f.transcript]);
    expect(usage[0]?.entries[0]?.output).toBe(9);
  });

  test("ledger changes reattribute cached hits without reopening source files", async () => {
    const f = await fixture();
    await writeFile(f.ledger, `${JSON.stringify({ ts: "2026-10-02T00:00:00Z", pool: "pool-x", from: null, to: "alice", reason: "manual" })}\n`);
    await writeFile(f.transcript, `${f.msg("one", 2)}\n`);
    const reads: string[] = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (path: string) => reads.push(path) };
    const first = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    await writeFile(f.ledger, `${JSON.stringify({ ts: "2026-10-02T00:00:00Z", pool: "pool-x", from: null, to: "bob", reason: "manual" })}\n`);
    const second = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    expect(first[0]?.member).toBe("alice");
    expect(second[0]?.member).toBe("bob");
    expect(reads).toEqual([f.transcript]);
  });

  test("duplicate ids stay deduplicated and source read failures preserve cache", async () => {
    const f = await fixture();
    const duplicate = f.msg("repeat", 2);
    await writeFile(f.transcript, `${duplicate}\n${duplicate}\n`);
    const options = { cachePath: f.cachePath };
    const usage = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    expect(usage[0]?.entries[0]?.messageCount).toBe(1);
    const prior = await readFile(f.cachePath, "utf8");
    await writeFile(f.transcript, `${f.msg("changed", 8)}\n`);
    await expect(poolMemberModelUsage(f.pool, [id("alice")], f.ledger, { ...options, onSourceFileRead: () => { throw Object.assign(new Error("source unavailable"), { code: "EACCES" }); } })).rejects.toThrow("source unavailable");
    expect(await readFile(f.cachePath, "utf8")).toBe(prior);
  });

  test("cache write failures do not fail computed attribution or replace the prior cache", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("before", 2)}\n`);
    const options = { cachePath: f.cachePath };
    await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    const prior = await readFile(f.cachePath, "utf8");

    await writeFile(f.transcript, `${f.msg("after", 7)}\n`);
    const usage = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, {
      ...options,
      writeCache: async () => { throw Object.assign(new Error("cache is read-only"), { code: "EACCES" }); },
    });

    expect(usage[0]?.entries[0]?.messageCount).toBe(1);
    expect(usage[0]?.entries[0]?.output).toBe(7);
    expect(await readFile(f.cachePath, "utf8")).toBe(prior);
  });

  test("unreadable acceleration cache falls back to transcript parsing", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("source", 5)}\n`);
    await mkdir(f.cachePath, { recursive: true });
    const reads: string[] = [];

    const usage = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, {
      cachePath: f.cachePath,
      onSourceFileRead: (path) => reads.push(path),
    });

    expect(usage[0]?.entries[0]?.output).toBe(5);
    expect(reads).toEqual([f.transcript]);
  });

  test("duplicate IDs are deduplicated across transcript files", async () => {
    const f = await fixture();
    await writeFile(join(f.pool.configDir, "projects", "p", "a.jsonl"), `${f.msg("same", 2)}\n`);
    await writeFile(join(f.pool.configDir, "projects", "p", "b.jsonl"), `${f.msg("same", 9)}\n`);
    const usage = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, { cachePath: f.cachePath });
    expect(usage[0]?.entries[0]?.messageCount).toBe(1);
    expect([2, 9]).toContain(usage[0]?.entries[0]?.output);
  });

  test("discovery ENOENT races preserve the prior cache generation", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("one", 2)}\n`);
    await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, { cachePath: f.cachePath });
    const previous = await readFile(f.cachePath, "utf8");
    const root = join(f.pool.configDir, "projects");
    const options = {
      cachePath: f.cachePath,
      readdir: async (path: string) => {
        if (path === root) return [{ name: "p", isDirectory: () => true }];
        throw Object.assign(new Error("directory vanished after discovery"), { code: "ENOENT" });
      },
    };
    await expect(poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.cachePath, "utf8")).toBe(previous);

    const listedFile = f.transcript;
    await expect(poolMemberModelUsage(f.pool, [id("alice")], f.ledger, {
      cachePath: f.cachePath,
      fingerprint: async (path: string) => path === listedFile ? undefined : undefined,
    })).rejects.toThrow("disappeared during discovery");
    expect(await readFile(f.cachePath, "utf8")).toBe(previous);
  });

  test("corrupt cache is rebuilt, and disappeared files do not reappear from stale cache", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("one", 2)}\n`);
    await mkdir(join(f.root, "cache"), { recursive: true });
    await writeFile(f.cachePath, "not-json");
    const reads: string[] = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (path: string) => reads.push(path) };
    const first = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    expect(first[0]?.entries[0]?.messageCount).toBe(1);
    const repaired = await readFile(f.cachePath, "utf8");
    expect(JSON.parse(repaired).schemaVersion).toBe(1);
    await unlink(f.transcript);
    const afterRemoval = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    expect(afterRemoval).toEqual([]);
    expect(reads).toEqual([f.transcript]);
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
