import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageBars } from "../../src/cli/statusline.ts";
import { PLUGIN_VERSION } from "../../mods/ais-usage/hooks/model.ts";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const win = (category: string, usedPercent: number) => ({ label: category, category, usedPercent, resetsAt: "Oct 17, 8:00 AM" });

/** Cache dir with one claude-limits file per name. */
const cache = (used: Record<string, [number, number]>, extra: Record<string, object> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ais-statusline-"));
  mkdirSync(join(dir, "claude-limits"));
  for (const [n, [s, w]] of Object.entries(used)) {
    writeFileSync(join(dir, "claude-limits", `${n}.json`), JSON.stringify({ toolName: "claude", windows: [win("session", s), win("week", w)], status: "live", ...(extra[n] ? { extraUsage: extra[n] } : {}) }));
  }
  return dir;
};
const RULE = (n: number) => "─".repeat(n);
const id = (name: string, configDir: string, swapPool?: object) => ({ name, label: name, configDir, ...(swapPool ? { swapPool } : {}) }) as never;

test("plain identity: one row per window", async () => {
  const cacheDir = cache({ solo: [30, 80] });
  const out = await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/solo/", COLUMNS: "100" }, { cacheDir, identities: async () => [id("solo", "/c/solo")] });
  const lines = strip(out).trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[2]).toBe(RULE(96));
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
  for (const l of [s80, w80]) expect(l.length).toBeLessThanOrEqual(76);
  for (const l of [s200, w200]) expect(l.length).toBeLessThanOrEqual(196);
});

/** Writes the mod's snapshot for config dir `/c/swap` into `dir`. */
const snapshot = (dir: string, over: object | string, name = "swap.json") => {
  mkdirSync(join(dir, "ais-usage"), { recursive: true });
  const codex = { toolName: "codex", identity: { name: "a", configDir: "/x/a" }, windows: [win("session", 12), win("week", 34)], status: "live" };
  const claude = { toolName: "claude", identity: { name: "a", configDir: "/c/a" }, windows: [win("session", 10), win("week", 20)], status: "live" };
  const pool = { toolName: "claude", identity: { name: "team", configDir: "/c/swap", swapPool: { active: "a", accounts: ["a", "b"] } }, windows: [], status: "unavailable" };
  const codexPool = { toolName: "codex", identity: { name: "team", configDir: "/x/team", swapPool: { active: "a", accounts: ["a"] } }, windows: [], status: "unavailable" };
  const body = typeof over === "string" ? over : JSON.stringify({ othersOpen: false, membersOpen: false, limits: [pool, claude, codex, codexPool], status: null, updatedAt: Date.now(), pluginVersion: PLUGIN_VERSION, ...over });
  writeFileSync(join(dir, "ais-usage", name), body);
};
const poolRun = async (over: object | string, cols = 100) => {
  const cacheDir = cache({ a: [10, 20], b: [30, 40] });
  snapshot(cacheDir, over);
  const out = await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/swap", COLUMNS: String(cols) }, {
    cacheDir,
    identities: async () => [id("team", "/c/swap", { active: "a", accounts: ["a", "b"] }), id("a", "/c/a"), id("b", "/c/b")],
  });
  return { out, lines: strip(out).trimEnd().split("\n") };
};

test("open others: a rule, then a codex block with pool totals at column 0, full width", async () => {
  const { out, lines } = await poolRun({ open: "others" });
  const i = lines.indexOf("codex");
  expect(i).toBeGreaterThan(1);
  expect(lines[i - 1]).toBe(RULE(96));
  expect(out).toContain("\u001b[1mcodex\u001b[0m");
  const rows = lines.slice(i + 1, -1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatch(/^session\s+\[█+\]/);
  expect(rows[0]!.length).toBeGreaterThanOrEqual(90);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(96);
});

test("closed: bars then one rule last; open: bars, rule, section, rule, never two rules in a row", async () => {
  const closed = (await poolRun({})).lines;
  expect(closed.at(-1)).toBe(RULE(96));
  expect(closed.at(-2)).toMatch(/^week\s/);
  expect(closed.filter((l) => l.startsWith("─"))).toHaveLength(1);
  for (const open of ["others", "members"]) {
    const { lines } = await poolRun({ open });
    expect(lines.at(-1)).toBe(RULE(96));
    expect(lines.at(-2)).not.toBe(RULE(96));
    const first = lines.findIndex((l) => l.startsWith("─"));
    expect(lines[first - 1]).toMatch(/^week\s/);
    expect(lines[first + 1]).not.toBe(RULE(100));
  }
});

test("a braille-blank spacer line sits just before the colour key", async () => {
  const { out, lines } = await poolRun({});
  const k = lines.findIndex((l) => l.includes("team > "));
  expect(k).toBeGreaterThan(0);
  expect(strip(out).split("\n")[k - 1]).toBe("\u2800");
});

test("old othersOpen field still opens the section", async () => {
  const { lines } = await poolRun({ othersOpen: true });
  expect(lines).toContain("codex");
});

test("every pool snapshot line fits Claude Code's four-column inset at 80 and 120", async () => {
  for (const cols of [80, 120]) {
    const { lines } = await poolRun({ open: "others" }, cols);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(cols - 4);
  }
});

test("narrow pool row puts the complete reset label on its own dim line", async () => {
  const { lines } = await poolRun({}, 64);
  expect(lines).toContain("  resets 08:00");
  expect(lines).toContain("  resets Oct 17");
  expect(lines.filter((line) => line.startsWith("  resets ")).every((line) => line.length < 30)).toBe(true);
});

const wideStatus = { pool: "team", active: "a", auto: true, thresholdPercent: 95, accounts: ["a", "b", "c", "d"].map((name) => ({ name, active: name === "a", allowed: true })) };
const membersRun = async (cols: number) => {
  const cacheDir = cache({ a: [10, 20], b: [30, 40], c: [50, 60], d: [70, 80] });
  const mk = (name: string) => ({ toolName: "claude", identity: { name, configDir: `/c/${name}` }, windows: [win("session", 10), win("week", 20)], status: "live" });
  const pool = { toolName: "claude", identity: { name: "team", configDir: "/c/swap", swapPool: { active: "a", accounts: ["a", "b", "c", "d"] } }, windows: [], status: "unavailable" };
  snapshot(cacheDir, { open: "members", limits: [pool, ...["a", "b", "c", "d"].map(mk)], status: wideStatus });
  const out = await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/swap", COLUMNS: String(cols) }, {
    cacheDir,
    identities: async () => [id("team", "/c/swap", { active: "a", accounts: ["a", "b", "c", "d"] }), ...["a", "b", "c", "d"].map((n) => id(n, `/c/${n}`))],
  });
  return strip(out).trimEnd().split("\n");
};

