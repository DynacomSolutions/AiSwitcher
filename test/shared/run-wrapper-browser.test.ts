import { expect, test } from "bun:test";
import { browserMcpArgs } from "../../src/shared/browser-wiring.ts";

const yes = () => true;
const no = () => false;

test("claude gets a single-token --mcp-config without strict", () => {
  const args = browserMcpArgs("claude", "/c", { }, "/bin/ais", yes);
  expect(args.length).toBe(1);
  expect(args[0]!.startsWith("--mcp-config=")).toBe(true);
  expect(JSON.parse(args[0]!.slice("--mcp-config=".length))).toEqual({ mcpServers: { "ais-browser": { command: "/bin/ais", args: ["browser", "mcp"] } } });
});

test("codex gets -c overrides", () => {
  expect(browserMcpArgs("codex", "/c", undefined, "/bin/ais", yes)).toEqual(["-c", 'mcp_servers.ais-browser.command="/bin/ais"', "-c", 'mcp_servers.ais-browser.args=["browser","mcp"]']);
});

test("nothing without token file, for retired identities or other tools", () => {
  expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", no)).toEqual([]);
  expect(browserMcpArgs("codex", "/c", { retired: true }, "/bin/ais", yes)).toEqual([]);
  expect(browserMcpArgs("kimi", "/c", {}, "/bin/ais", yes)).toEqual([]);
});
