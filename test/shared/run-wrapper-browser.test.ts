import { expect, test } from "bun:test";
import { browserLaunchEnv, browserMcpArgs } from "../../src/shared/browser-wiring.ts";

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
    "-c", "mcp_servers.ais-browser.tool_timeout_sec=135",
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

test("no installed ais binary means no wiring at all", () => {
  expect(browserMcpArgs("claude", "/c", {}, undefined, yes)).toEqual([]);
  expect(browserMcpArgs("codex", "/c", {}, undefined, yes)).toEqual([]);
});

test("claude launch gets MCP_TOOL_TIMEOUT=135000 only when wired and not already set", () => {
  const wired = ["--mcp-config={}"];
  expect(browserLaunchEnv("claude", wired, {})).toEqual({ MCP_TOOL_TIMEOUT: "135000" });
  expect(browserLaunchEnv("claude", wired, { MCP_TOOL_TIMEOUT: "60000" })).toEqual({});
  expect(browserLaunchEnv("claude", [], {})).toEqual({});
  expect(browserLaunchEnv("codex", wired, {})).toEqual({});
});

import { poolMemberConfigDirs } from "../../src/shared/browser-wiring.ts";

const poolShim = ["browser", "mcp", "--pool", "team-pool", "--tool", "claude"];
const poolOf = (dirs: string[]) => ({ name: "team-pool", memberConfigDirs: dirs });

test("pool launch wires when any member has a token, with pool shim args", () => {
  const withB = { exists: (p: string) => p === "/m/b/ais-browser-token" };
  const args = browserMcpArgs("claude", "/pool", { }, "/bin/ais", { ...withB, identityName: "team-pool", pool: poolOf(["/m/a", "/m/b"]) });
  expect(JSON.parse(args[0]!.slice("--mcp-config=".length)).mcpServers["ais-browser"].args).toEqual(poolShim);
  const codex = browserMcpArgs("codex", "/pool", {}, "/bin/ais", { ...withB, pool: poolOf(["/m/b"]) });
  expect(codex[3]).toBe(`mcp_servers.ais-browser.args=${JSON.stringify(["browser", "mcp", "--pool", "team-pool", "--tool", "codex"])}`);
});

test("pool launch without any member token wires nothing, even if the pool dir has one", () => {
  expect(browserMcpArgs("claude", "/pool", {}, "/bin/ais", { exists: (p) => p === "/pool/ais-browser-token", pool: poolOf(["/m/a"]) })).toEqual([]);
});

test("poolMemberConfigDirs skips disallowed and retired members", () => {
  const id = (name: string, extra: object = {}) => ({ name, configDir: `/m/${name}`, ...extra });
  const file: any = { identities: [id("a"), id("b", { retired: true }), id("c"), id("d")] };
  const pool: any = { name: "p", configDir: "/p", swapPool: { accounts: ["a", "b", "c"], disallowed: ["c"] } };
  expect(poolMemberConfigDirs(file, pool)).toEqual(["/m/a"]);
});
