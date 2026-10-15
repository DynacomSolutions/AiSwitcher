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
