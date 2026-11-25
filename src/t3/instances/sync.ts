import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appTokenKey, readSecretsKey } from "../../cli/gateway/secrets-file.ts";
import { GATEWAY_TOKEN_PREFIX } from "../../identities/claude-gateway-entry.ts";
import { buildCodexGatewayAuth, configureCodexGatewayHome, readCodexGatewayHomeApp } from "../../identities/codex-gateway-home.ts";
import { writeFileAtomic } from "../../identities/pool/fs.ts";
import { t3Paths } from "../../identities/t3-anthropic-proxy.ts";
import { applyT3Instance, flushSettingsBatch, loadSettingsBatch, stable, type InstanceDriver, type SettingsBatch, type T3InstanceOptions } from "../../identities/t3-instance.ts";
import { syncT3UsageCredentials } from "../../identities/t3-usage-credentials.ts";
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
  /** Folder that holds one home folder per instance. Default `<T3 home>/gateway` (a pod: its mounted gateway homes). */
  gatewayDir?: string;
  secretsPath?: string;
  /** A folder that holds one token file per app (`<dir>/<app>`), as in a pod. Without it the secrets file is read. */
  tokenDir?: string;
  /** Gives the token of one app, read live from the gateway by the caller. Wins over `tokenDir` and the secrets file. Undefined: skip the app. */
  tokenFor?: (app: string) => Promise<string | undefined>;
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
  /** The whole run works on this in-memory copy of settings.json and writes it once at the end. */
  batch: SettingsBatch;
  flavour: "host" | "pod";
  bin: (name: string) => string;
  check: boolean;
  now: () => number;
}

const folderOf = (c: Ctx, id: string): string => join(c.o.gatewayDir ?? join(c.t3Home, "gateway"), id);

const instancesOf = (c: Ctx): Json => obj(c.batch.settings.providerInstances) ?? {};

/** Puts one entry into the in-memory settings (the run writes the file once). Returns whether it differs from the current one. */
async function putEntry(c: Ctx, id: string, build: (existing: Json | undefined) => Json): Promise<boolean> {
  const instances = instancesOf(c);
  const existing = obj(instances[id]);
  const entry = build(existing);
  if (stable(existing) === stable(entry)) return false;
  if (!c.check) {
    c.batch.settings.providerInstances = { ...instances, [id]: entry };
    c.batch.dirty.add(id);
  }
  return true;
}

async function hasInstance(c: Ctx, id: string): Promise<boolean> {
  return instancesOf(c)[id] !== undefined;
}

/** Display name and enabled flag: set on create only. An existing instance keeps what the user (or T3) has set. */
const lead = (existing: Json | undefined, p: PlannedInstance, suffix = ""): Json => ({
  displayName: typeof existing?.displayName === "string" ? existing.displayName : `${displayName(p)}${suffix}`,
  enabled: typeof existing?.enabled === "boolean" ? existing.enabled : true,
});

const tokenStamp = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 16);

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

const POOL_ACCENT = "#c62d2d";
const PIN_ACCENT: Record<string, string> = { claude: "#df25eb", codex: "#c355c6" };

/** Gives a new instance the accent colour of its provider. */
async function putAccent(c: Ctx, p: PlannedInstance, item: SyncItem): Promise<SyncItem> {
  const colour = p.who === "pool" ? POOL_ACCENT : PIN_ACCENT[p.provider];
  // On create only: a colour (or the lack of one) on an existing instance is the user's.
  if (!colour || item.status !== "created" || c.check) return item;
  await putEntry(c, p.id, (existing) => (existing && typeof existing.accentColor !== "string" ? { ...existing, accentColor: colour } : (existing ?? {})));
  return item;
}

async function applyOne(c: Ctx, p: PlannedInstance): Promise<SyncItem> {
  return putAccent(c, p, await applyInstance(c, p));
}

