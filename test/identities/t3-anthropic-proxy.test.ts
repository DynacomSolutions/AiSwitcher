import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runT3ProxyCommand } from "../../src/cli/gateway/t3-proxy.ts";
import {
  PRELOAD_SOURCE,
  checkT3Proxy,
  installT3Proxy,
  proxyFromT3Folders,
  removeFromServiceEnv,
  t3Paths,
  t3ProxyDoctorProblems,
  upsertServiceEnv,
} from "../../src/identities/t3-anthropic-proxy.ts";

const root = await mkdtemp(join(tmpdir(), "ais-t3proxy-"));
afterAll(() => rm(root, { recursive: true, force: true }));

let n = 0;
async function scratch(serviceEnv?: string): Promise<{ home: string; opts: { home: string; env: Record<string, string> }; envFile: string }> {
  const home = join(root, `h${n++}`);
  await mkdir(join(home, ".t3"), { recursive: true });
  const envFile = join(home, ".t3", "service.env");
  if (serviceEnv !== undefined) await writeFile(envFile, serviceEnv);
  return { home, opts: { home, env: {} }, envFile };
}

const input = { preloadPath: "/h/.ais/t3/anthropic-proxy.cjs", proxyUrl: "https://proxy.example.test:47132", caPath: "/h/.ais/ca.pem" };

test("upsert keeps other lines and order, appends the keys", () => {
  const out = upsertServiceEnv("T3CODE_LAN=1\n# note\nOTHER=x\n", input);
  expect(out).toBe(
    `T3CODE_LAN=1\n# note\nOTHER=x\nNODE_OPTIONS=--require ${input.preloadPath}\nAIS_T3_ANTHROPIC_PROXY=${input.proxyUrl}\nNODE_EXTRA_CA_CERTS=${input.caPath}\n`,
  );
});

test("upsert merges NODE_OPTIONS flags, adds --require once, replaces values in place, is idempotent", () => {
  const start = `A=1\nNODE_OPTIONS=--max-old-space-size=4096\nAIS_T3_ANTHROPIC_PROXY=old\nB=2\n`;
  const once = upsertServiceEnv(start, input);
  expect(once).toContain(`NODE_OPTIONS=--max-old-space-size=4096 --require ${input.preloadPath}\n`);
  expect(once.split("\n").slice(0, 4)).toEqual(["A=1", `NODE_OPTIONS=--max-old-space-size=4096 --require ${input.preloadPath}`, `AIS_T3_ANTHROPIC_PROXY=${input.proxyUrl}`, "B=2"]);
  expect(upsertServiceEnv(once, input)).toBe(once);
  expect(once.split(input.preloadPath).length - 1).toBe(1);
});

test("upsert refuses HTTPS_PROXY, HTTP_PROXY and ALL_PROXY in any case, naming it", () => {
  for (const name of ["HTTPS_PROXY", "http_proxy", "All_Proxy"]) {
    expect(() => upsertServiceEnv(`X=1\n${name}=http://p\n`, input)).toThrow(name);
  }
  expect(() => upsertServiceEnv(`export HTTPS_PROXY="http://p"\n`, input)).toThrow("HTTPS_PROXY");
});

test("install writes the preload 0644, backs up the old service.env, keeps lines, and a second run changes nothing", async () => {
  const s = await scratch("T3CODE_LAN=1\n");
  const r = await installT3Proxy({ ...s.opts, ...input, now: () => 1_700_000_123_999 });
  const paths = t3Paths(s.opts);
  expect(await readFile(paths.preload, "utf8")).toBe(PRELOAD_SOURCE);
  expect((await stat(paths.preload)).mode & 0o777).toBe(0o644);
  expect(r.backup).toBe(join(paths.backupsDir, "service.env.pre-anthropic-proxy.1700000123"));
  expect(await readFile(r.backup!, "utf8")).toBe("T3CODE_LAN=1\n");
  const text = await readFile(s.envFile, "utf8");
  expect(text.startsWith("T3CODE_LAN=1\n")).toBe(true);
  expect(text).toContain(`NODE_OPTIONS=--require ${paths.preload}`);
  const again = await installT3Proxy({ ...s.opts, ...input, now: () => 1_700_000_999_000 });
  expect(again.changed).toBe(false);
  expect(again.backup).toBeUndefined();
  expect(await readFile(s.envFile, "utf8")).toBe(text);
  expect(await readdir(paths.backupsDir)).toHaveLength(1);
});

