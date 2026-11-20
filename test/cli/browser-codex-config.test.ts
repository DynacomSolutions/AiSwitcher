import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBlock, codexBlock, hasForeignEntry, runCodexConfig, stripBlock } from "../../src/cli/browser/codex-config.ts";

const root = mkdtempSync(join(tmpdir(), "ais-codex-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const GW = "https://gw.example.test/gateway";
const deps = (out: string[]) => ({ gatewayUrl: async () => GW, aisBinary: () => "/bin/ais", defaultHomes: async () => [], out: (l: string) => out.push(l) });
const home = (name: string, text?: string): string => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  if (text !== undefined) writeFileSync(join(d, "config.toml"), text);
  return d;
};

test("block holds url, helper command with the folder, timeout, and no token", () => {
  const b = codexBlock(GW, "/bin/ais", "/h/x");
  expect(b).toContain('url = "https://gw.example.test/gateway/browser/mcp"');
  expect(b).toContain('http_headers_helper = "/bin/ais browser headers --tool=codex --config-dir=/h/x"');
  expect(b).toContain("tool_timeout_sec = 135");
  expect(b).not.toMatch(/bearer|token/i);
});

test("apply is idempotent and keeps other content; strip restores it", () => {
  const b = codexBlock(GW, "/bin/ais", "/h/x");
  const once = applyBlock('model = "m"\n', b);
  expect(applyBlock(once, b)).toBe(once);
  expect(stripBlock(once).trim()).toBe('model = "m"');
  expect(applyBlock(once, undefined)).toBe('model = "m"\n');
  expect(hasForeignEntry(once)).toBe(false);
  expect(hasForeignEntry('[mcp_servers.ais-browser]\ncommand = "x"\n')).toBe(true);
});

test("write, check, remove", async () => {
  const h = home("a", 'model = "m"\n');
  const out: string[] = [];
  expect(await runCodexConfig([h], { check: true }, deps(out))).toBe(false);
  expect(await runCodexConfig([h], {}, deps(out))).toBe(true);
  expect(readFileSync(join(h, "config.toml"), "utf8")).toContain("[mcp_servers.ais-browser]");
  expect(await runCodexConfig([h], { check: true }, deps(out))).toBe(true);
  expect(await runCodexConfig([h], { remove: true }, deps(out))).toBe(true);
  expect(readFileSync(join(h, "config.toml"), "utf8")).toBe('model = "m"\n');
  expect(out.some((l) => l.includes("written"))).toBe(true);
});

test("creates a missing config.toml; skips Kimi, Z.ai and folders with an own entry", async () => {
  const fresh = home("fresh");
  const kimi = home("t3-kimi-pool-acp");
  const own = home("own", '[mcp_servers.ais-browser]\ncommand = "x"\n');
  const out: string[] = [];
  const ok = await runCodexConfig([fresh, kimi, own], {}, deps(out));
  expect(ok).toBe(false);
  expect(readFileSync(join(fresh, "config.toml"), "utf8")).toContain("browser/mcp");
  expect(() => readFileSync(join(kimi, "config.toml"))).toThrow();
  expect(readFileSync(join(own, "config.toml"), "utf8")).not.toContain("http_headers_helper");
  expect(out.join("\n")).toContain("own [mcp_servers.ais-browser] entry");
});
