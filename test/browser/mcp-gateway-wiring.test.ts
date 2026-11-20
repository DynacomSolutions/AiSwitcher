import { expect, test } from "bun:test";
import { MCP_TOKEN_ENV, claudeSessionIdFromArgv, gatewayMcpUrl, launchHeaders } from "../../src/browser/mcp-launch.ts";
import { LAUNCH_LABEL_WAIT_MS, launchSessionLabel } from "../../src/browser/session-label.ts";
import { browserLaunchWiring, browserMcpArgs } from "../../src/shared/browser-wiring.ts";

const TOKEN = "aisg_SYNTHETIC_FIXTURE_tok_abc";
const GW = "https://gw.example.test/gateway";
const SID = "0b3b1a52-3c1e-4f7e-9d54-3a0f6d2a9c11";
const yes = { exists: () => true };
const claudeCfg = (args: string[]) => JSON.parse(args[0]!.slice("--mcp-config=".length)).mcpServers["ais-browser"];

test("claude gets the http form: url, env-expanded bearer, session headers, no token in args", () => {
  const args = browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, identityName: "work", gateway: GW, http: { sessionId: SID, label: "Fix the login page" } });
  expect(args).toHaveLength(1);
  const cfg = claudeCfg(args);
  expect(cfg.type).toBe("http");
  expect(cfg.url).toBe("https://gw.example.test/gateway/browser/mcp");
  expect(cfg.command).toBeUndefined();
  expect(cfg.headers.Authorization).toBe(`Bearer \${${MCP_TOKEN_ENV}}`);
  expect(cfg.headers["X-AIS-Session-Id"]).toBe(SID);
  expect(decodeURIComponent(cfg.headers["X-AIS-Session-Label"])).toBe("Fix the login page");
  expect(cfg.headers["X-AIS-Pool"]).toBeUndefined();
  expect(args.join(" ")).not.toContain(TOKEN);
});

test("a pool launch sends the pool header", () => {
  const args = browserMcpArgs("claude", "/pool", {}, "/bin/ais", { exists: (p) => p === "/m/a/ais-browser-token", pool: { name: "team-pool", memberConfigDirs: ["/m/a"] }, gateway: GW, http: { label: "L" } });
  expect(claudeCfg(args).headers["X-AIS-Pool"]).toBe("team-pool");
});

test("codex args: url, bearer env var, http headers table, timeout, no session id, no token", () => {
  const args = browserMcpArgs("codex", "/c", undefined, "/bin/ais", { ...yes, identityName: "work", gateway: GW, http: { sessionId: SID, label: "Codex in app" } });
  expect(args.filter((a) => a === "-c")).toHaveLength(4);
  expect(args[1]).toBe('mcp_servers.ais-browser.url="https://gw.example.test/gateway/browser/mcp"');
  expect(args[3]).toBe(`mcp_servers.ais-browser.bearer_token_env_var="${MCP_TOKEN_ENV}"`);
  expect(args[5]).toStartWith("mcp_servers.ais-browser.http_headers={");
  expect(args[5]).toContain('"X-AIS-Session-Label"="Codex%20in%20app"');
  expect(args[5]).not.toContain("X-AIS-Session-Id");
  expect(args[7]).toBe("mcp_servers.ais-browser.tool_timeout_sec=135");
  expect(args.join(" ")).not.toContain(TOKEN);
});

test("http form needs no ais binary; the stdio form does; no gateway URL means stdio", () => {
  expect(browserMcpArgs("claude", "/c", {}, undefined, { ...yes, gateway: GW, http: {} })).toHaveLength(1);
  expect(browserMcpArgs("claude", "/c", {}, undefined, { ...yes })).toEqual([]);
  const stdio = browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, identityName: "work", http: {} });
  expect(claudeCfg(stdio).command).toBe("/bin/ais");
  expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", { exists: () => false, gateway: GW, http: {} })).toEqual([]);
  expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, gateway: GW, http: {}, firstArg: "mcp" })).toEqual([]);
});

const file: any = { version: 1, identities: [{ name: "work", label: "w", configDir: "/ids/work" }] };
const base = { toolName: "claude", configDirValue: "/ids/work", fromEnv: true, aisBinary: "/bin/ais", loadFile: async () => file, exists: () => true };