test("install refuses a service.env with a forbidden proxy variable and writes nothing", async () => {
  const s = await scratch("HTTPS_PROXY=http://p\n");
  await expect(installT3Proxy({ ...s.opts, ...input })).rejects.toThrow("HTTPS_PROXY");
  expect(await readFile(s.envFile, "utf8")).toBe("HTTPS_PROXY=http://p\n");
  await expect(stat(t3Paths(s.opts).preload)).rejects.toThrow();
});

test("T3CODE_HOME moves service.env and backups, the preload stays under the ais home", () => {
  const p = t3Paths({ home: "/h", env: { T3CODE_HOME: "/data/t3" } });
  expect(p.serviceEnv).toBe("/data/t3/service.env");
  expect(p.backupsDir).toBe("/data/t3/backups");
  expect(p.preload).toBe("/h/.ais/t3/anthropic-proxy.cjs");
});

test("check reports each problem and writes nothing; remove undoes only ours", async () => {
  const s = await scratch("T3CODE_LAN=1\n");
  expect((await checkT3Proxy(s.opts)).join("\n")).toContain("missing keys");
  await installT3Proxy({ ...s.opts, ...input });
  expect(await checkT3Proxy(s.opts)).toEqual([]);

  await writeFile(t3Paths(s.opts).preload, "// old\n");
  expect((await checkT3Proxy(s.opts)).join("\n")).toContain("preload out of date");
  expect((await t3ProxyDoctorProblems(s.opts)).join("\n")).toContain("out of date");

  const before = await readFile(s.envFile, "utf8");
  await writeFile(s.envFile, `${before}https_proxy=http://p\n`);
  expect((await checkT3Proxy(s.opts)).join("\n")).toContain("https_proxy");
  expect((await t3ProxyDoctorProblems(s.opts)).join("\n")).toContain("https_proxy");

  await writeFile(s.envFile, `NODE_OPTIONS=--trace-warnings --require ${t3Paths(s.opts).preload}\nT3CODE_LAN=1\nAIS_T3_ANTHROPIC_PROXY=u\nNODE_EXTRA_CA_CERTS=/c\n`);
  const r = await installT3Proxy({ ...s.opts, ...input });
  expect(r.changed).toBe(true);
  const removed = await import("../../src/identities/t3-anthropic-proxy.ts").then((m) => m.removeT3Proxy(s.opts));
  expect(removed.changed).toBe(true);
  expect(await readFile(s.envFile, "utf8")).toBe("NODE_OPTIONS=--trace-warnings\nT3CODE_LAN=1\n");
  await expect(stat(t3Paths(s.opts).preload)).rejects.toThrow();
});

test("removeFromServiceEnv drops the NODE_OPTIONS line when only our --require was in it", () => {
  const text = upsertServiceEnv("K=1\n", input);
  expect(removeFromServiceEnv(text, input.preloadPath)).toBe("K=1\n");
});

