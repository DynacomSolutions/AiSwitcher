import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appTokenKey, readSecretsKey } from "../../cli/gateway/secrets-file.ts";
import { GATEWAY_TOKEN_PREFIX } from "../../identities/claude-gateway-entry.ts";
import { configureCodexGatewayHome } from "../../identities/codex-gateway-home.ts";
import { writeFileAtomic } from "../../identities/pool/fs.ts";
import { t3Paths } from "../../identities/t3-anthropic-proxy.ts";
import { applyT3Instance, stable, writeSettings, type InstanceDriver, type T3InstanceOptions } from "../../identities/t3-instance.ts";
import { loadClaudeIdentities, noThirdPartyNames, t3ClaudeSource } from "../../shared/t3-claude-source.ts";
import { isManagedInstanceId, planT3Instances, type GatewayApp, type PlannedInstance } from "./plan.ts";

/**
 * Makes T3 Code's provider instances match the live gateway app list (`GET /apps`). The caller reads the list each time: nothing here
 * keeps a list of pools or identities. Instances that the plan owns are created or updated with the existing writers
 * (`applyT3Instance`), the ones the app list no longer asks for are removed, and every other instance (the user's own, ZCode,
 * T3's defaults) is left alone. A settings backup is kept for every change.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

export interface SyncT3InstancesOptions {
  /** The app list, read live by the caller. Never reused between runs. */
  apps: readonly GatewayApp[];
  /** Gateway proxy base, e.g. https://<host>/gateway. The instance URL is `<root>/<app>`. */
  gatewayRoot: string;
  /** `host` (default): T3 on a machine with ~/.local/bin binaries. `pod`: T3 in a cluster pod, agent binaries under `binaryDir`. */
  flavour?: "host" | "pod";
  binaryDir?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  secretsPath?: string;
  /** A folder that holds one token file per app (`<dir>/<app>`), as in a pod. Without it the secrets file is read. */
  tokenDir?: string;
  /** Leave an instance that already exists exactly as it is (a pod: the chart seeds its own entries). Only missing ones are made. */
  onlyMissing?: boolean;
  check?: boolean;
  now?: () => number;
}

export interface SyncItem {
  id: string;
  status: "created" | "updated" | "current" | "removed" | "skipped" | "failed";
  detail?: string;
}

const ACP_AGENT: Record<string, { agentId: string; label: string; binary: string }> = {
  "acp-kimi": { agentId: "kimi-code", label: "Kimi", binary: "kimi" },
  "acp-grok": { agentId: "grok-build", label: "Grok", binary: "grok" },
  "acp-zai": { agentId: "glm-acp-agent", label: "Z.AI", binary: "zai" },
};

const TITLE = (s: string): string => s.split(/[-_]/).map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", kimi: "Kimi", zai: "Z.AI", opencode: "OpenCode Go" };
const displayName = (p: PlannedInstance): string => `${p.who === "pool" ? "Pool" : TITLE(p.who)} (${PROVIDER_LABEL[p.provider] ?? p.provider})`;

async function fileText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Writes a file only when its text differs. Returns true when it changed. */
async function putFile(path: string, content: string, mode: number, check: boolean): Promise<boolean> {
  const have = await fileText(path);
  const same = have === content && ((await stat(path)).mode & 0o777) === mode;
  if (same) return false;
  if (!check) {
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, content);
    await chmod(path, mode);
  }
  return true;
}

interface Ctx {
  o: SyncT3InstancesOptions;
  home: string;
  t3Home: string;
  settingsPath: string;
  flavour: "host" | "pod";
  bin: (name: string) => string;
  check: boolean;
  now: () => number;
}

const folderOf = (c: Ctx, id: string): string => join(c.t3Home, "gateway", id);

/** Writes one entry into settings.json (backup kept). Returns whether it differs from the current one. */
async function putEntry(c: Ctx, id: string, build: (existing: Json | undefined) => Json): Promise<boolean> {
  const before = await fileText(c.settingsPath);
  const settings: Json = before === undefined ? {} : (obj(JSON.parse(before)) ?? {});
  const instances = obj(settings.providerInstances) ?? {};
  const existing = obj(instances[id]);
  const entry = build(existing);
  if (stable(existing) === stable(entry)) return false;
  if (!c.check) {
    settings.providerInstances = { ...instances, [id]: entry };
    await writeSettings(c.settingsPath, before, settings, join(c.t3Home, "backups"), c.now());
  }
  return true;
}

async function hasInstance(c: Ctx, id: string): Promise<boolean> {
  const text = await fileText(c.settingsPath);
  return text !== undefined && obj(obj(JSON.parse(text))?.providerInstances)?.[id] !== undefined;
}

