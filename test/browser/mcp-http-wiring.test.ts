import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_KEY_ENV, ensureMcpDaemonStarted, mcpUnitInstalled } from "../../src/browser/mcp-http-config.ts";
import { browserLaunchWiring, browserMcpArgs, type HttpWiring } from "../../src/shared/browser-wiring.ts";
import { BROWSER_MCP_UNIT, browserMcpServiceStatus, installBrowserMcpService, uninstallBrowserMcpService } from "../../src/cli/browser/mcp-service.ts";
import { runBrowserWiring } from "../../src/cli/browser/wiring.ts";
import type { Ctl } from "../../src/cli/gateway/local-service.ts";

const KEY = "c".repeat(64);
const yes = { exists: () => true };
const http: HttpWiring = { port: 47150, ownerPid: 4242, cwd: "/w/proj", home: "/h/.claude", sessionId: "0b3b1a52-3c1e-4f7e-9d54-3a0f6d2a9c11", t3Thread: "thr-1", t3Home: "/t3" };

test("claude gets the http form with env-expanded auth, session headers and no key in args", () => {
  const args = browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, identityName: "work", gateway: "https://gw.test", http });
  expect(args).toHaveLength(1);
  const cfg = JSON.parse(args[0]!.slice("--mcp-config=".length)).mcpServers["ais-browser"];
  expect(cfg.type).toBe("http");
  expect(cfg.url).toBe("http://127.0.0.1:47150/mcp");
  expect(cfg.command).toBeUndefined();
  expect(cfg.headers.Authorization).toBe(`Bearer \${${MCP_KEY_ENV}}`);
  expect(cfg.headers).toMatchObject({ "X-AIS-Tool": "claude", "X-AIS-Identity": "work", "X-AIS-Config-Dir": "%2Fc", "X-AIS-Session-Id": http.sessionId, "X-AIS-T3-Thread": "thr-1", "X-AIS-Owner-Pid": "4242", "X-AIS-Cwd": "%2Fw%2Fproj" });
  expect(args.join(" ")).not.toContain(KEY);
});

test("a pool launch sends the pool header and no config dir", () => {
  const args = browserMcpArgs("claude", "/pool", {}, "/bin/ais", { exists: (p) => p === "/m/a/ais-browser-token", pool: { name: "team-pool", memberConfigDirs: ["/m/a"] }, http });
  const h = JSON.parse(args[0]!.slice("--mcp-config=".length)).mcpServers["ais-browser"].headers;
  expect(h["X-AIS-Pool"]).toBe("team-pool");
  expect(h["X-AIS-Config-Dir"]).toBeUndefined();
});

test("codex args: url, bearer env var, http headers table, timeout, and no key", () => {
  const args = browserMcpArgs("codex", "/c", undefined, "/bin/ais", { ...yes, identityName: "work", http: { ...http, home: "/h/.codex" } });
  expect(args.filter((a) => a === "-c")).toHaveLength(4);
  expect(args[1]).toBe('mcp_servers.ais-browser.url="http://127.0.0.1:47150/mcp"');
  expect(args[3]).toBe(`mcp_servers.ais-browser.bearer_token_env_var="${MCP_KEY_ENV}"`);
  expect(args[5]).toStartWith('mcp_servers.ais-browser.http_headers={"X-AIS-Tool"="codex"');
  expect(args[5]).toContain('"X-AIS-Owner-Pid"="4242"');
  expect(args[5]).not.toContain("X-AIS-Session-Id");
  expect(args[7]).toBe("mcp_servers.ais-browser.tool_timeout_sec=135");
  expect(args.join(" ")).not.toContain(KEY);
});

test("without http wiring the stdio form is unchanged; http wiring still needs a token and an ais binary", () => {
  const stdio = browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, identityName: "work" });
  expect(JSON.parse(stdio[0]!.slice("--mcp-config=".length)).mcpServers["ais-browser"].command).toBe("/bin/ais");
  expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", { exists: () => false, http })).toEqual([]);
  expect(browserMcpArgs("claude", "/c", {}, undefined, { ...yes, http })).toEqual([]);
  expect(browserMcpArgs("claude", "/c", {}, "/bin/ais", { ...yes, http, firstArg: "mcp" })).toEqual([]);
});

