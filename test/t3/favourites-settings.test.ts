import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readT3Settings, writeT3Favourites } from "../../src/t3/favourites/settings.ts";
import { CLAUDE_POOL, makeHome, scratch } from "./favourites-fixtures.ts";

describe("settings.json", () => {
  test("reads the favourites and the instance ids", async () => {
    const h = makeHome({ favorites: [{ provider: CLAUDE_POOL, model: "m1" }], instances: [CLAUDE_POOL, "codex"] });
    const s = (await readT3Settings(h.home))!;
    expect(s.favorites).toEqual([{ provider: CLAUDE_POOL, model: "m1" }]);
    expect([...s.instances].sort()).toEqual([CLAUDE_POOL, "codex"]);
  });
  test("a home with no settings file reads as undefined", async () => {
    expect(await readT3Settings("/nonexistent-favsync-home")).toBeUndefined();
  });
  test("a file with a favourites entry of an unknown shape is not touched", async () => {
    const h = makeHome({ extra: { favorites: ["x"] } });
    await expect(readT3Settings(h.home)).rejects.toThrow(/unknown shape/);
    const bad = makeHome({ extra: { favorites: "x" } });
    await expect(readT3Settings(bad.home)).rejects.toThrow(/not a list/);
  });
  test("a write changes only favorites: other keys, their order, the indent and the final newline stay", async () => {
    const h = makeHome({ favorites: [{ provider: CLAUDE_POOL, model: "m1" }], indent: 4, extra: { sidebarAutoSettleAfterDays: 3, nested: { a: [1, 2] } } });
    const before = h.read();
    const s = (await readT3Settings(h.home))!;
    expect(await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m2" }])).toBe("written");
    const after = h.read();
    expect(after.favorites).toEqual([{ provider: CLAUDE_POOL, model: "m2" }]);
    const { favorites: _a, ...restAfter } = after;
    const { favorites: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(h.text().startsWith('{\n    "favorites"')).toBe(true);
    expect(h.text().endsWith("}\n")).toBe(true);
  });
  test("a file with no favorites key gets one at the end", async () => {
    const h = makeHome();
    const raw = h.read();
    delete raw.favorites;
    writeFileSync(h.settings, JSON.stringify(raw, null, 2));
    const s = (await readT3Settings(h.home))!;
    await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m" }]);
    expect(Object.keys(h.read()).at(-1)).toBe("favorites");
    expect(h.text().endsWith("\n")).toBe(false);
  });
  test("the mode stays and no temp file is left", async () => {
    const h = makeHome({ mode: 0o640 });
    chmodSync(h.settings, 0o640);
    const s = (await readT3Settings(h.home))!;
    await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m" }]);
    expect(statSync(h.settings).mode & 0o777).toBe(0o640);
    expect(readdirSync(dirname(h.settings))).toEqual(["settings.json"]);
  });
  test("a write of equal content does nothing", async () => {
    const h = makeHome({ favorites: [{ provider: CLAUDE_POOL, model: "m1" }] });
    const s = (await readT3Settings(h.home))!;
    const mtime = statSync(h.settings).mtimeMs;
    expect(await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m1" }])).toBe("unchanged");
    expect(statSync(h.settings).mtimeMs).toBe(mtime);
  });
  test("when T3 wrote the file meanwhile, nothing is replaced and no temp file stays", async () => {
    const h = makeHome();
    const s = (await readT3Settings(h.home))!;
    const t3Wrote = { ...h.read(), defaultAutoPull: false };
    writeFileSync(h.settings, `${JSON.stringify(t3Wrote, null, 2)}\n`);
    expect(await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m" }])).toBe("changed");
    expect(h.read().defaultAutoPull).toBe(false);
    expect(h.read().favorites).toEqual([]);
    expect(existsSync(h.settings)).toBe(true);
    expect(readdirSync(dirname(h.settings))).toEqual(["settings.json"]);
  });

  // The re-read of the text catches most races. The check of mtime, size and inode just before the rename catches a write that
  // leaves the same text (or a rewrite by another tool that keeps the content): the round must run again.
  test("a rewrite of the same text by another writer (new mtime) makes the write say changed", async () => {
    const h = makeHome();
    const s = (await readT3Settings(h.home))!;
    const later = new Date(Date.now() + 5000);
    utimesSync(h.settings, later, later);
    expect(await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m" }])).toBe("changed");
    expect(h.read().favorites).toEqual([]);
    expect(readdirSync(dirname(h.settings))).toEqual(["settings.json"]);
  });
  test("a replacement of the file with the same text and time (new inode) makes the write say changed", async () => {
    const h = makeHome();
    const s = (await readT3Settings(h.home))!;
    const copy = `${h.settings}.copy`;
    copyFileSync(h.settings, copy);
    const st = statSync(h.settings);
    utimesSync(copy, st.atime, st.mtime);
    renameSync(copy, h.settings);
    expect(await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m" }])).toBe("changed");
    expect(h.read().favorites).toEqual([]);
  });
  test("a settings.json that is a symlink is written through: the link stays and its target changes", async () => {
    const h = makeHome({ favorites: [{ provider: CLAUDE_POOL, model: "m1" }] });
    const elsewhere = scratch();
    mkdirSync(join(elsewhere, "real"), { recursive: true });
    const real = join(elsewhere, "real", "settings.real.json");
    renameSync(h.settings, real);
    symlinkSync(real, h.settings);
    const s = (await readT3Settings(h.home))!;
    expect(s.favorites).toEqual([{ provider: CLAUDE_POOL, model: "m1" }]);
    expect(await writeT3Favourites(s, [{ provider: CLAUDE_POOL, model: "m2" }])).toBe("written");
    expect(lstatSync(h.settings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).favorites).toEqual([{ provider: CLAUDE_POOL, model: "m2" }]);
    expect(readdirSync(dirname(real))).toEqual(["settings.real.json"]);
    expect(readdirSync(dirname(h.settings))).toEqual(["settings.json"]);
  });
});
