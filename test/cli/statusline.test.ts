import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageBars } from "../../src/cli/statusline.ts";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const win = (category: string, usedPercent: number) => ({ label: category, category, usedPercent, resetsAt: "Oct 17, 8:00 AM" });

/** Cache dir with one claude-limits file per name. */
const cache = (used: Record<string, [number, number]>) => {
  const dir = mkdtempSync(join(tmpdir(), "ais-statusline-"));
  mkdirSync(join(dir, "claude-limits"));
  for (const [n, [s, w]] of Object.entries(used)) {
    writeFileSync(join(dir, "claude-limits", `${n}.json`), JSON.stringify({ toolName: "claude", windows: [win("session", s), win("week", w)], status: "live" }));
  }
  return dir;
};
const id = (name: string, configDir: string, swapPool?: object) => ({ name, label: name, configDir, ...(swapPool ? { swapPool } : {}) }) as never;

test("plain identity: one row per window", async () => {
  const cacheDir = cache({ solo: [30, 80] });
  const out = await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/solo/", COLUMNS: "100" }, { cacheDir, identities: async () => [id("solo", "/c/solo")] });
  const lines = strip(out).trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^session\s+\[█+\] 30%/);
  expect(lines[1]).toMatch(/^week\s+\[█+\] 80%\s+resets Oct 1\d/);
  expect(out).toContain("\u001b[32m"); // 30% green
  expect(out).toContain("\u001b[33m"); // 80% yellow
});

test("pool: header, pool percentage, and a new member changes the output", async () => {
  const cacheDir = cache({ a: [10, 20], b: [30, 40], c: [80, 90] });
  const pool = (accounts: string[]) => [id("team", "/c/team", { active: "a", accounts }), id("a", "/c/a"), id("b", "/c/b"), id("c", "/c/c")];
  const run = async (accounts: string[]) =>
    strip(await usageBars(JSON.stringify({ viewport: { columns: 120 } }), { CLAUDE_CONFIG_DIR: "/c/team" }, { cacheDir, identities: async () => pool(accounts) }));
  const two = await run(["a", "b"]);
  expect(two).toContain("team > ");
  expect(two).toContain("pool 20% used, 80% left  |  a 10%");
  const three = await run(["a", "b", "c"]);
  expect(three).toContain("pool 40% used, 60% left  |  a 10%");
});

test("missing data and errors print nothing", async () => {
  const cacheDir = cache({});
  expect(await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/nope" }, { cacheDir, identities: async () => [id("solo", "/c/solo")] })).toBe("");
  expect(await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/solo" }, { cacheDir, identities: async () => [id("solo", "/c/solo")] })).toBe("");
  expect(await usageBars("not json", {}, { identities: async () => { throw new Error("boom"); } })).toBe("");
});

test("wrap output comes first, unchanged, even with no bars", async () => {
  const run = (env: Record<string, string>) =>
    Bun.spawn(["bun", "run", "src/ais.ts", "statusline", "--wrap", "cat; printf TAIL"], {
      stdin: new TextEncoder().encode('{"x":1}'),
      stdout: "pipe",
      env: { ...process.env, ...env },
    });
  const p = run({ CLAUDE_CONFIG_DIR: "/nonexistent/dir" });
  expect(await new Response(p.stdout).text()).toBe('{"x":1}TAIL');
  expect(await p.exited).toBe(0);
});

test("rows share one bar width and start column; it scales with the terminal; nothing exceeds it", async () => {
  const cacheDir = cache({ solo: [30, 80] });
  const run = async (cols: number) =>
    strip(await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/solo/", COLUMNS: String(cols) }, { cacheDir, identities: async () => [id("solo", "/c/solo")] })).trimEnd().split("\n");
  const barLen = (l: string) => l.slice(l.indexOf("[") + 1, l.indexOf("]")).length;
  const [s80, w80] = await run(80);
  const [s200, w200] = await run(200);
  expect(barLen(s80)).toBe(barLen(w80));
  expect(s80.indexOf("[")).toBe(w80.indexOf("["));
  expect(barLen(s200)).toBe(barLen(w200));
  expect(barLen(s200)).toBeGreaterThan(barLen(s80) + 100);
  for (const l of [s80, w80]) expect(l.length).toBeLessThanOrEqual(80);
  for (const l of [s200, w200]) expect(l.length).toBeLessThanOrEqual(200);
});

/** Writes the mod's snapshot for config dir `/c/swap` into `dir`. */
const snapshot = (dir: string, over: object | string, name = "swap.json") => {
  mkdirSync(join(dir, "ais-usage"), { recursive: true });
  const codex = { toolName: "codex", identity: { name: "a", configDir: "/x/a" }, windows: [win("session", 12), win("week", 34)], status: "live" };
  const claude = { toolName: "claude", identity: { name: "a", configDir: "/c/a" }, windows: [win("session", 10), win("week", 20)], status: "live" };
  const pool = { toolName: "claude", identity: { name: "team", configDir: "/c/swap", swapPool: { active: "a", accounts: ["a", "b"] } }, windows: [], status: "unavailable" };
  const body = typeof over === "string" ? over : JSON.stringify({ othersOpen: false, membersOpen: false, limits: [pool, claude, codex], status: null, updatedAt: Date.now(), ...over });
  writeFileSync(join(dir, "ais-usage", name), body);
};
const poolRun = async (over: object | string) => {
  const cacheDir = cache({ a: [10, 20], b: [30, 40] });
  snapshot(cacheDir, over);
  const out = await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/swap", COLUMNS: "100" }, {
    cacheDir,
    identities: async () => [id("team", "/c/swap", { active: "a", accounts: ["a", "b"] }), id("a", "/c/a"), id("b", "/c/b")],
  });
  return { out, lines: strip(out).trimEnd().split("\n") };
};

test("snapshot with othersOpen appends a codex block at column 0, full width", async () => {
  const { out, lines } = await poolRun({ othersOpen: true });
  const i = lines.indexOf("codex");
  expect(i).toBeGreaterThan(0);
  expect(out).toContain("\u001b[1mcodex\u001b[0m");
  const rows = lines.slice(i + 1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatch(/^session\s+\[█+\]/);
  const main = lines.find((l) => l.startsWith("session"))!;
  expect(rows[0]!.length).toBe(main.length);
  expect(rows[0]!.length).toBeGreaterThanOrEqual(90);
});

test("snapshot with membersOpen shows member names", async () => {
  const { lines } = await poolRun({ membersOpen: true, status: { pool: "team", active: "a", auto: true, thresholdPercent: 95, accounts: [{ name: "a", active: true, allowed: true }, { name: "b", active: false, allowed: true }] } });
  expect(lines).toContain("claude");
  expect(lines).toContain("b");
});

test("snapshot with both toggles closed prints the main bars only", async () => {
  const { lines } = await poolRun({});
  expect(lines.some((l) => l === "codex")).toBe(false);
  expect(lines.filter((l) => /^(session|week)\s/.test(l))).toHaveLength(2);
});

test("bad, stale or torn snapshot prints the main bars only", async () => {
  for (const over of ["{not json", JSON.stringify({ othersOpen: true }), { othersOpen: true, updatedAt: 1 }]) {
    const { lines } = await poolRun(over);
    expect(lines.some((l) => l === "codex")).toBe(false);
    expect(lines.filter((l) => /^(session|week)\s/.test(l))).toHaveLength(2);
  }
});