test("browserLaunchWiring: http when asked, key only in env; stdio and empty env otherwise", async () => {
  const file: any = { version: 1, identities: [{ name: "work", label: "w", configDir: "/ids/work" }] };
  const input = { toolName: "claude", configDirValue: "/ids/work", fromEnv: true, aisBinary: "/bin/ais", loadFile: async () => file, exists: () => true };
  const h = await browserLaunchWiring({ ...input, http: { port: 47150, ownerPid: 9, key: KEY } });
  expect(h.env).toEqual({ [MCP_KEY_ENV]: KEY });
  expect(h.args.join(" ")).not.toContain(KEY);
  expect(JSON.parse(h.args[0]!.slice("--mcp-config=".length)).mcpServers["ais-browser"].type).toBe("http");
  const s = await browserLaunchWiring(input);
  expect(s.env).toEqual({});
  expect(JSON.parse(s.args[0]!.slice("--mcp-config=".length)).mcpServers["ais-browser"].command).toBe("/bin/ais");
  const none = await browserLaunchWiring({ ...input, exists: () => false, http: { port: 47150, ownerPid: 9, key: KEY } });
  expect(none.args).toEqual([]);
  expect(none.env).toEqual({});
});

test("mcpUnitInstalled is true only on Linux with the unit file", () => {
  expect(mcpUnitInstalled(() => true, "linux", "/u")).toBe(true);
  expect(mcpUnitInstalled(() => false, "linux", "/u")).toBe(false);
  expect(mcpUnitInstalled(() => true, "darwin", "/u")).toBe(false);
});

test("auto start: a listening port starts nothing; a silent port starts the unit once, without waiting for it", async () => {
  let started = 0;
  expect(await ensureMcpDaemonStarted(1, { answers: async () => true, start: () => { started++; } })).toBe(true);
  expect(started).toBe(0);
  expect(await ensureMcpDaemonStarted(1, { answers: async () => false, start: () => { started++; } })).toBe(false);
  expect(started).toBe(1);
  expect(await ensureMcpDaemonStarted(1, { answers: async () => false, start: () => { throw new Error("no systemctl"); } })).toBe(false);
});

function fakeCtl(initial: { active?: boolean; noManager?: boolean } = {}) {
  const calls: string[] = [];
  let active = initial.active ?? false;
  const ctl: Ctl = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "show-environment") return { code: initial.noManager ? 1 : 0, out: "" };
    if (args[0] === "is-active") return { code: active ? 0 : 3, out: active ? "active" : "inactive" };
    if (args[0] === "start" || args[0] === "restart") active = true;
    return { code: 0, out: "" };
  };
  return { ctl, calls };
}

