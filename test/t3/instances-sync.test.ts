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
const ROTATED = ["aisg", "rotated"].join("_");
const LIVE = ["aisg", "live"].join("_");
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

test("the Kimi config.toml follows a changed token and is left alone when the token is the same", async () => {
  await run(APPS);
  const cfg = join(home, ".t3", "gateway", "t3-kimi-pool-acp", "config.toml");
  expect(await readFile(cfg, "utf8")).toContain(TOKEN);
  await writeFile(secrets, (await readFile(secrets, "utf8")).replaceAll(TOKEN, ROTATED));
  const items = await run(APPS);
  expect(items.find((i) => i.id === "t3-kimi-pool-acp")?.status).toBe("updated");
  expect(await readFile(cfg, "utf8")).toContain(ROTATED);
  expect(await readFile(cfg, "utf8")).not.toContain(TOKEN);
  expect((await run(APPS)).find((i) => i.id === "t3-kimi-pool-acp")?.status).toBe("current");
});

test("tokenFor gives the app token live and wins over the token folder and the secrets file", async () => {
  const asked: string[] = [];
  const items = await run(APPS, { tokenFor: async (name) => (asked.push(name), name === "t3-zai-pool" ? undefined : LIVE) });
  expect([...new Set(asked)].sort()).toEqual(["agents-claude", "agents-codex", "t3-grok-pool", "t3-kimi-pool", "t3-opencode-pool", "t3-zai-pool"]);
  expect(items.find((i) => i.id === "t3-zai-pool-acp")?.status).toBe("skipped");
  expect(await readFile(join(home, ".t3", "gateway", "t3-kimi-pool-acp", "config.toml"), "utf8")).toContain(LIVE);
});

test("a rotated Kimi token keeps the model lines of the config.toml", async () => {
  await run(APPS);
  const cfg = join(home, ".t3", "gateway", "t3-kimi-pool-acp", "config.toml");
  await writeFile(cfg, `${await readFile(cfg, "utf8")}\n[models."gateway/x"]\nprovider = "gateway"\nmodel = "x"\n`, { mode: 0o600 });
  await writeFile(secrets, (await readFile(secrets, "utf8")).replaceAll(TOKEN, ROTATED));
  await run(APPS);
  const text = await readFile(cfg, "utf8");
  expect(text).toContain(`api_key = "${ROTATED}"`);
  expect(text).toContain('[models."gateway/x"]');
  expect(text.match(/api_key/g)).toHaveLength(1);
});

test("gatewayDir moves every instance folder and the default stays under the T3 home", async () => {
  const dir = join(home, "elsewhere");
  await run(APPS, { gatewayDir: dir });
  const s = await settings();
  expect(s.providerInstances["t3-kimi-pool-acp"].environment[0].value).toBe(join(dir, "t3-kimi-pool-acp"));
  expect(s.providerInstances["t3-grok-pool"].environment.find((e: { name: string }) => e.name === "GROK_HOME").value).toBe(join(dir, "t3-grok-pool"));
  expect(await readFile(join(dir, "t3-kimi-pool-acp", "config.toml"), "utf8")).toContain(TOKEN);
  expect(await readdir(join(home, ".t3", "gateway")).catch(() => [])).toEqual([]);
});

test("accent colour follows the provider and the pool, and a colour set by hand is kept", async () => {
  const pin = (name: string, provider: string, identity: string) => app(name, provider, { kind: "pin", identity });
  const tokenFor = async () => LIVE;
  const apps = [...APPS, pin("t3-claude-org", "claude", "org"), pin("t3-codex-org", "codex", "org")];
  await run(apps, { tokenFor });
  const s = await settings();
  expect(s.providerInstances[POOL_CLAUDE].accentColor).toBe("#c62d2d");
  expect(s.providerInstances["codex-pool"].accentColor).toBe("#c62d2d");
  expect(s.providerInstances["t3-kimi-pool-acp"].accentColor).toBe("#c62d2d");
  expect(s.providerInstances["t3-claude-org"].accentColor).toBe("#df25eb");
  expect(s.providerInstances["t3-codex-org"].accentColor).toBe("#c355c6");
  s.providerInstances["t3-codex-org"].accentColor = "#111111";
  await writeFile(settingsPath, JSON.stringify(s));
  await run(apps, { tokenFor });
  expect((await settings()).providerInstances["t3-codex-org"].accentColor).toBe("#111111");
  expect((await run(apps, { tokenFor })).every((i) => i.status === "current")).toBe(true);
});