async function claudeSource(c: Ctx, id: string): Promise<T3InstanceOptions["source"]> {
  try {
    const registry = await loadClaudeIdentities(join(c.home, ".claude", "identities.json"));
    const restricted = noThirdPartyNames({ home: c.home, ...(c.o.env ? { env: c.o.env } : {}) });
    const target = t3ClaudeSource(registry, folderOf(c, id), c.t3Home, restricted);
    if (target) return { dir: target.dir, noThirdParty: target.noThirdParty, ...(target.modelHome ? { modelHome: true } : {}) };
  } catch {
    // no registry on this machine
  }
  return "none";
}

async function applyOne(c: Ctx, p: PlannedInstance): Promise<SyncItem> {
  if (c.o.onlyMissing && (await hasInstance(c, p.id))) return { id: p.id, status: "current" };
  const url = `${c.o.gatewayRoot.replace(/\/+$/, "")}/${p.app}`;
  const token = c.o.tokenDir ? (await fileText(join(c.o.tokenDir, p.app)))?.trim() : await readSecretsKey(appTokenKey(p.app), c.o.secretsPath);
  if (!token || !token.startsWith(GATEWAY_TOKEN_PREFIX)) return { id: p.id, status: "skipped", detail: `no gateway token for app ${p.app}` };
  const base = { token, home: c.home, ...(c.o.env ? { env: c.o.env } : {}), ...(c.o.secretsPath ? { secretsPath: c.o.secretsPath } : {}), check: c.check, now: c.now };
  const viaWriter = async (driver: InstanceDriver, extra: Partial<T3InstanceOptions> = {}): Promise<SyncItem> => {
    const r = await applyT3Instance({ id: p.id, driver, app: p.app, gatewayUrl: url, name: displayName(p), binary: c.bin(driver === "claude" ? "claude" : driver), ...base, ...extra });
    return { id: p.id, status: r.status === "absent" ? "current" : r.status, ...(r.warnings?.length ? { detail: r.warnings.join("; ") } : {}) };
  };
  switch (p.kind) {
    case "claude":
      return viaWriter("claude", { source: await claudeSource(c, p.id) });
    case "grok":
      return viaWriter("grok");
    case "opencode":
      if (c.flavour === "host") return viaWriter("opencode");
      return applyOpencodePod(c, p);
    case "codex":
      return applyCodex(c, p, url, token);
    default:
      return applyAcp(c, p, url, token);
  }
}

async function applyCodex(c: Ctx, p: PlannedInstance, url: string, token: string): Promise<SyncItem> {
  let existed = false;
  let home = folderOf(c, p.id);
  let changed = await putEntry(c, p.id, (existing) => {
    existed = existing !== undefined;
    const cfg = obj(existing?.config);
    // An existing home path is kept (the pool home may be an identity folder).
    if (typeof cfg?.homePath === "string" && cfg.homePath !== "") home = cfg.homePath;
    return { ...existing, driver: "codex", displayName: displayName(p), enabled: true, config: { ...cfg, binaryPath: c.bin("codex"), homePath: home } };
  });
  if (!c.check) {
    const cfgPath = join(home, "config.toml");
    if ((await fileText(cfgPath)) === undefined) {
      await mkdir(home, { recursive: true });
      await writeFileAtomic(cfgPath, `model_provider = "ais-gateway"\n\n[model_providers.ais-gateway]\nname = "AIS Gateway"\nbase_url = "${url}"\nwire_api = "responses"\nrequires_openai_auth = true\n`);
      await chmod(cfgPath, 0o600);
      changed = true;
    }
    const auth = join(home, "auth.json");
    // Rewrites config.toml and auth.json from the app token; both writes are idempotent.
    const before = await fileText(auth);
    await configureCodexGatewayHome(home, token);
    if ((await fileText(auth)) !== before) changed = true;
  }
  return { id: p.id, status: changed ? (existed ? "updated" : "created") : "current" };
}