async function withDirs(fn: (d: { unitDirectory: string; keyDir: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ais-mcp-svc-"));
  try {
    await fn({ unitDirectory: join(root, "units"), keyDir: join(root, "key") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("unit text: shared limits, restart policy and port-ready check", () => {
  expect(BROWSER_MCP_UNIT).toContain("ExecStart=%h/.local/bin/ais browser mcp-serve");
  for (const line of ["Restart=always", "RestartSec=1s", "MemoryHigh=512M", "MemoryMax=1G", "WantedBy=default.target", "ExecStartPost="]) expect(BROWSER_MCP_UNIT).toContain(line);
  expect(BROWSER_MCP_UNIT).toContain("${AIS_BROWSER_MCP_PORT:-47150}");
});

test("install writes the unit and the key, enables and starts; a second install is unchanged; a changed binary restarts", async () => {
  await withDirs(async (d) => {
    const f = fakeCtl();
    const waits: number[] = [];
    const opts = { ...d, ctl: f.ctl, platform: "linux" as const, waitListening: async (p: number) => { waits.push(p); }, log: () => {} };
    expect((await installBrowserMcpService(opts)).action).toBe("started");
    expect(await readFile(join(d.unitDirectory, "ais-browser-mcp.service"), "utf8")).toBe(BROWSER_MCP_UNIT);
    expect((await stat(join(d.keyDir, "key"))).mode & 0o777).toBe(0o600);
    expect(f.calls).toContain("enable ais-browser-mcp.service");
    expect(f.calls).toContain("start ais-browser-mcp.service");
    expect((await installBrowserMcpService(opts)).action).toBe("unchanged");
    expect((await installBrowserMcpService({ ...opts, restartIfActive: true })).action).toBe("restarted");
    expect(f.calls).toContain("restart ais-browser-mcp.service");
    expect(waits).toHaveLength(2);
  });
});

test("respectDisabled leaves a stopped unit alone; no systemd user manager and non-Linux install nothing", async () => {
  await withDirs(async (d) => {
    const f = fakeCtl();
    const opts = { ...d, ctl: f.ctl, platform: "linux" as const, waitListening: async () => {}, log: () => {} };
    await installBrowserMcpService(opts);
    const stopped = fakeCtl({ active: false });
    expect((await installBrowserMcpService({ ...opts, ctl: stopped.ctl, respectDisabled: true })).action).toBe("left-alone");
    expect(stopped.calls.some((c) => c.startsWith("start"))).toBe(false);
  });
  await withDirs(async (d) => {
    await expect(installBrowserMcpService({ ...d, ctl: fakeCtl({ noManager: true }).ctl, platform: "linux" })).rejects.toThrow("no systemd user manager");
    expect(await stat(join(d.unitDirectory, "ais-browser-mcp.service")).then(() => true, () => false)).toBe(false);
    await expect(installBrowserMcpService({ ...d, platform: "darwin" })).rejects.toThrow("Linux only");
  });
});

test("uninstall removes the unit; status reports installed state and the daemon", async () => {
  await withDirs(async (d) => {
    const f = fakeCtl();
    const opts = { ...d, ctl: f.ctl, platform: "linux" as const, waitListening: async () => {}, log: () => {} };
    expect((await browserMcpServiceStatus({ ...opts, fetch: (async () => new Response("{}", { status: 200 })) as any })).installed).toBe(false);
    await installBrowserMcpService(opts);
    const st = await browserMcpServiceStatus({ ...opts, fetch: (async () => new Response("{}", { status: 200 })) as any });
    expect(st).toMatchObject({ installed: true, unit: "active", answering: true });
    expect(await uninstallBrowserMcpService(opts)).toEqual({ removed: true });
    expect(f.calls).toContain("disable --now ais-browser-mcp.service");
    expect((await browserMcpServiceStatus({ ...opts, fetch: (async () => { throw new Error("down"); }) as any })).installed).toBe(false);
  });
});

test("ais browser wiring shows the mode and whether the daemon answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-mcp-wiring-"));
  try {
    const t3 = join(root, "t3");
    await mkdir(join(t3, "userdata"), { recursive: true });
    const folder = join(root, "ids", "work");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "ais-browser-token"), "tok");
    await writeFile(join(t3, "userdata", "settings.json"), JSON.stringify({ providerInstances: { a: { driver: "claudeAgent", config: { homePath: folder } } } }));
    const reg = join(root, "identities.json");
    await writeFile(reg, JSON.stringify({ version: 1, identities: [{ name: "work", label: "w", configDir: folder }] }));
    const deps = { t3Home: t3, aisBinary: "/bin/ais", registryPath: () => reg };
    const lines: string[] = [];
    await runBrowserWiring({}, { ...deps, serviceInstalled: () => true, daemonHealthy: async () => true, out: (l) => lines.push(l) });
    expect(lines[0]).toContain("mode: http");
    expect(lines[0]).toContain("answering");
    expect(lines[1]).toContain("wired");
    const down: string[] = [];
    await runBrowserWiring({}, { ...deps, serviceInstalled: () => true, daemonHealthy: async () => false, out: (l) => down.push(l) });
    expect(down[0]).toContain("NOT answering");
    const stdio: string[] = [];
    await runBrowserWiring({}, { ...deps, serviceInstalled: () => false, out: (l) => stdio.push(l) });
    expect(stdio[0]).toContain("mode: stdio");
    const json: string[] = [];
    await runBrowserWiring({ json: true }, { ...deps, serviceInstalled: () => true, daemonHealthy: async () => true, out: (l) => json.push(l) });
    expect(JSON.parse(json[0]!)[0]).toMatchObject({ mode: "http", daemonAnswering: true, wired: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
