import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
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

  test("per-day per-model totals sum to the member entry", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("one", 2)}\n${f.msg("two", 7)}\n`);
    const usage = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, { cachePath: f.cachePath });
    const days = usage[0]!.dailyByModel["claude-opus-4-8"]!;
    expect(days["2026-10-03"] ?? days[Object.keys(days)[0]!]).toBeDefined();
    const all = [0, 0, 0, 0, 0, 0];
    for (const v of Object.values(days)) v.forEach((n, i) => { all[i]! += n; });
    expect(all.slice(0, 2)).toEqual([20, 9]);
    expect(all[4]).toBe(2);
    expect(all[5]).toBeCloseTo(usage[0]!.entries[0]!.cost, 9);
  });

  test("a transcript that keeps growing during the scan is kept as a prefix and re-read next cycle", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg("one", 2)}\n`);
    let appended = 0;
    const growing = {
      cachePath: f.cachePath,
      onSourceFileRead: () => {
        appended += 1;
        appendFileSync(f.transcript, `${f.msg(`grow-${appended}`, 1)}\n`);
      },
    };
    const first = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, growing);
    expect(first[0]?.entries[0]?.messageCount).toBeGreaterThanOrEqual(1);
    const reads: string[] = [];
    const settled = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, { cachePath: f.cachePath, onSourceFileRead: (path: string) => reads.push(path) });
    expect(reads).toEqual([f.transcript]);
    expect(settled[0]?.entries[0]?.messageCount).toBe(1 + appended);
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
    expect(JSON.parse(repaired).schemaVersion).toBe(2);
    await unlink(f.transcript);
    const afterRemoval = await poolMemberModelUsage(f.pool, [id("alice")], f.ledger, options);
    expect(afterRemoval).toEqual([]);
    expect(reads).toEqual([f.transcript]);
  });
});

