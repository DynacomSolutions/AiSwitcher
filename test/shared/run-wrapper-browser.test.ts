import { expect, test } from "bun:test";
import { browserMcpArgs } from "../../src/shared/browser-wiring.ts";

const yes = { exists: () => true };
const no = { exists: () => false };
const shim = ["browser", "mcp", "--config-dir", "/c", "--identity", "work", "--gateway", "https://gw.test"];

test("claude gets a single-token --mcp-config with shim args, no strict, no token", () => {
  const args = browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, identityName: "work", gateway: "https://gw.test" });
  expect(args.length).toBe(1);
  expect(args[0]!.startsWith("--mcp-config=")).toBe(true);
  expect(JSON.parse(args[0]!.slice("--mcp-config=".length))).toEqual({ mcpServers: { "ais-browser": { command: "/bin/ais", args: shim } } });
});

test("codex gets -c overrides with args and env_vars", () => {
  expect(browserMcpArgs("codex", "/c", undefined, "/bin/ais", { ...yes, identityName: "work", gateway: "https://gw.test" })).toEqual([
    "-c", 'mcp_servers.ais-browser.command="/bin/ais"',
    "-c", `mcp_servers.ais-browser.args=${JSON.stringify(shim)}`,
    "-c", 'mcp_servers.ais-browser.env_vars=["CODEX_HOME","AIS_GATEWAY_PROXY_URL","AI_PROFILE_SWITCHER_SESSION"]',
  ]);
});

test("optional identity and gateway are omitted", () => {
  const a = browserMcpArgs("codex", "/c", {}, "/bin/ais", yes);
  expect(a[3]).toBe('mcp_servers.ais-browser.args=["browser","mcp","--config-dir","/c"]');
});

test("nothing without token file, retired, other tools, or claude subcommands", () => {
  expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", no)).toEqual([]);
  expect(browserMcpArgs("codex", "/c", { retired: true }, "/bin/ais", yes)).toEqual([]);
  expect(browserMcpArgs("kimi", "/c", {}, "/bin/ais", yes)).toEqual([]);
  for (const sub of ["mcp", "doctor", "update", "config", "install"]) expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, firstArg: sub })).toEqual([]);
  expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, firstArg: "hello" }).length).toBe(1);
});
