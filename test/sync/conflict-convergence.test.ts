import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aisRemoteCacheDir } from "../../src/shared/ais-home.ts";
import { setDirectOwnerProbe, mergeIncomingProfileTree } from "../../src/sync/tree-merge.ts";

const dirs: string[] = [];
afterEach(async () => {
  setDirectOwnerProbe();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const all = { kind: "all" } as const;
const noPurge = async () => ({ removed: [], warnings: [] });
const T = 1_700_000_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ais-converge-"));
  dirs.push(root);
  const [home, incoming] = [join(root, "home"), join(root, "incoming")];
  await mkdir(home, { recursive: true });
  setDirectOwnerProbe(async () => false);
  const put = async (base: string, rel: string, content: string, mtime: number) => {
    await mkdir(dirname(join(base, rel)), { recursive: true });
    await writeFile(join(base, rel), content);
    await utimes(join(base, rel), mtime, mtime);
  };
  const merge = () => mergeIncomingProfileTree(incoming, all, { home, purgeRetired: noPurge });
  const archived = async (name: string) => Array.fromAsync(new Bun.Glob(`merge-conflicts/**/${name}*`).scan({ cwd: aisRemoteCacheDir(home), absolute: true, dot: true }));
  return { home, incoming, put, merge, archived };
}

test.each([
  ".pi/identities/a1/auth.json",
  ".kimi-code/identities/a2/credentials/kimi-code.json",
  ".claude/identities/a3/.credentials.json",
])("%s: the newest copy wins, with no conflict and no archived stale credential", async (rel) => {
  for (const incomingNewer of [true, false]) {
    const f = await fixture();
    await f.put(f.home, rel, "live-token", incomingNewer ? T : T + 50);
    await f.put(f.incoming, rel, "other-token", incomingNewer ? T + 50 : T);
    const result = await f.merge();
    expect(result.preservedConflicts).toBe(0);
    expect(await readFile(join(f.home, rel), "utf8")).toBe(incomingNewer ? "other-token" : "live-token");
    expect(await f.archived(rel.split("/").at(-1)!)).toEqual([]);
  }
});

test("settings_cache.json is regenerated state: newest wins, nothing counted or kept", async () => {
  const f = await fixture();
  const rel = ".grok/identities/a4/settings_cache.json";
  await f.put(f.home, rel, '{"a":1}', T);
  await f.put(f.incoming, rel, '{"a":2}', T + 9);
  expect((await f.merge()).preservedConflicts).toBe(0);
  expect(await readFile(join(f.home, rel), "utf8")).toBe('{"a":2}');
  expect(await f.archived("settings_cache.json")).toEqual([]);
});

test("a MEMORY.md both hosts changed is a conflict once, not on every run", async () => {
  const f = await fixture();
  const rel = ".grok/identities/a4/memory-v2/global/MEMORY.md";
  await f.put(f.home, rel, "local notes", T + 20);
  await f.put(f.incoming, rel, "remote notes", T);
  const first = await f.merge();
  expect(first.preservedConflictPaths).toEqual([rel]);
  expect(await readFile(join(f.home, rel), "utf8")).toBe("local notes");
  for (let i = 0; i < 2; i++) expect((await f.merge()).preservedConflicts).toBe(0);
  // A new, different remote version is news again.
  await f.put(f.incoming, rel, "remote notes 2", T + 1);
  expect((await f.merge()).preservedConflictPaths).toEqual([rel]);
});

test("a history whose live copy has an unfinished last line is reported once, not on every run", async () => {
  const f = await fixture();
  const rel = ".grok/identities/a4/memtrace/1.jsonl";
  await f.put(f.home, rel, '{"a":1}\n{"b":', T);
  await f.put(f.incoming, rel, '{"a":1}\n{"b":2}\n{"c":3}\n', T + 5);
  expect((await f.merge()).preservedConflictPaths).toEqual([rel]);
  for (let i = 0; i < 2; i++) expect((await f.merge()).preservedConflicts).toBe(0);
  expect(await readFile(join(f.home, rel), "utf8")).toBe('{"a":1}\n{"b":');
});

test(".claude.json differing only in per-session stats converges; a real key conflict counts once", async () => {
  const f = await fixture();
  const rel = ".claude/identities/a3/.claude.json";
  const doc = (stats: number, theme: string) => JSON.stringify({ theme, projects: { "/p": { lastCost: stats, lastSessionId: `s${stats}`, allowedTools: [] } } });
  await f.put(f.home, rel, doc(1, "dark"), T + 10);
  await f.put(f.incoming, rel, doc(2, "dark"), T);
  expect((await f.merge()).preservedConflicts).toBe(0);
  await f.put(f.incoming, rel, doc(3, "light"), T);
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (m: string) => { logged.push(m); };
  try {
    expect((await f.merge()).preservedConflictPaths).toEqual([rel]);
    expect((await f.merge()).preservedConflicts).toBe(0);
  } finally { console.warn = warn; }
  expect(logged.some((m) => m.includes("differs in: theme"))).toBe(true);
});

test(".claude.json differing only in pluginUsage counters is not a conflict", async () => {
  const f = await fixture();
  const rel = ".claude/identities/a3/.claude.json";
  const doc = (uses: number) => JSON.stringify({ theme: "dark", pluginUsage: { "p@m": { usageCount: uses } } });
  await f.put(f.home, rel, doc(5), T + 10);
  await f.put(f.incoming, rel, doc(9), T);
  expect((await f.merge()).preservedConflicts).toBe(0);
  await f.put(f.incoming, rel, doc(12), T);
  expect((await f.merge()).preservedConflicts).toBe(0);
});

test("a staged history that extends a large live one is merged as a tail without reading the live file", async () => {
  const f = await fixture();
  const rel = ".claude/identities/a3/projects/p/s.jsonl";
  const line = (n: number) => `{"n":${n},"pad":"${"p".repeat(1000)}"}\n`;
  const base = Array.from({ length: 6000 }, (_, i) => line(i)).join("");
  await f.put(f.home, rel, base, T);
  await f.put(f.incoming, rel, base, T);
  await f.merge(); // equal: fills nothing, but the cache is created by the first tail merge below
  await f.put(f.incoming, rel, base + line(6000), T + 5);
  const size = base.length;
  const rchar = async () => Number(/^rchar: (\d+)/m.exec(await Bun.file("/proc/self/io").text())![1]);
  // Cold: the live prefix is hashed once and cached.
  expect((await f.merge()).mergedJsonlFiles).toBe(1);
  await appendFile(join(f.incoming, rel), line(6001));
  await utimes(join(f.incoming, rel), T + 9, T + 9);
  const before = await rchar();
  const result = await f.merge();
  const read = (await rchar()) - before;
  expect(result.mergedJsonlFiles).toBe(1);
  expect(await readFile(join(f.home, rel), "utf8")).toBe(await readFile(join(f.incoming, rel), "utf8"));
  // The staged file (6 MB) is read once to prove the prefix; the live one is not read again.
  expect(read).toBeLessThan(size * 1.6);
});
