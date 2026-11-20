import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityForConfigDir } from "../../src/shared/browser-wiring.ts";

const root = mkdtempSync(join(tmpdir(), "ais-t3-wiring-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const gw = join(root, "t3", "gateway");
const id = (name: string, extra: object = {}) => ({ name, label: name, configDir: `/ids/${name}`, ...extra });
const file: any = {
  version: 1,
  identities: [
    id("alpha"),
    id("beta", { retired: true }),
    id("team-pool", { aliases: ["shared-pool"], swapPool: { accounts: ["alpha"], active: "alpha" } }),
  ],
};
const noLinks = (p: string): string => {
  if (p.endsWith("/projects") || p.endsWith("/sessions")) throw new Error("ENOENT");
  return p;
};
const map = (dir: string, f: any = file) => identityForConfigDir(f, dir, noLinks, gw)?.name;

test("shared-pool folder in the T3 gateway maps to the pool by alias", () => {
  expect(map(join(gw, "shared-pool"))).toBe("team-pool");
});

test("t3-claude-<name> without links maps by name", () => {
  expect(map(join(gw, "t3-claude-alpha"))).toBe("alpha");
});

test("Kimi and Z.ai folders never map to a Claude identity", () => {
  expect(map(join(gw, "t3-claude-kimi-alpha"))).toBeUndefined();
  expect(map(join(gw, "t3-claude-zai-alpha"))).toBeUndefined();
  expect(map(join(gw, "t3-claude-kimi-pool"))).toBeUndefined();
});

test("pool stem needs exactly one swap pool", () => {
  expect(map(join(gw, "pool"))).toBe("team-pool");
  const two = { ...file, identities: [...file.identities, id("other-pool", { swapPool: { accounts: [], active: "" } })] };
  expect(map(join(gw, "pool"), two)).toBeUndefined();
});

test("a matching basename outside the gateway root does not map", () => {
  expect(map(join(root, "elsewhere", "t3-claude-alpha"))).toBeUndefined();
  expect(map(join(gw, "nested", "t3-claude-alpha"))).toBeUndefined();
});

test("retired identities never map", () => {
  expect(map(join(gw, "t3-claude-beta"))).toBeUndefined();
});

test("a launcher's own folder maps to the identity its transcript link points into; unrelated links do not", () => {
  const id = (name: string, dir: string, extra: object = {}) => ({ name, label: name, configDir: dir, ...extra });
  const file: any = { version: 1, identities: [id("work", "/ids/work"), id("old", "/ids/old", { retired: true }), id("cx", "/cx/cx")] };
  const links: Record<string, string> = {
    "/t3/claude-work/projects": "/ids/work/projects",
    "/t3/codex-cx/sessions": "/cx/cx/sessions",
    "/t3/claude-old/projects": "/ids/old/projects",
    "/t3/stray/projects": "/elsewhere/projects",
    "/t3/plain/projects": "/t3/plain/projects",
  };
  const real = (p: string): string => {
    if (p in links) return links[p]!;
    if (p.endsWith("/projects") || p.endsWith("/sessions")) throw new Error("ENOENT");
    return p;
  };
  expect(identityForConfigDir(file, "/t3/claude-work", real)?.name).toBe("work");
  expect(identityForConfigDir(file, "/t3/codex-cx", real)?.name).toBe("cx");
  expect(identityForConfigDir(file, "/t3/claude-old", real)).toBeUndefined();
  expect(identityForConfigDir(file, "/t3/stray", real)).toBeUndefined();
  expect(identityForConfigDir(file, "/t3/plain", real)).toBeUndefined();
  expect(identityForConfigDir(file, "/t3/none", real)).toBeUndefined();
});

test("a preset config dir maps back to its registered pool and plain identity; retired and unknown folders map to nothing", () => {
  const id = (name: string, extra: object = {}) => ({ name, label: name, configDir: `/m/${name}`, ...extra });
  const pool = { name: "team-pool", label: "p", configDir: "/ids/swap", swapPool: { accounts: ["a", "b"], active: "a" } };
  const file: any = { version: 1, identities: [id("a"), id("b"), id("old", { configDir: "/ids/old", retired: true }), pool] };
  expect(identityForConfigDir(file, "/ids/swap/")?.name).toBe("team-pool");
  expect(identityForConfigDir(file, "/m/a")?.name).toBe("a");
  expect(identityForConfigDir(file, "/ids/old")).toBeUndefined();
  expect(identityForConfigDir(file, "/elsewhere")).toBeUndefined();
});