test("CLI: install, --check exit and --remove, with proxy from a T3 gateway folder", async () => {
  const s = await scratch("T3CODE_LAN=1\n");
  await mkdir(join(s.home, ".t3", "gateway", "t3-claude-a"), { recursive: true });
  await writeFile(join(s.home, ".t3", "gateway", "t3-claude-a", "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "https://folder.example.test:1" } }));
  expect(await proxyFromT3Folders(s.opts)).toBe("https://folder.example.test:1");
  const lines: string[] = [];
  const deps = { out: (l: string) => lines.push(l), secretsPath: join(s.home, "no-secrets") } as never;
  const saved = process.env.AIS_GATEWAY_CONNECT_PROXY_URL;
  delete process.env.AIS_GATEWAY_CONNECT_PROXY_URL;
  try {
    await expect(runT3ProxyCommand([], { check: true }, deps, s.opts)).rejects.toThrow("problem");
    await runT3ProxyCommand([], { ca: "/tmp/ca.pem" }, deps, s.opts);
    expect(await readFile(s.envFile, "utf8")).toContain("AIS_T3_ANTHROPIC_PROXY=https://folder.example.test:1");
    expect(lines.join("\n")).toContain("Restart T3 Code");
    await runT3ProxyCommand([], { check: true }, deps, s.opts);
    await runT3ProxyCommand([], { remove: true }, deps, s.opts);
    expect(await readFile(s.envFile, "utf8")).toBe("T3CODE_LAN=1\n");
  } finally {
    if (saved !== undefined) process.env.AIS_GATEWAY_CONNECT_PROXY_URL = saved;
  }
});

test("preload under plain node leaves fetch untouched and exports the decision", async () => {
  const s = await scratch();
  await installT3Proxy({ ...s.opts, ...input });
  const file = t3Paths(s.opts).preload;
  const p = Bun.spawnSync(
    ["node", "--require", file, "-e", "const f=globalThis.fetch;const k=require(process.argv[1]);console.log(JSON.stringify({same:f===globalThis.fetch,t3:k.isT3Exe(process.execPath)}))", file],
    { env: { ...process.env, AIS_T3_ANTHROPIC_PROXY: "http://127.0.0.1:9" } },
  );
  expect(p.stderr.toString()).toBe("");
  expect(p.stdout.toString().trim()).toBe('{"same":true,"t3":false}');
});

test("preload decision accepts only the T3 runtime binary path", async () => {
  const s = await scratch();
  await installT3Proxy({ ...s.opts, ...input });
  const mod = require(t3Paths(s.opts).preload) as { isT3Exe(p: string): boolean };
  expect(mod.isT3Exe("/opt/app/.t3/runtime/versions/0.9.1/t3")).toBe(true);
  expect(mod.isT3Exe("/opt/app/.t3/runtime/versions/0.9.1/node")).toBe(false);
  expect(mod.isT3Exe("/usr/bin/node")).toBe(false);
});

test("with the T3 binary, api.anthropic.com goes through the proxy dispatcher and other hosts stay native", async () => {
  const s = await scratch();
  await installT3Proxy({ ...s.opts, ...input });
  const mod = require(t3Paths(s.opts).preload) as { install(o: unknown): boolean };
  const calls: { via: string; url: string; dispatcher?: unknown }[] = [];
  class ProxyAgent {
    constructor(public o: { uri: string }) {}
  }
  const undici = { ProxyAgent, fetch: async (url: unknown, init: { dispatcher?: unknown }) => (calls.push({ via: "undici", url: String(url), dispatcher: init.dispatcher }), new Response("ok")) };
  const target = { fetch: async (url: unknown) => (calls.push({ via: "native", url: String(url) }), new Response("ok")) };
  expect(mod.install({ exe: "/opt/app/.t3/runtime/versions/1/t3", proxy: "http://127.0.0.1:9", undici, target })).toBe(true);
  await target.fetch("https://api.anthropic.com/api/oauth/usage");
  await target.fetch(new URL("https://API.anthropic.com/x"));
  await target.fetch(new Request("https://api.anthropic.com/y", { method: "POST", body: "b" }));
  await target.fetch("https://api.github.com/user");
  expect(calls.map((c) => c.via)).toEqual(["undici", "undici", "undici", "native"]);
  expect(calls[0]!.dispatcher).toBeInstanceOf(ProxyAgent);
  expect((calls[0]!.dispatcher as ProxyAgent).o.uri).toBe("http://127.0.0.1:9");
  // Not the T3 binary, or no proxy: nothing is installed.
  const other = { fetch: async () => new Response("") };
  const orig = other.fetch;
  expect(mod.install({ exe: "/usr/bin/node", proxy: "http://p", undici, target: other })).toBe(false);
  expect(mod.install({ exe: "/opt/app/.t3/runtime/versions/1/t3", proxy: "", undici, target: other })).toBe(false);
  expect(other.fetch).toBe(orig);
});
