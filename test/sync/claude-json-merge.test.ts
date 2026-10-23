import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import { sample } from "../../src/sync/io-trace.ts";
import { mergeIncomingProfileTree, setClaudeLockOptions } from "../../src/sync/tree-merge.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  setClaudeLockOptions();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const REL = join(".claude", "identities", "a");
const T = 1_700_000_000;

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ais-cj-home-"));
  const incoming = await mkdtemp(join(tmpdir(), "ais-cj-in-"));
  tempDirs.push(home, incoming);
  const cfg = {
    toolName: "claude", realBinaryName: "claude", envVarName: "CLAUDE_CONFIG_DIR", globalMemoryProjection: "claude-md",
    identitiesJsonPath: join(home, ".claude", "identities.json"), identitiesRootDir: join(home, ".claude", "identities"),
  } as unknown as ToolConfig;
  const scope = { kind: "identity" as const, cfg, identityName: "a" };
  const put = async (root: string, name: string, body: string, mtime: number) => {
    const path = join(root, REL, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await utimes(path, mtime, mtime);
  };
  const merge = () => mergeIncomingProfileTree(incoming, scope, { home, conflictRoot: join(home, "conflicts") });
  return { home, incoming, put, merge, live: (name = ".claude.json") => join(home, REL, name) };
}

describe("claude.json merge", () => {
  test("H1: mcpServers added on the older host are preserved and reported as a conflict", async () => {
    const { home, put, merge, live, incoming } = await setup();
    await put(home, ".claude.json", JSON.stringify({ numStartups: 1, mcpServers: { x: { command: "x" } } }), T);
    await put(incoming, ".claude.json", JSON.stringify({ numStartups: 9, mcpServers: {} }), T + 100);
    const result = await merge();
    expect(result.preservedConflicts).toBe(1);
    expect(result.preservedConflictPaths).toEqual([join(REL, ".claude.json")]);
    expect(JSON.parse(await readFile(live(), "utf8"))).toEqual({ numStartups: 9, mcpServers: {} });
    const kept = JSON.parse(await readFile(join(home, "conflicts", "local", REL, ".claude.json"), "utf8"));
    expect(kept.mcpServers).toEqual({ x: { command: "x" } });
  });

  test("self-changing keys merge key by key without a conflict", async () => {
    const { home, put, merge, live, incoming } = await setup();
    await put(home, ".claude.json", JSON.stringify({ numStartups: 1, cachedFlags: { a: 1 }, userID: "u" }), T);
    await put(incoming, ".claude.json", JSON.stringify({ numStartups: 9, userID: "u" }), T + 100);
    const result = await merge();
    expect(result.preservedConflicts).toBe(0);
    expect(JSON.parse(await readFile(live(), "utf8"))).toEqual({ numStartups: 9, cachedFlags: { a: 1 }, userID: "u" });
  });

  test("M1: oauthAccount deleted on the newer host is not resurrected", async () => {
    const { home, put, merge, live, incoming } = await setup();
    await put(home, ".claude.json", JSON.stringify({ numStartups: 2 }), T + 200);
    await put(incoming, ".claude.json", JSON.stringify({ numStartups: 0, oauthAccount: { id: 1 } }), T);
    const result = await merge();
    expect("oauthAccount" in JSON.parse(await readFile(live(), "utf8"))).toBe(false);
    expect(result.preservedConflicts).toBe(0); // account bookkeeping follows the newest file, like the credentials
  });

  test("a busy .claude.json lock warns, leaves both files untouched and does not abort the sync", async () => {
    const { home, put, merge, live, incoming } = await setup();
    await put(home, ".claude.json", JSON.stringify({ mcpServers: { x: 1 } }), T);
    await put(incoming, ".claude.json", JSON.stringify({ mcpServers: {} }), T + 100);
    const before = await stat(live());
    await mkdir(join(home, REL, ".claude.json.lock"));
    setClaudeLockOptions({ timeoutMs: 200, pollMs: 20, staleMs: 60_000 });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try { var result = await merge(); } finally { console.warn = original; }
    expect(warnings).toEqual([".claude.json for a busy; will merge next sync"]);
    expect(result.preservedConflicts).toBe(0);
    expect(JSON.parse(await readFile(live(), "utf8"))).toEqual({ mcpServers: { x: 1 } });
    expect(JSON.parse(await readFile(join(incoming, REL, ".claude.json"), "utf8"))).toEqual({ mcpServers: {} });
    expect((await stat(live())).mtimeMs).toBe(before.mtimeMs);
  });

  test("L5: a newer incoming file equal to the merge settles bytes and mtime", async () => {
    const { home, put, merge, live, incoming } = await setup();
    await put(home, ".claude.json", '{"userID":"u"}', T);
    await put(incoming, ".claude.json", '{ "userID": "u" }', T + 100);
    const result = await merge();
    expect(result.preservedConflicts).toBe(0);
    expect(await readFile(live(), "utf8")).toBe('{ "userID": "u" }');
    expect(Math.floor((await stat(live())).mtimeMs / 1000)).toBe(T + 100);
  });
});

describe("L1 incomplete JSONL tail", () => {
  test("does not align mtime to an incoming file with an unterminated tail", async () => {
    const { home, put, merge, live, incoming } = await setup();
    await put(home, "h.jsonl", '{"a":1}\n{"b":2}\n', T);
    await put(incoming, "h.jsonl", '{"a":1}\n{"b":22}', T + 100);
    await merge();
    expect(Math.floor((await stat(live("h.jsonl"))).mtimeMs / 1000)).not.toBe(T + 100);
  });
});

test("L6: sample returns zeros when the io file is unreadable", () => {
  expect(sample("/nonexistent/io")).toEqual([0, 0, 0, 0]);
});
