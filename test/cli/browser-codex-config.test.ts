import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  expect(b).toContain(`http_headers_helper = ${JSON.stringify("'/bin/ais' browser headers --tool=codex --reveal --config-dir='/h/x'")}`);
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

test("shell-quotes paths with spaces and quotes", () => {
  const b = codexBlock(GW, "/my bin/ais", "/h/it's here");
  const line = b.split("\n").find((l) => l.startsWith("http_headers_helper"))!;
  const cmd = JSON.parse(line.slice("http_headers_helper = ".length)) as string;
  expect(cmd).toBe("'/my bin/ais' browser headers --tool=codex --reveal --config-dir='/h/it'\\''s here'");
});

test("skips folders that are missing, not Codex, Kimi, Z.ai or have an own entry, and goes on", async () => {
  const good = home("good", 'model = "m"\n');
  const missing = join(root, "missing");
  const plain = home("plain-dir");
  const kimi = home("t3-kimi-pool-acp", "x = 1\n");
  const own = home("own", '[mcp_servers.ais-browser]\ncommand = "x"\n');
  const out: string[] = [];
  expect(await runCodexConfig([missing, plain, kimi, own, good], {}, deps(out))).toBe(false);
  expect(readFileSync(join(good, "config.toml"), "utf8")).toContain("browser/mcp");
  expect(() => readFileSync(join(missing, "config.toml"))).toThrow();
  expect(() => readFileSync(join(plain, "config.toml"))).toThrow();
  expect(readFileSync(join(kimi, "config.toml"), "utf8")).toBe("x = 1\n");
  expect(readFileSync(join(own, "config.toml"), "utf8")).not.toContain("http_headers_helper");
  expect(out.join("\n")).toContain("not a Codex folder");
  expect(out.join("\n")).toContain("own ais-browser entry");
});

test("keeps the file mode", async () => {
  const h = home("mode", 'model = "m"\n');
  chmodSync(join(h, "config.toml"), 0o640);
  await runCodexConfig([h], {}, deps([]));
  expect(statSync(join(h, "config.toml")).mode & 0o777).toBe(0o640);
});

test("an auth.json or sessions folder marks a Codex folder with no config.toml", async () => {
  const h = home("authonly");
  writeFileSync(join(h, "auth.json"), "{}");
  expect(await runCodexConfig([h], {}, deps([]))).toBe(true);
  expect(readFileSync(join(h, "config.toml"), "utf8")).toContain("browser/mcp");
});

test("foreign entry detection covers every TOML spelling", () => {
  const yes = [
    "[mcp_servers.ais-browser]\nurl = \"u\"\n",
    "[mcp_servers.'ais-browser']\nurl = \"u\"\n",
    "[mcp_servers.\"ais-browser\"]\nurl = \"u\"\n",
    "[mcp_servers.ais-browser.env]\nA = \"b\"\n",
    "[ mcp_servers . ais-browser ]\nurl = \"u\"\n",
    "[mcp_servers]\nais-browser = { url = \"u\" }\n",
    "[mcp_servers]\n\"ais-browser\" = { url = \"u\" }\n",
    "mcp_servers.ais-browser.url = \"u\"\n",
    "mcp_servers.\"ais-browser\" = { url = \"u\" }\n",
  ];
  for (const t of yes) expect(hasForeignEntry(t)).toBe(true);
  const no = ["[mcp_servers.other]\nurl = \"u\"\n", "[mcp_servers]\nother = { url = \"u\" }\n", "[model_providers.x]\nais-browser = 1\n", 'model = "m"\n'];
  for (const t of no) expect(hasForeignEntry(t)).toBe(false);
  expect(hasForeignEntry(applyBlock("", codexBlock(GW, "/bin/ais", "/h")))).toBe(false);
});