test("browserLaunchWiring: http with the token in env only; stdio without gateway URL or token", async () => {
  const h = await browserLaunchWiring({ ...base, gatewayUrl: GW, http: { label: "L" }, readToken: (d) => (d === "/ids/work" ? TOKEN : undefined) });
  expect(h.mode).toBe("http");
  expect(h.env).toEqual({ [MCP_TOKEN_ENV]: TOKEN });
  expect(h.args.join(" ")).not.toContain(TOKEN);
  expect(claudeCfg(h.args).type).toBe("http");
  const noGateway = await browserLaunchWiring({ ...base, http: {}, readToken: () => TOKEN });
  expect(noGateway.mode).toBe("stdio");
  expect(noGateway.env).toEqual({});
  expect(claudeCfg(noGateway.args).command).toBe("/bin/ais");
  const noToken = await browserLaunchWiring({ ...base, gatewayUrl: GW, http: {}, readToken: () => undefined });
  expect(noToken.mode).toBe("stdio");
  expect(noToken.env).toEqual({});
  const none = await browserLaunchWiring({ ...base, exists: () => false, gatewayUrl: GW, http: {}, readToken: () => TOKEN });
  expect(none.args).toEqual([]);
  expect(none.env).toEqual({});
});

test("the label function runs only when a token exists", async () => {
  let runs = 0;
  const label = async () => { runs++; return "Thread title"; };
  const noToken = await browserLaunchWiring({ ...base, gatewayUrl: GW, http: { label }, readToken: () => undefined });
  expect(noToken.mode).toBe("stdio");
  expect(runs).toBe(0);
  const withToken = await browserLaunchWiring({ ...base, gatewayUrl: GW, http: { label }, readToken: () => TOKEN });
  expect(runs).toBe(1);
  expect(decodeURIComponent(claudeCfg(withToken.args).headers["X-AIS-Session-Label"])).toBe("Thread title");
});

test("pool launch: the active member's token wins, else any allowed member's", async () => {
  const pool: any = {
    version: 1,
    identities: [
      { name: "a", label: "a", configDir: "/m/a" },
      { name: "b", label: "b", configDir: "/m/b" },
      { name: "team", label: "t", configDir: "/p", swapPool: { accounts: ["a", "b"], active: "b" } },
    ],
  };
  const input = { ...base, configDirValue: "/p", loadFile: async () => pool, gatewayUrl: GW, http: {} };
  const both = await browserLaunchWiring({ ...input, readToken: (d) => `tok-${d}` });
  expect(both.env[MCP_TOKEN_ENV]).toBe("tok-/m/b");
  const onlyA = await browserLaunchWiring({ ...input, readToken: (d) => (d === "/m/a" ? "tok-a" : undefined) });
  expect(onlyA.env[MCP_TOKEN_ENV]).toBe("tok-a");
  expect(claudeCfg(onlyA.args).headers["X-AIS-Pool"]).toBe("team");
});

test("launchHeaders sends only what it has and caps the label", () => {
  expect(launchHeaders({})).toEqual({});
  expect(decodeURIComponent(launchHeaders({ label: "x".repeat(300) })["X-AIS-Session-Label"]!)).toHaveLength(80);
  expect(gatewayMcpUrl("https://g.example.test///")).toBe("https://g.example.test/browser/mcp");
});

test("claudeSessionIdFromArgv reads --session-id and --resume UUIDs only", () => {
  expect(claudeSessionIdFromArgv(["--session-id", SID])).toBe(SID);
  expect(claudeSessionIdFromArgv([`--resume=${SID.toUpperCase()}`])).toBe(SID);
  expect(claudeSessionIdFromArgv(["--resume", "not-a-uuid"])).toBeUndefined();
  expect(claudeSessionIdFromArgv(["--", "--resume", SID])).toBeUndefined();
});

test("launch label: T3 title, else fallback; a slow lookup never delays the launch beyond the wait", async () => {
  expect(await launchSessionLabel({}, "claude", "/w/proj", () => "  My   thread ")).toBe("My thread");
  expect(await launchSessionLabel({}, "codex", "/w/proj", () => undefined)).toBe("Codex in proj");
  expect(await launchSessionLabel({}, "claude", "/w/proj", () => { throw new Error("db locked"); })).toBe("Claude in proj");
  const t0 = Date.now();
  const slow = await launchSessionLabel({}, "claude", "/w/proj", () => new Promise((r) => setTimeout(() => r("late"), 2_000)));
  expect(slow).toBe("Claude in proj");
  expect(Date.now() - t0).toBeLessThan(LAUNCH_LABEL_WAIT_MS + 300);
  expect(LAUNCH_LABEL_WAIT_MS).toBe(200);
});
