import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrowserWiring } from "../../src/cli/browser/wiring.ts";
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

test("t3-claude-kimi-<name> maps to <name>; t3-claude-kimi-pool maps to the single pool", () => {
  expect(map(join(gw, "t3-claude-kimi-alpha"))).toBe("alpha");
  expect(map(join(gw, "t3-claude-zai-alpha"))).toBe("alpha");
  expect(map(join(gw, "t3-claude-kimi-pool"))).toBe("team-pool");
});

test("pool stem needs exactly one swap pool", () => {
  const two = { ...file, identities: [...file.identities, id("other-pool", { swapPool: { accounts: [], active: "" } })] };
  expect(map(join(gw, "t3-claude-kimi-pool"), two)).toBeUndefined();
});

test("a matching basename outside the gateway root does not map", () => {
  expect(map(join(root, "elsewhere", "t3-claude-alpha"))).toBeUndefined();
  expect(map(join(gw, "nested", "t3-claude-alpha"))).toBeUndefined();
});

test("retired identities never map", () => {
  expect(map(join(gw, "t3-claude-beta"))).toBeUndefined();
});

test("wiring check: wired and unwired instances", async () => {
  const t3 = join(root, "t3");
  mkdirSync(join(t3, "userdata"), { recursive: true });
  const poolDir = join(root, "ids", "alpha");
  mkdirSync(poolDir, { recursive: true });
  writeFileSync(join(poolDir, "ais-browser-token"), "SYNTHETIC_FIXTURE-token\n");
  const reg = join(root, "claude-identities.json");
  const f = {
    version: 1,
    identities: [
      { name: "alpha", label: "alpha", configDir: poolDir },
      { name: "team-pool", label: "p", configDir: join(root, "ids", "pool"), aliases: ["shared-pool"], swapPool: { accounts: ["alpha"], active: "alpha" } },
    ],
  };
  writeFileSync(reg, JSON.stringify(f));
  const inst = (driver: string, homePath: string, enabled = true) => ({ driver, enabled, config: { homePath } });
  writeFileSync(join(t3, "userdata", "settings.json"), JSON.stringify({
    providerInstances: {
      "shared-pool": inst("claudeAgent", join(gw, "shared-pool")),
      "t3-claude-gamma": inst("claudeAgent", join(gw, "t3-claude-gamma")),
      "t3-claude-off": inst("claudeAgent", join(gw, "t3-claude-off"), false),
      "t3-grok-x": inst("grok", join(gw, "t3-grok-x")),
    },
  }));
  const lines: string[] = [];
  const res = await runBrowserWiring({ check: true }, { t3Home: t3, aisBinary: "/bin/ais", registryPath: () => reg, out: (l) => lines.push(l) });
  expect(res.ok).toBe(false);
  expect(res.rows.map((r) => [r.instance, r.target, r.wired, r.reason])).toEqual([
    ["shared-pool", "pool:team-pool", true, undefined],
    ["t3-claude-gamma", null, false, "no identity"],
  ]);
  expect(lines.join("\n")).toContain("NOT wired: no identity");
  expect(lines.join("\n")).not.toContain("SYNTHETIC_FIXTURE");
  const json: string[] = [];
  await runBrowserWiring({ json: true }, { t3Home: t3, aisBinary: "/bin/ais", registryPath: () => reg, out: (l) => json.push(l) });
  expect(JSON.parse(json[0]!)).toHaveLength(2);
  const none = await runBrowserWiring({}, { t3Home: t3, aisBinary: undefined, registryPath: () => reg, out: () => {} });
  expect(none.rows[0]!.reason).toBe("ais binary not installed");
  rmSync(join(poolDir, "ais-browser-token"));
  const noTok = await runBrowserWiring({}, { t3Home: t3, aisBinary: "/bin/ais", registryPath: () => reg, out: () => {} });
  expect(noTok.rows[0]!.reason).toBe("no token");
});