describe("hardening", () => {
  const zai = [app("t3-zai-pool", "zai", pool)];
  const redact = async () => {
    const s = await settings();
    for (const inst of Object.values(s.providerInstances) as { environment?: { sensitive?: boolean; value: string; valueRedacted?: boolean }[] }[])
      for (const e of inst.environment ?? []) if (e.sensitive) { e.value = ""; e.valueRedacted = true; }
    await writeFile(settingsPath, JSON.stringify(s, null, 2) + "\n");
  };

  test("a value that T3 redacted is equal until the token changes; the plaintext is not written back", async () => {
    await run(zai);
    await redact();
    const before = await backups();
    const items = await run(zai);
    expect(items.every((i) => i.status === "current")).toBe(true);
    expect(await backups()).toBe(before);
    expect(JSON.stringify(await settings())).not.toContain(TOKEN);
    await writeFile(secrets, (await readFile(secrets, "utf8")).replaceAll(TOKEN, ROTATED));
    expect((await run(zai)).find((i) => i.id === "t3-zai-pool-acp")?.status).toBe("updated");
    expect(JSON.stringify(await settings())).toContain(ROTATED);
  });

  test("an existing instance keeps its display name, enabled flag and colour", async () => {
    await run(APPS);
    const s = await settings();
    s.providerInstances["t3-kimi-pool-acp"].displayName = "Mine";
    s.providerInstances["t3-kimi-pool-acp"].enabled = false;
    s.providerInstances["t3-grok-pool"].enabled = false;
    delete s.providerInstances[POOL_CLAUDE].accentColor;
    await writeFile(settingsPath, JSON.stringify(s, null, 2) + "\n");
    const items = await run(APPS);
    expect(items.every((i) => i.status === "current")).toBe(true);
    const after = (await settings()).providerInstances;
    expect(after["t3-kimi-pool-acp"]).toMatchObject({ displayName: "Mine", enabled: false });
    expect(after["t3-grok-pool"].enabled).toBe(false);
    expect(after[POOL_CLAUDE].accentColor).toBeUndefined();
  });

  test("one run makes one backup and keeps what changed in the file meanwhile", async () => {
    const before = await backups();
    await run(APPS, {
      tokenFor: async (name) => {
        // T3 (or another tool) edits settings.json while the sync runs.
        const s = await settings();
        s.providerInstances["added-by-t3"] = { driver: "codex", enabled: true };
        await writeFile(settingsPath, JSON.stringify(s, null, 2) + "\n");
        return name ? LIVE : undefined;
      },
    });
    expect(await backups()).toBe(before + 1);
    const after = (await settings()).providerInstances;
    expect(after["added-by-t3"]).toBeDefined();
    expect(after["t3-kimi-pool-acp"]).toBeDefined();
  });

  test("only the newest 10 backups stay", async () => {
    for (let i = 0; i < 14; i++) {
      await writeFile(secrets, (await readFile(secrets, "utf8")).replaceAll(i === 0 ? TOKEN : `aisg_r${i - 1}`, `aisg_r${i}`));
      await run(zai);
    }
    expect(await backups()).toBeLessThanOrEqual(10);
  });

  test("no removal when the list holds no T3 app, and none when it would remove more than half", async () => {
    await run(APPS);
    const none = await run([app("other", "claude", { kind: "pin", identity: "x" }, "revoked")]);
    expect(none.filter((i) => i.status === "removed")).toEqual([]);
    expect(none.some((i) => /refused/.test(i.detail ?? ""))).toBe(true);
    const half = await run([app("agents-claude", "claude", pool)]);
    expect(half.filter((i) => i.status === "removed")).toEqual([]);
    expect(Object.keys((await settings()).providerInstances)).toContain("t3-kimi-pool-acp");
    expect((await run(APPS.slice(0, 5))).filter((i) => i.status === "removed").map((i) => i.id)).toEqual(["t3-zai-pool-acp"]);
  });

  test("check reports a codex login that differs from the token", async () => {
    await run(APPS);
    const auth = join(home, ".t3", "gateway", "codex-pool", "auth.json");
    await writeFile(auth, "{}\n");
    const items = await run(APPS, { check: true });
    expect(items.find((i) => i.id === "codex-pool")?.status).toBe("updated");
    expect(await readFile(auth, "utf8")).toBe("{}\n");
  });

  test("an existing Claude home path (a pool kept on an identity folder) is not moved back to the gateway folder", async () => {
    await run(APPS);
    const s = await settings();
    s.providerInstances[POOL_CLAUDE].config.homePath = "/identities/pool";
    await writeFile(settingsPath, JSON.stringify(s, null, 2) + "\n");
    const items = await run(APPS);
    expect(items.find((i) => i.id === POOL_CLAUDE)?.status).toBe("current");
    expect((await settings()).providerInstances[POOL_CLAUDE].config.homePath).toBe("/identities/pool");
  });
});
