import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { runT3TelemetryCommand } from "../../src/cli/gateway/t3-telemetry.ts";
import { applyCodexTelemetryOff, codexTelemetryProblems, syncCodexTelemetry } from "../../src/identities/codex-telemetry.ts";
import { codexGatewayHomeProblem, configureCodexGatewayHome } from "../../src/identities/codex-gateway-home.ts";
import { composeT3ClaudeSettings, diffT3ClaudeHome, isAllowedEnvKey, missingTelemetryOff, TELEMETRY_OFF_ENV } from "../../src/identities/t3-claude-home.ts";
import { checkT3Proxy, checkT3Telemetry, installT3Telemetry, missingTelemetryKeys, T3_TELEMETRY_ENV, t3ProxyDoctorProblems, upsertServiceEnv, upsertTelemetryOff } from "../../src/identities/t3-anthropic-proxy.ts";
import { createT3TelemetryTicker } from "../../src/sync/t3-telemetry-ticker.ts";

const root = await mkdtemp(join(tmpdir(), "ais-t3tel-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let n = 0;
const fresh = async () => {
  const home = join(root, `h${n++}`);
  await mkdir(join(home, ".t3"), { recursive: true });
  return home;
};

test("service.env: keys are added, other lines and order stay, idempotent", () => {
  const before = "T3CODE_LAN=1\nNODE_OPTIONS=--max-old-space-size=512\n";
  const after = upsertTelemetryOff(before);
  expect(after.startsWith(before)).toBe(true);
  expect(missingTelemetryKeys(after)).toEqual([]);
  expect(upsertTelemetryOff(after)).toBe(after);
  for (const [k, v] of Object.entries(T3_TELEMETRY_ENV)) expect(after).toContain(`${k}=${v}`);
  expect(T3_TELEMETRY_ENV.T3CODE_TELEMETRY_ENABLED).toBe("false");
});

test("service.env: a wrong value is repaired in place and reported before", () => {
  const before = "DO_NOT_TRACK=0\nT3CODE_TELEMETRY_ENABLED=true\nA=1\n";
  expect(missingTelemetryKeys(before)).toContain("DO_NOT_TRACK=1");
  const after = upsertTelemetryOff(before);
  expect(after.split("\n").slice(0, 2)).toEqual(["DO_NOT_TRACK=1", "T3CODE_TELEMETRY_ENABLED=false"]);
  expect(missingTelemetryKeys(after)).toEqual([]);
});

test("proxy install also sets the telemetry keys", () => {
  const out = upsertServiceEnv("", { preloadPath: "/p.cjs", proxyUrl: "http://x:1", caPath: "/ca.pem" });
  expect(missingTelemetryKeys(out)).toEqual([]);
});

test("installT3Telemetry writes, backs up, and check/doctor report drift", async () => {
  const home = await fresh();
  expect((await checkT3Telemetry({ home, env: {} }))[0]).toMatch(/missing/);
  await writeFile(join(home, ".t3", "service.env"), "T3CODE_LAN=1\n");
  expect((await checkT3Telemetry({ home, env: {} }))[0]).toMatch(/T3CODE_TELEMETRY_ENABLED=false/);
  expect((await t3ProxyDoctorProblems({ home, env: {} })).join("\n")).toMatch(/does not turn telemetry off/);
  expect((await checkT3Proxy({ home, env: {} })).join("\n")).toMatch(/telemetry is not off/);
  const r = await installT3Telemetry({ home, env: {}, now: () => 5000 });
  expect(r.changed).toBe(true);
  expect(r.backup).toBeDefined();
  expect(await checkT3Telemetry({ home, env: {} })).toEqual([]);
  expect((await installT3Telemetry({ home, env: {} })).changed).toBe(false);
});

const CLAUDE_SOURCE = { env: { FOO: "1" }, theme: "dark" };

test("claude home: the opt-out keys are forced, also in a restricted home, and the source cannot turn them off", () => {
  const open = composeT3ClaudeSettings({ env: { DISABLE_TELEMETRY: "0" } }, {});
  expect(missingTelemetryOff(open.env)).toEqual([]);
  const restricted = composeT3ClaudeSettings(CLAUDE_SOURCE, {}, { noThirdParty: true });
  expect(restricted.env).toMatchObject(TELEMETRY_OFF_ENV);
  expect((restricted.env as Record<string, string>).FOO).toBe("1");
  expect((restricted.env as Record<string, string>).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
});

test("claude home: drift is reported when a key is missing and clean when present, restricted or not", async () => {
  for (const restricted of [false, true]) {
    const src = join(root, `src${restricted}`);
    const home = join(root, `home${restricted}`);
    await mkdir(src, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(src, "settings.json"), JSON.stringify(CLAUDE_SOURCE));
    const opts = { noThirdParty: restricted };
    const good = composeT3ClaudeSettings(CLAUDE_SOURCE, {}, opts);
    await writeFile(join(home, "settings.json"), JSON.stringify(good));
    expect((await diffT3ClaudeHome(home, src, opts)).filter((d) => d.startsWith("settings.json"))).toEqual([]);
    const env = { ...(good.env as Record<string, string>) };
    delete env.DO_NOT_TRACK;
    await writeFile(join(home, "settings.json"), JSON.stringify({ ...good, env }));
    expect((await diffT3ClaudeHome(home, src, opts)).join(" ")).toMatch(/settings\.json: env/);
  }
});

const CODEX = `model_provider = "gw"\n\n# keep me\n[model_providers.gw]\nbase_url = "https://gw.example/codex"\n\n[mcp_servers.x]\nurl = "https://x.example/mcp"\n`;

test("codex config: keys added, other content and comments kept, idempotent", () => {
  expect(codexTelemetryProblems(CODEX).sort()).toEqual(["analytics.enabled", "feedback.enabled", "otel.exporter", "otel.metrics_exporter", "otel.trace_exporter"]);
  const out = applyCodexTelemetryOff(CODEX);
  expect(out.startsWith(CODEX.trimEnd())).toBe(true);
  expect(out).toContain("# keep me");
  expect(codexTelemetryProblems(out)).toEqual([]);
  expect(applyCodexTelemetryOff(out)).toBe(out);
  const t = parseToml(out) as Record<string, Record<string, unknown>>;
  expect(t.analytics).toEqual({ enabled: false });
  expect(t.otel).toEqual({ exporter: "none", trace_exporter: "none", metrics_exporter: "none" });
  expect(t.model_providers?.gw).toBeDefined();
});

test("codex config: existing tables with other keys and wrong values are repaired in place", () => {
  const text = `[analytics]\nenabled = true\nextra = 1\n\n[otel]\nexporter = "otlp"\nenvironment = "prod"\n`;
  const out = applyCodexTelemetryOff(text);
  const t = parseToml(out) as Record<string, Record<string, unknown>>;
  expect(t.analytics).toEqual({ enabled: false, extra: 1 });
  expect(t.otel).toEqual({ exporter: "none", environment: "prod", trace_exporter: "none", metrics_exporter: "none" });
  expect(t.feedback).toEqual({ enabled: false });
});

test("codex config: an inline table that cannot be edited line by line throws", () => {
  expect(() => applyCodexTelemetryOff(`analytics = { enabled = true }\n`)).toThrow(/cannot set/);
});

test("syncCodexTelemetry: check reports, repair writes, mode kept, no config.toml is never created", async () => {
  const home = await fresh();
  const gw = join(home, ".t3", "gateway");
  for (const d of ["t3-codex-a", "codex-pool", "t3-codex-empty", "t3-claude-x"]) await mkdir(join(gw, d), { recursive: true });
  await writeFile(join(gw, "t3-codex-a", "config.toml"), CODEX, { mode: 0o600 });
  await writeFile(join(gw, "codex-pool", "config.toml"), CODEX);
  await writeFile(join(gw, "t3-claude-x", "config.toml"), CODEX);
  const opts = { home, env: {}, identityDirs: [] };
  const drift = await syncCodexTelemetry({ ...opts, check: true });
  expect(drift.map((r) => [r.dir.split("/").pop(), r.status])).toEqual([["codex-pool", "drift"], ["t3-codex-a", "drift"]]);
  expect(await readFile(join(gw, "t3-codex-a", "config.toml"), "utf8")).toBe(CODEX);
  expect((await syncCodexTelemetry(opts)).map((r) => r.status)).toEqual(["updated", "updated"]);
  expect((await syncCodexTelemetry(opts)).map((r) => r.status)).toEqual(["current", "current"]);
  expect(codexTelemetryProblems(await readFile(join(gw, "t3-codex-a", "config.toml"), "utf8"))).toEqual([]);
  expect(await readFile(join(gw, "t3-claude-x", "config.toml"), "utf8")).toBe(CODEX);
  await expect(readFile(join(gw, "t3-codex-empty", "config.toml"))).rejects.toThrow();
});

test("gateway codex home: configure sets the keys and the check flags a home without them", async () => {
  const dir = join(root, "gwhome");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.toml"), `model_provider = "ais-gateway"\n[model_providers.ais-gateway]\nbase_url = "https://gw.example.com/gateway/t3-demo"\nwire_api = "responses"\n`);
  await configureCodexGatewayHome(dir, "SYNTHETIC_FIXTURE-token");
  expect(await codexGatewayHomeProblem(dir)).toBeUndefined();
  const cfg = await readFile(join(dir, "config.toml"), "utf8");
  await writeFile(join(dir, "config.toml"), cfg.replace("enabled = false", "enabled = true"));
  expect(await codexGatewayHomeProblem(dir)).toMatch(/telemetry/);
});

test("ais gateway t3-telemetry: check fails on drift, apply repairs service.env and Codex homes", async () => {
  const home = await fresh();
  const gw = join(home, ".t3", "gateway", "t3-codex-a");
  await mkdir(gw, { recursive: true });
  await writeFile(join(gw, "config.toml"), CODEX);
  await writeFile(join(home, ".t3", "service.env"), "T3CODE_LAN=1\n");
  const lines: string[] = [];
  const deps = { out: (l: string) => lines.push(l) } as never;
  await expect(runT3TelemetryCommand([], { check: true }, deps, { home, env: {} })).rejects.toThrow(/not off/);
  await runT3TelemetryCommand([], {}, deps, { home, env: {} });
  await runT3TelemetryCommand([], { check: true }, deps, { home, env: {} });
  expect(lines.join("\n")).toContain("Restart T3 Code");
});

test("ticker: repairs Codex homes, logs a service.env problem once per change", async () => {
  const logs: string[] = [];
  let t = 0;
  let env = ["bad"];
  const ticker = createT3TelemetryTicker({ codex: async () => [{ dir: "/c", status: "updated", changes: ["analytics.enabled"] }], serviceEnv: async () => env, now: () => t, log: (m) => logs.push(m), intervalMs: 10 });
  await ticker.tick();
  await ticker.idle();
  t = 20;
  await ticker.tick();
  await ticker.idle();
  expect(logs.length).toBe(2);
  env = [];
  t = 40;
  await ticker.tick();
  await ticker.idle();
  expect(logs.length).toBe(2);
});

const parsedWithout = (text: string) => {
  const t = parseToml(text) as Record<string, Record<string, unknown>>;
  for (const [k, keys] of Object.entries({ analytics: ["enabled"], feedback: ["enabled"], otel: ["exporter", "trace_exporter", "metrics_exporter"] })) {
    for (const key of keys) delete t[k]?.[key];
    if (t[k] && Object.keys(t[k]!).length === 0) delete t[k];
  }
  return t;
};

test("codex config: awkward shapes keep every other key", () => {
  const cases: Record<string, string> = {
    dotted: `analytics.enabled = true\nfeedback.enabled = true\nname = "x"\n`,
    crlf: `name = "x"\r\n[analytics]\r\nenabled = true\r\n`,
    noNewline: `name = "x"\n[otel]\nexporter = "otlp"`,
    arrays: `[[hooks]]\nname = "a"\n[[hooks]]\nname = "b"\n[analytics]\nenabled = true\n`,
    quoted: `["analytics"]\n"enabled" = true\n[ "mcp_servers" . "a b" ]\nurl = "u"\n`,
    otelTable: `[otel]\nenvironment = "prod"\n[otel.exporter_extra]\nx = 1\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    let out: string;
    try {
      out = applyCodexTelemetryOff(text);
    } catch (e) {
      expect(String(e)).toMatch(/cannot set|refused|not valid/); // refusing is also safe
      continue;
    }
    expect(codexTelemetryProblems(out), name).toEqual([]);
    expect(parsedWithout(out), name).toEqual(parsedWithout(text));
  }
});

test("codex config: top-level dotted otel.exporter and [otel.exporter.*] subtables are refused", () => {
  expect(() => applyCodexTelemetryOff(`otel.exporter = "otlp"\n`)).toThrow();
  expect(() => applyCodexTelemetryOff(`[otel.exporter."otlp-http"]\nendpoint = "https://x"\n`)).toThrow();
});

test("codex config: a header line inside a multi-line string is refused when the edit would lose keys", () => {
  const text = `[mcp_servers.docs]\nnote = """\n[analytics]\n"""\nenabled = false\n`;
  expect(() => applyCodexTelemetryOff(text)).toThrow(/other keys|cannot set/);
  const unchanged = `[mcp_servers.docs]\nnote = """\n[analytics]\nenabled = true\n"""\n`;
  expect(() => applyCodexTelemetryOff(unchanged)).toThrow(); // refused, never a silent wrong edit
});

test("codex config: invalid TOML is refused", () => {
  expect(() => applyCodexTelemetryOff(`a = = 1\n`)).toThrow(/not valid TOML/);
});

test("syncCodexTelemetry: a refused edit leaves the file, backs up a good edit, and continues", async () => {
  const home = await fresh();
  const gw = join(home, ".t3", "gateway");
  const bad = `[mcp_servers.docs]\nnote = """\n[analytics]\n"""\nenabled = false\n`;
  await mkdir(join(gw, "codex-pool-a"), { recursive: true });
  await mkdir(join(gw, "codex-pool-b"), { recursive: true });
  await writeFile(join(gw, "codex-pool-a", "config.toml"), bad);
  await writeFile(join(gw, "codex-pool-b", "config.toml"), CODEX);
  const opts = { home, env: {}, identityDirs: [] };
  const res = await syncCodexTelemetry(opts);
  expect(res.map((r) => r.status)).toEqual(["failed", "updated"]);
  expect(await readFile(join(gw, "codex-pool-a", "config.toml"), "utf8")).toBe(bad);
  expect((await readdir(join(gw, "codex-pool-a"))).sort()).toEqual(["config.toml"]);
  const filesB = await readdir(join(gw, "codex-pool-b"));
  expect(filesB.some((f) => f.startsWith("config.toml.pre-telemetry-off."))).toBe(true);
  expect(filesB.some((f) => f.includes(".tmp-"))).toBe(false);
  const backup = filesB.find((f) => f.startsWith("config.toml.pre-telemetry-off."))!;
  expect(await readFile(join(gw, "codex-pool-b", backup), "utf8")).toBe(CODEX);
  const check = await syncCodexTelemetry({ ...opts, check: true });
  expect(check.map((r) => r.status)).toEqual(["drift", "current"]);
});

test("gateway codex home: configure warns and still writes the gateway config when the telemetry edit is refused", async () => {
  const dir = join(root, "gwhome-refused");
  await mkdir(dir, { recursive: true });
  const base = `model_provider = "ais-gateway"\n[model_providers.ais-gateway]\nbase_url = "https://gw.example.com/gateway/t3-demo"\nwire_api = "responses"\n`;
  await writeFile(join(dir, "config.toml"), `${base}[otel.exporter."otlp-http"]\nendpoint = "https://x"\n`);
  const warn = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await configureCodexGatewayHome(dir, "SYNTHETIC_FIXTURE-token");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
  expect(await readFile(join(dir, "auth.json"), "utf8")).toContain("ais-t3-demo");
  expect(await readFile(join(dir, "config.toml"), "utf8")).toContain("chatgpt_base_url");
  expect(await codexGatewayHomeProblem(dir)).toMatch(/telemetry/);
});

test("ais gateway t3-telemetry: a forbidden proxy key in service.env still repairs the Codex homes, then fails", async () => {
  const home = await fresh();
  const gw = join(home, ".t3", "gateway", "t3-codex-a");
  await mkdir(gw, { recursive: true });
  await writeFile(join(gw, "config.toml"), CODEX);
  await writeFile(join(home, ".t3", "service.env"), "HTTPS_PROXY=http://x:1\n");
  const lines: string[] = [];
  const deps = { out: (l: string) => lines.push(l) } as never;
  await expect(runT3TelemetryCommand([], {}, deps, { home, env: {} })).rejects.toThrow(/service\.env failed/);
  expect(codexTelemetryProblems(await readFile(join(gw, "config.toml"), "utf8"))).toEqual([]);
});

test("ais gateway t3-telemetry: a refused Codex home does not stop the others and exits non-zero", async () => {
  const home = await fresh();
  const a = join(home, ".t3", "gateway", "t3-codex-a");
  const b = join(home, ".t3", "gateway", "t3-codex-b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(join(a, "config.toml"), `[otel.exporter."otlp-http"]\nendpoint = "https://x"\n`);
  await writeFile(join(b, "config.toml"), CODEX);
  await writeFile(join(home, ".t3", "service.env"), "T3CODE_LAN=1\n");
  const deps = { out: () => undefined } as never;
  await expect(runT3TelemetryCommand([], {}, deps, { home, env: {} })).rejects.toThrow(/Codex home failed/);
  expect(codexTelemetryProblems(await readFile(join(b, "config.toml"), "utf8"))).toEqual([]);
  await expect(runT3TelemetryCommand([], { check: true }, deps, { home, env: {} })).rejects.toThrow(/not off/);
});

test("ticker: a failed Codex home is logged and the other homes are still reported", async () => {
  const logs: string[] = [];
  const ticker = createT3TelemetryTicker({ codex: async () => [{ dir: "/a", status: "failed", changes: [], error: "refused" }, { dir: "/b", status: "updated", changes: ["analytics.enabled"] }], serviceEnv: async () => [], now: () => 0, log: (m) => logs.push(m), intervalMs: 10 });
  await ticker.tick();
  await ticker.idle();
  expect(logs.join("\n")).toMatch(/\/a: failed refused/);
  expect(logs.join("\n")).toMatch(/\/b: updated/);
});

test("service.env: the last copy of a duplicate key wins", () => {
  expect(missingTelemetryKeys("DO_NOT_TRACK=0\nDO_NOT_TRACK=1\n")).not.toContain("DO_NOT_TRACK=1");
  expect(missingTelemetryKeys("DO_NOT_TRACK=1\nDO_NOT_TRACK=0\n")).toContain("DO_NOT_TRACK=1");
});

test("claude home: built-in object key names are not exempt from the third-party filter", () => {
  expect(isAllowedEnvKey("toString")).toBe(false);
  expect(isAllowedEnvKey("constructor")).toBe(false);
  expect(isAllowedEnvKey("DISABLE_TELEMETRY")).toBe(true);
  const env = JSON.parse('{"toString":"jev.example","constructor":"typesafe","FOO":"1"}') as Record<string, string>;
  const out = composeT3ClaudeSettings({ env }, {}, { noThirdParty: true });
  const e = out.env as Record<string, string>;
  expect(Object.hasOwn(e, "toString")).toBe(false);
  expect(Object.hasOwn(e, "constructor")).toBe(false);
  expect(e.FOO).toBe("1");
});