test("member cards: current tool only, no codex, 4 per row at 160 and one per row at 60; no line exceeds the width", async () => {
  const wide = await membersRun(160);
  const sec = (ls: string[]) => ls.slice(ls.findIndex((x) => x.startsWith("─")));
  expect(wide.some((l) => l === "claude" || l === "codex")).toBe(false);
  expect(wide.filter((l) => /^a\s+b\s+c\s+d$/.test(l.trim()) || /^a\s+b/.test(l))).toHaveLength(1); // all four on one row
  const narrow = await membersRun(60);
  expect(narrow.filter((l) => /^[abcd]$/.test(l))).toHaveLength(4);
  expect(sec(narrow).some((l) => l.length === 56)).toBe(true);
  for (const [ls, n] of [[wide, 156], [narrow, 56]] as const) for (const l of sec(ls)) expect(l.length).toBeLessThanOrEqual(n);
  expect(wide.some((l) => l.startsWith("─"))).toBe(true);
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

test("extra row: drawn when enabled, off label when the current member has it off", async () => {
  const x = (usedPercent: number) => ({ enabled: true, available: true, usedPercent, label: "x" });
  const cacheDir = cache({ a: [10, 20], b: [30, 40] }, { b: x(60) });
  const pool = [id("team", "/c/team", { active: "a", accounts: ["a", "b"] }), id("a", "/c/a"), id("b", "/c/b")];
  const out = strip(await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/team", COLUMNS: "120" }, { cacheDir, identities: async () => pool }));
  expect(out).toMatch(/^extra\s+\[█+\] pool 60% used, 40% left\s+\|\s+a off/m);
  const solo = strip(await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/b", COLUMNS: "100" }, { cacheDir, identities: async () => pool }));
  expect(solo).toMatch(/^extra\s+\[█+\] 60%/m);
  const none = strip(await usageBars("{}", { CLAUDE_CONFIG_DIR: "/c/a", COLUMNS: "100" }, { cacheDir, identities: async () => pool }));
  expect(none).not.toContain("extra");
});

test("two sessions on one identity each draw their own toggle; no session file falls back to the identity file", async () => {
  const cacheDir = cache({ a: [10, 20], b: [30, 40] });
  snapshot(cacheDir, { open: "others" }, "swap.s1.json");
  snapshot(cacheDir, {}, "swap.s2.json");
  snapshot(cacheDir, { open: "others" }, "swap.json");
  const run = async (session_id: string) =>
    strip(await usageBars(JSON.stringify({ session_id }), { CLAUDE_CONFIG_DIR: "/c/swap", COLUMNS: "100" }, {
      cacheDir,
      identities: async () => [id("team", "/c/swap", { active: "a", accounts: ["a", "b"] }), id("a", "/c/a"), id("b", "/c/b")],
    })).split("\n");
  expect((await run("s1")).includes("codex")).toBe(true);
  expect((await run("s2")).includes("codex")).toBe(false);
  expect((await run("old")).includes("codex")).toBe(true);
});

test("plugin version constant matches plugin.json", () => {
  expect(PLUGIN_VERSION).toBe(JSON.parse(readFileSync(join(import.meta.dir, "../../mods/ais-usage/.claude-plugin/plugin.json"), "utf8")).version);
});

test("snapshot from an older or versionless mod adds the outdated notice; a current one does not", async () => {
  const notice = "ais-usage outdated: /reload-plugins or restart";
  expect((await poolRun({})).lines.join("\n")).not.toContain(notice);
  expect((await poolRun({ pluginVersion: "0.5.0" })).lines.at(-1)).toBe(notice);
  expect((await poolRun({ pluginVersion: undefined })).lines.at(-1)).toBe(notice);
  expect((await poolRun({ pluginVersion: "9.0.0" })).lines.join("\n")).not.toContain(notice);
});