async function applyInstance(c: Ctx, p: PlannedInstance): Promise<SyncItem> {
  if (c.o.onlyMissing && (await hasInstance(c, p.id))) return { id: p.id, status: "current" };
  const url = `${c.o.gatewayRoot.replace(/\/+$/, "")}/${p.app}`;
  const token = c.o.tokenFor ? (await c.o.tokenFor(p.app))?.trim() : c.o.tokenDir ? (await fileText(join(c.o.tokenDir, p.app)))?.trim() : await readSecretsKey(appTokenKey(p.app), c.o.secretsPath);
  if (!token || !token.startsWith(GATEWAY_TOKEN_PREFIX)) return { id: p.id, status: "skipped", detail: `no gateway token for app ${p.app}` };
  const base = { token, home: c.home, ...(c.o.gatewayDir ? { gatewayDir: c.o.gatewayDir } : {}), ...(c.o.env ? { env: c.o.env } : {}), ...(c.o.secretsPath ? { secretsPath: c.o.secretsPath } : {}), check: c.check, now: c.now };
  const viaWriter = async (driver: InstanceDriver, extra: Partial<T3InstanceOptions> = {}): Promise<SyncItem> => {
    const r = await applyT3Instance({ id: p.id, driver, app: p.app, gatewayUrl: url, name: displayName(p), binary: c.bin(driver === "claude" ? "claude" : driver), keepExisting: true, batch: c.batch, ...base, ...extra });
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
    return { ...existing, driver: "codex", ...lead(existing, p), config: { ...cfg, binaryPath: c.bin("codex"), homePath: home } };
  });
  if (c.check) {
    // A dry run still reports a changed login: auth.json must hold the placeholder login of the current token.
    try {
      const have = await readCodexGatewayHomeApp(home);
      if ((await fileText(join(home, "auth.json"))) !== buildCodexGatewayAuth(have.app, token)) changed = true;
    } catch {
      changed = true;
    }
  } else {
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

/** Sets base_url and api_key inside [providers.gateway] of a Kimi config.toml; other tables and lines are kept. Adds a missing key. */
export function setGatewayKeys(text: string, baseUrl: string, token: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[providers.gateway]");
  if (start < 0) return `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}[providers.gateway]\ntype = "kimi"\nbase_url = ${JSON.stringify(baseUrl)}\napi_key = ${JSON.stringify(token)}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i]!)) { end = i; break; }
  const want: Record<string, string> = { base_url: JSON.stringify(baseUrl), api_key: JSON.stringify(token) };
  const seen = new Set<string>();
  for (let i = start + 1; i < end; i++) {
    const key = /^\s*(base_url|api_key)\s*=/.exec(lines[i]!)?.[1];
    if (key) {
      lines[i] = `${key} = ${want[key]}`;
      seen.add(key);
    }
  }
  const add = Object.keys(want).filter((k) => !seen.has(k)).map((k) => `${k} = ${want[k]}`);
  lines.splice(start + 1, 0, ...add);
  return lines.join("\n");
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
  // T3 redacts a sensitive env value after it reads it (`value: ""`, `valueRedacted: true`). A redacted entry of the same name counts
  // as equal until the token changes; a short hash of the token in the folder tells that. The plaintext is written only on a change.
  const stampPath = join(folder, ".gateway-token-sha");
  const tokenChanged = (await fileText(stampPath))?.trim() !== tokenStamp(token);
  let existed = false;
  let changed = await putEntry(c, p.id, (existing) => {
    existed = existing !== undefined;
    const have = (existing?.environment as Json[] | undefined) ?? [];
    const env2 = environment.map((e) => {
      if (e.sensitive !== true || tokenChanged) return e;
      const kept = have.find((h) => obj(h)?.name === e.name && obj(h)?.valueRedacted === true);
      return kept ?? e;
    });
    return { ...existing, driver: "acpRegistry", ...lead(existing, p), config: { ...obj(existing?.config), source: "registry", agentId: agent.agentId, commandPath }, environment: env2 };
  });
  if (host && environment.some((e) => e.sensitive === true)) await putFile(stampPath, `${tokenStamp(token)}\n`, 0o600, c.check);
  if (p.kind === "acp-kimi") {
    // The folder config.toml names the gateway provider and holds the app token. Only base_url and api_key of [providers.gateway] follow
    // the gateway; every other line (the model lists of `ais gateway t3-models`) stays.
    const cfgPath = join(folder, "config.toml");
    const fresh = `[providers.gateway]\ntype = "kimi"\nbase_url = ${JSON.stringify(`${url}/v1`)}\napi_key = ${JSON.stringify(token)}\n`;
    const have = await fileText(cfgPath);
    changed = (await putFile(cfgPath, have === undefined ? fresh : setGatewayKeys(have, `${url}/v1`, token), 0o600, c.check)) || changed;
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
    return { ...existing, driver: "acpRegistry", ...lead(existing, p, " chat"), config: { ...obj(existing?.config), source: "registry", agentId: "opencode", commandPath: c.bin("opencode") }, environment: [env("OPENCODE_CONFIG_DIR", folder), env("XDG_DATA_HOME", join(folder, "data"))] };
  });
  const b = await putEntry(c, usageId, (existing) => ({ ...existing, driver: "opencode", ...lead(existing, p), config: { ...obj(existing?.config), binaryPath: c.bin("opencode") }, environment: [env("OPENCODE_CONFIG_DIR", usageFolder), env("XDG_DATA_HOME", usageFolder)] }));
  return { id: p.id, status: a || b ? (existed ? "updated" : "created") : "current" };
}

/** Compares the live app list with settings.json and applies the difference. Never reads a cached list. */
export async function syncT3Instances(o: SyncT3InstancesOptions): Promise<SyncItem[]> {
  if (o.apps.length === 0) throw new Error("the gateway returned no gateway apps; nothing is changed");
  const home = o.home ?? homedir();
  const t3Home = t3Paths({ home, ...(o.env ? { env: o.env } : {}) }).t3Home;
  const flavour = o.flavour ?? "host";
  const binaryDir = o.binaryDir ?? "/opt/t3-agents/default";
  const settingsPath = join(t3Home, "userdata", "settings.json");
  const c: Ctx = {
    o,
    home,
    t3Home,
    settingsPath,
    batch: await loadSettingsBatch(settingsPath),
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
  const managed = (id: string): boolean => isManagedInstanceId(id) || (flavour === "pod" && /^t3-opencode-.+-usage$/.test(id));
  const managedIds = Object.keys(instancesOf(c)).filter(managed);
  const stale = managedIds.filter((id) => !keep.has(id));
  // A short or wrong app list must not wipe the instances: no removal when the plan holds no T3 app, or when it would remove more than half.
  const refuse = stale.length > 0 && (plan.length === 0 || (stale.length >= 2 && stale.length > managedIds.length / 2));
  for (const id of stale) {
    if (refuse) {
      out.push({ id, status: "skipped", detail: plan.length === 0 ? "removal refused: the app list holds no T3 app" : "removal refused: it would remove more than half of the gateway instances" });
      continue;
    }
    try {
      const r = await applyT3Instance({ id, driver: "claude", app: "", gatewayUrl: "", home, ...(o.env ? { env: o.env } : {}), check: c.check, remove: true, now: c.now, batch: c.batch });
      out.push({ id, status: r.status === "removed" ? "removed" : "current" });
    } catch (e) {
      out.push({ id, status: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!c.check) {
    // One write for the whole run: the file is read again here and only the instances this run touched are merged in.
    await flushSettingsBatch(settingsPath, c.batch, join(t3Home, "backups"), c.now());
    // The usage logins (grok, opencode) read the instances from the file, so they run after it is written.
    try {
      const usage = await syncT3UsageCredentials({ home, ...(o.env ? { env: o.env } : {}), ...(o.secretsPath ? { secretsPath: o.secretsPath } : {}) });
      for (const r of usage) {
        const item = out.find((i) => i.id === r.id);
        if (item && r.status === "updated" && item.status === "current") item.status = "updated";
      }
    } catch (e) {
      out.push({ id: "usage-credentials", status: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