async function applyAcp(c: Ctx, p: PlannedInstance, url: string, token: string): Promise<SyncItem> {
  const agent = ACP_AGENT[p.kind]!;
  const folder = folderOf(c, p.id);
  const host = c.flavour === "host";
  const env = (name: string, value: string, sensitive = false) => ({ name, value, sensitive });
  const environment: Json[] = [];
  if (p.kind === "acp-kimi") environment.push(env("KIMI_CODE_HOME", folder));
  else if (p.kind === "acp-grok") {
    environment.push(env("GROK_HOME", folder), env("GROK_CLI_CHAT_PROXY_BASE_URL", url), env("GROK_XAI_API_BASE_URL", url));
    if (host) environment.push(env("XAI_API_KEY", token, true));
  } else {
    environment.push(env("ACP_GLM_BASE_URL", url));
    if (host) environment.push(env("Z_AI_API_KEY", token, true));
    environment.push(env("ACP_GLM_SESSION_DIR", join(folder, "sessions")));
  }
  const commandPath = host ? join(c.home, ".ais", "t3", "acp", agent.agentId) : c.bin(agent.binary);
  let existed = false;
  let changed = await putEntry(c, p.id, (existing) => {
    existed = existing !== undefined;
    return { ...existing, driver: "acpRegistry", displayName: displayName(p), enabled: true, config: { ...obj(existing?.config), source: "registry", agentId: agent.agentId, commandPath }, environment };
  });
  if (p.kind === "acp-kimi") {
    // The folder config.toml names the gateway provider. Model lists come from `ais gateway t3-models`; an existing file is kept as it is.
    const cfgPath = join(folder, "config.toml");
    if ((await fileText(cfgPath)) === undefined) {
      changed = (await putFile(cfgPath, `[providers.gateway]\ntype = "kimi"\nbase_url = ${JSON.stringify(`${url}/v1`)}\napi_key = ${JSON.stringify(token)}\n`, 0o600, c.check)) || changed;
    }
  }
  return { id: p.id, status: changed ? (existed ? "updated" : "created") : "current" };
}

/** Pod: OpenCode chat runs as the ACP agent `opencode`, usage as the built-in driver (two instances, one app). */
async function applyOpencodePod(c: Ctx, p: PlannedInstance): Promise<SyncItem> {
  const folder = folderOf(c, p.id);
  const usageId = `${p.id}-usage`;
  const usageFolder = folderOf(c, usageId);
  const env = (name: string, value: string) => ({ name, value, sensitive: false });
  let existed = false;
  const a = await putEntry(c, p.id, (existing) => {
    existed = existing !== undefined;
    return { ...existing, driver: "acpRegistry", displayName: `${displayName(p)} chat`, enabled: true, config: { ...obj(existing?.config), source: "registry", agentId: "opencode", commandPath: c.bin("opencode") }, environment: [env("OPENCODE_CONFIG_DIR", folder), env("XDG_DATA_HOME", join(folder, "data"))] };
  });
  const b = await putEntry(c, usageId, (existing) => ({ ...existing, driver: "opencode", displayName: displayName(p), enabled: true, config: { ...obj(existing?.config), binaryPath: c.bin("opencode") }, environment: [env("OPENCODE_CONFIG_DIR", usageFolder), env("XDG_DATA_HOME", usageFolder)] }));
  return { id: p.id, status: a || b ? (existed ? "updated" : "created") : "current" };
}

/** Compares the live app list with settings.json and applies the difference. Never reads a cached list. */
export async function syncT3Instances(o: SyncT3InstancesOptions): Promise<SyncItem[]> {
  if (o.apps.length === 0) throw new Error("the gateway returned no gateway apps; nothing is changed");
  const home = o.home ?? homedir();
  const t3Home = t3Paths({ home, ...(o.env ? { env: o.env } : {}) }).t3Home;
  const flavour = o.flavour ?? "host";
  const binaryDir = o.binaryDir ?? "/opt/t3-agents/default";
  const c: Ctx = {
    o,
    home,
    t3Home,
    settingsPath: join(t3Home, "userdata", "settings.json"),
    flavour,
    bin: (name) => (flavour === "pod" ? join(binaryDir, name) : join(home, ".local", "bin", name)),
    check: o.check === true,
    now: o.now ?? Date.now,
  };
  const plan = planT3Instances(o.apps);
  const out: SyncItem[] = [];
  for (const p of plan) {
    try {
      out.push(await applyOne(c, p));
    } catch (e) {
      out.push({ id: p.id, status: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  // Remove what the app list no longer asks for. An app that is planned but skipped or failed keeps its instance.
  const keep = new Set(plan.map((p) => p.id));
  if (flavour === "pod") for (const p of plan) if (p.kind === "opencode") keep.add(`${p.id}-usage`);
  const text = await fileText(c.settingsPath);
  const instances = obj(obj(text ? JSON.parse(text) : {})?.providerInstances) ?? {};
  const managed = (id: string): boolean => isManagedInstanceId(id) || (flavour === "pod" && /^t3-opencode-.+-usage$/.test(id));
  for (const id of Object.keys(instances)) {
    if (keep.has(id) || !managed(id)) continue;
    try {
      const r = await applyT3Instance({ id, driver: "claude", app: "", gatewayUrl: "", home, ...(o.env ? { env: o.env } : {}), check: c.check, remove: true, now: c.now });
      out.push({ id, status: r.status === "removed" ? "removed" : "current" });
    } catch (e) {
      out.push({ id, status: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