describe("swap pool attribution cache: appended transcripts", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "ais-pool-append-"));
    dirs.push(root);
    const configDir = join(root, "swap");
    const projects = join(configDir, "projects", "p");
    await mkdir(projects, { recursive: true });
    const ledger = join(root, "ledger.jsonl");
    await writeFile(ledger, `${JSON.stringify({ ts: "2026-10-02T00:00:00Z", pool: "pool-x", from: null, to: "alice", reason: "manual" })}\n${JSON.stringify({ ts: "2026-10-03T12:00:00Z", pool: "pool-x", from: "alice", to: "bob", reason: "auto" })}\n`);
    const pool: PoolIdentity = { name: "pool-x", label: "Pool", configDir, swapPool: { accounts: ["alice", "bob"], active: "bob" } };
    const transcript = join(projects, "s.jsonl");
    const cachePath = join(root, "cache", "pool.v2.json");
    const msg = (n: number, output = n % 7 + 1) => JSON.stringify({ timestamp: new Date(Date.parse("2026-10-03T00:00:00Z") + n * 3_600_000).toISOString(), message: { id: `m${n % 50}`, model: n % 3 ? "claude-opus-4-8" : "claude-sonnet-4-6", usage: { input_tokens: 10 + n, output_tokens: output, cache_read_input_tokens: n, cache_creation_input_tokens: 1 } } });
    const cold = async () => poolMemberModelUsage(pool, [id("alice"), id("bob")], ledger, { cachePath: join(root, `cold-${Math.random().toString(36).slice(2)}`, "pool.json") });
    return { root, pool, ledger, transcript, cachePath, msg, cold };
  }

  test("a grown transcript is read only from where the last scan stopped and matches a cold scan", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg(1)}\n${f.msg(2)}\n`);
    const reads: Array<[string, number]> = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (path: string, offset: number) => reads.push([path, offset]) };
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    const firstSize = (await stat(f.transcript)).size;
    appendFileSync(f.transcript, `${f.msg(3)}\n${f.msg(40)}\n`);
    const warm = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    expect(reads).toEqual([[f.transcript, 0], [f.transcript, firstSize]]);
    expect(warm).toEqual(await f.cold());
  });

  test("an unchanged cycle opens no transcript and rewrites neither the index nor any hits log", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg(1)}\n${f.msg(2)}\n`);
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath });
    const stamp = async () => {
      const names = (await readdir(`${f.cachePath}.d`)).sort();
      return [String((await stat(f.cachePath, { bigint: true })).mtimeNs), ...await Promise.all(names.map(async (name) => `${name}:${(await stat(join(`${f.cachePath}.d`, name), { bigint: true })).mtimeNs}`))];
    };
    const before = await stamp();
    const reads: string[] = [];
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath, onSourceFileRead: (path) => reads.push(path) });
    expect(reads).toEqual([]);
    expect(await stamp()).toEqual(before);
  });

  test("random appends, partial lines and CRLF stay equal to a cold scan after every cycle", async () => {
    const f = await fixture();
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let text = "";
    await writeFile(f.transcript, "");
    for (let cycle = 0; cycle < 25; cycle++) {
      let chunk = "";
      const lines = Math.floor(random() * 4);
      for (let i = 0; i < lines; i++) chunk += `${f.msg(cycle * 5 + i)}${random() < 0.3 ? "\r\n" : "\n"}`;
      // Cut mid-line sometimes: the rest arrives with a later append.
      const cut = random() < 0.4 ? Math.floor(random() * chunk.length) : chunk.length;
      text += chunk.slice(0, cut);
      appendFileSync(f.transcript, chunk.slice(0, cut));
      if (cut < chunk.length) {
        const warmPartial = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath });
        expect(warmPartial).toEqual(await f.cold());
        text += chunk.slice(cut);
        appendFileSync(f.transcript, chunk.slice(cut));
      }
      const warm = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath });
      expect(warm).toEqual(await f.cold());
    }
    expect((await readFile(f.transcript, "utf8"))).toBe(text);
  });

  test("a changed byte inside the sampled prefix forces a full re-parse", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg(1, 2)}\n${f.msg(2, 3)}\n`);
    const reads: number[] = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (_path: string, offset: number) => reads.push(offset) };
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    // Same inode, grown, but an earlier message now says something else.
    const handle = await open(f.transcript, "r+");
    await handle.write(f.msg(1, 9), 0);
    await handle.close();
    appendFileSync(f.transcript, `${f.msg(3)}\n`);
    const warm = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    expect(reads).toEqual([0, 0]);
    expect(warm).toEqual(await f.cold());
  });

  test("a truncated and regrown transcript is re-parsed from byte 0", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg(1)}\n${f.msg(2)}\n`);
    const reads: number[] = [];
    const options = { cachePath: f.cachePath, onSourceFileRead: (_path: string, offset: number) => reads.push(offset) };
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    await writeFile(f.transcript, `${f.msg(5)}\n`);
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    appendFileSync(f.transcript, `${f.msg(6)}\n${f.msg(7)}\n${f.msg(8)}\n`);
    const warm = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, options);
    expect(reads[0]).toBe(0);
    expect(reads[1]).toBe(0);
    expect(warm).toEqual(await f.cold());
  });

  test("an append whose index commit failed is not counted twice", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg(1)}\n`);
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath });
    appendFileSync(f.transcript, `${f.msg(2)}\n`);
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath, writeCache: async () => { throw new Error("crash before commit"); } });
    appendFileSync(f.transcript, `${f.msg(3)}\n`);
    const warm = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath });
    expect(warm).toEqual(await f.cold());
    // Message ids dedupe the totals, so check the log itself holds each hit once.
    const [log] = await readdir(`${f.cachePath}.d`);
    expect((await readFile(join(`${f.cachePath}.d`, log!), "utf8")).trim().split("\n")).toHaveLength(3);
  });

  test("schema-1 hits of unchanged transcripts are adopted without reading them", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg(1)}\n${f.msg(2)}\n`);
    const changed = join(f.pool.configDir, "projects", "p", "changed.jsonl");
    await writeFile(changed, `${f.msg(3)}\n`);
    const legacyCachePath = join(f.root, "cache", "pool.json");
    const expected = await f.cold();
    const fingerprint = async (path: string) => {
      const info = await stat(path, { bigint: true });
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
    };
    const key = (name: string) => createHash("sha256").update(`p/${name}`).digest("hex");
    const opaque = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
    const hit = (n: number) => {
      const row = JSON.parse(f.msg(n));
      const usage = row.message.usage;
      return [Date.parse(row.timestamp), row.message.model, opaque(row.message.id), usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
    };
    await mkdir(join(f.root, "cache"), { recursive: true });
    await writeFile(legacyCachePath, JSON.stringify({ schemaVersion: 1, files: [
      { key: key("s.jsonl"), fingerprint: await fingerprint(f.transcript), hits: [hit(1), hit(2)] },
      { key: key("changed.jsonl"), fingerprint: ["0", "0", "0", "0", "0"].join(":"), hits: [hit(3)] },
    ] }));
    const reads: string[] = [];
    const usage = await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath, legacyCachePath, onSourceFileRead: (path) => reads.push(path) });
    expect(reads).toEqual([changed]);
    expect(usage).toEqual(expected);
    await expect(stat(legacyCachePath)).rejects.toMatchObject({ code: "ENOENT" });
    appendFileSync(f.transcript, `${f.msg(4)}\n`);
    expect(await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath })).toEqual(await f.cold());
  });

  test("a removed transcript drops its hits log", async () => {
    const f = await fixture();
    await writeFile(f.transcript, `${f.msg(1)}\n`);
    await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath });
    expect(await readdir(`${f.cachePath}.d`)).toHaveLength(1);
    await unlink(f.transcript);
    expect(await poolMemberModelUsage(f.pool, [id("alice"), id("bob")], f.ledger, { cachePath: f.cachePath })).toEqual([]);
    expect(await readdir(`${f.cachePath}.d`)).toEqual([]);
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
