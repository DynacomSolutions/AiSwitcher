import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncT3Instances } from "../../src/t3/instances/sync.ts";
import type { GatewayApp } from "../../src/t3/instances/plan.ts";

const POOL_CLAUDE = ["claude", "pool"].join("-");
let home: string;
let secrets: string;
let settingsPath: string;
const TOKEN = "aisg_testtoken123";
const app = (name: string, provider: string, target: GatewayApp["target"], state = "active"): GatewayApp => ({ name, provider, target, state });
const pool = { kind: "pool" } as const;
const APPS: GatewayApp[] = [
  app("agents-claude", "claude", pool),
  app("agents-codex", "codex", pool),
  app("t3-grok-pool", "grok", pool),
  app("t3-kimi-pool", "kimi", pool),
  app("t3-opencode-pool", "opencode", pool),
  app("t3-zai-pool", "zai", pool),
];
let clock = 1_700_000_000_000;
const run = (apps: GatewayApp[], extra: Partial<Parameters<typeof syncT3Instances>[0]> = {}) =>
  syncT3Instances({ apps, home, env: {}, secretsPath: secrets, gatewayRoot: "https://gw.example/gateway", now: () => (clock += 5000), ...extra });
const settings = async () => JSON.parse(await readFile(settingsPath, "utf8"));
const backups = async () => (await readdir(join(home, ".t3", "backups")).catch(() => [])).length;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "t3-sync-"));
  secrets = join(home, "secrets");
  const names = ["AGENTS_CLAUDE", "AGENTS_CODEX", "T3_GROK_POOL", "T3_KIMI_POOL", "T3_OPENCODE_POOL", "T3_ZAI_POOL"];
  await writeFile(secrets, names.map((n) => `AIS_GATEWAY_APP_${n}_TOKEN=${TOKEN}\n`).join(""));
  settingsPath = join(home, ".t3", "userdata", "settings.json");
  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ theme: "dark", providerInstances: { "my-own": { driver: "codex", enabled: true }, "t3-zcode-org-acp": { driver: "acpRegistry", enabled: true } } }, null, 2) + "\n", { mode: 0o600 });
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe("syncT3Instances", () => {
  test("creates every instance from the live app list and keeps user instances", async () => {
    const items = await run(APPS);
    expect(items.filter((i) => i.status === "failed")).toEqual([]);
    const s = await settings();
    expect(Object.keys(s.providerInstances).sort()).toEqual([POOL_CLAUDE, "codex-pool", "my-own", "t3-grok-pool", "t3-grok-pool-acp", "t3-kimi-pool-acp", "t3-opencode-pool", "t3-zai-pool-acp", "t3-zcode-org-acp"]);
    expect(s.theme).toBe("dark");
    expect(s.providerInstances[POOL_CLAUDE].driver).toBe("claudeAgent");
    expect(s.providerInstances["codex-pool"].driver).toBe("codex");
    expect(s.providerInstances["t3-grok-pool"].driver).toBe("grok");
    expect(s.providerInstances["t3-opencode-pool"].driver).toBe("opencode");
    const kimi = s.providerInstances["t3-kimi-pool-acp"];
    expect(kimi).toMatchObject({ driver: "acpRegistry", enabled: true, config: { source: "registry", agentId: "kimi-code" } });
    expect(kimi.environment).toEqual([{ name: "KIMI_CODE_HOME", value: join(home, ".t3", "gateway", "t3-kimi-pool-acp"), sensitive: false }]);
    expect(await readFile(join(home, ".t3", "gateway", "t3-kimi-pool-acp", "config.toml"), "utf8")).toContain("https://gw.example/gateway/t3-kimi-pool/v1");
    const zai = s.providerInstances["t3-zai-pool-acp"];
    expect(zai.config.agentId).toBe("glm-acp-agent");
    expect(zai.environment.find((e: { name: string }) => e.name === "ACP_GLM_BASE_URL").value).toBe("https://gw.example/gateway/t3-zai-pool");
  });

  test("a second run changes nothing and keeps no new backup", async () => {
    await run(APPS);
    const before = await backups();
    const text = await readFile(settingsPath, "utf8");
    const items = await run(APPS);
    expect(items.every((i) => i.status === "current")).toBe(true);
    expect(await readFile(settingsPath, "utf8")).toBe(text);
    expect(await backups()).toBe(before);
  });

  test("check reports the difference and writes nothing", async () => {
    const text = await readFile(settingsPath, "utf8");
    const items = await run(APPS, { check: true });
    expect(items.some((i) => i.status === "created")).toBe(true);
    expect(await readFile(settingsPath, "utf8")).toBe(text);
  });

  test("a new app is picked up and a removed app is removed; user instances stay", async () => {
    await run(APPS);
    const next = [...APPS.filter((a) => a.name !== "t3-zai-pool"), app("t3-grok-org", "grok", { kind: "pin", identity: "org" })];
    await writeFile(secrets, (await readFile(secrets, "utf8")) + `AIS_GATEWAY_APP_T3_GROK_ORG_TOKEN=${TOKEN}\n`);
    const items = await run(next);
    expect(items.find((i) => i.id === "t3-grok-org")?.status).toBe("created");
    expect(items.find((i) => i.id === "t3-zai-pool-acp")?.status).toBe("removed");
    const ids = Object.keys((await settings()).providerInstances);
    expect(ids).toContain("t3-grok-org-acp");
    expect(ids).not.toContain("t3-zai-pool-acp");
    expect(ids).toContain("my-own");
    expect(ids).toContain("t3-zcode-org-acp");
  });

  test("retired Claude homes for Kimi and Z.ai are removed", async () => {
    const s = await settings();
    s.providerInstances["t3-claude-kimi-org"] = { driver: "claudeAgent", enabled: true };
    await writeFile(settingsPath, JSON.stringify(s));
    await run(APPS);
    expect(Object.keys((await settings()).providerInstances)).not.toContain("t3-claude-kimi-org");
  });

  test("an app with no token is skipped and its existing instance stays", async () => {
    await run(APPS);
    await writeFile(secrets, (await readFile(secrets, "utf8")).split("\n").filter((l) => !l.includes("T3_ZAI_POOL")).join("\n"));
    const items = await run(APPS);
    expect(items.find((i) => i.id === "t3-zai-pool-acp")?.status).toBe("skipped");
    expect(Object.keys((await settings()).providerInstances)).toContain("t3-zai-pool-acp");
  });

  test("an empty app list never removes anything", async () => {
    await run(APPS);
    await expect(run([])).rejects.toThrow(/no gateway apps/i);
    expect(Object.keys((await settings()).providerInstances)).toContain(POOL_CLAUDE);
  });

  test("the pod flavour uses the pod binaries, opencode over ACP with a usage instance, and no token in env", async () => {
    await run(APPS, { flavour: "pod", binaryDir: "/opt/agents" });
    const s = await settings();
    expect(s.providerInstances[POOL_CLAUDE].config.binaryPath).toBe("/opt/agents/claude");
    expect(s.providerInstances["t3-opencode-pool"]).toMatchObject({ driver: "acpRegistry", config: { agentId: "opencode", commandPath: "/opt/agents/opencode" } });
    expect(s.providerInstances["t3-opencode-pool-usage"].driver).toBe("opencode");
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });
});

test("only-missing keeps an existing instance and still adds and removes", async () => {
  const s = await settings();
  s.providerInstances["t3-opencode-pool"] = { driver: "acpRegistry", displayName: "seeded", enabled: true };
  s.providerInstances["t3-grok-old"] = { driver: "grok", enabled: true };
  await writeFile(settingsPath, JSON.stringify(s));
  await run(APPS, { flavour: "pod", binaryDir: "/opt/agents", onlyMissing: true });
  const after = (await settings()).providerInstances;
  expect(after["t3-opencode-pool"].displayName).toBe("seeded");
  expect(after["t3-zai-pool-acp"]).toBeDefined();
  expect(after["t3-grok-old"]).toBeUndefined();
});
