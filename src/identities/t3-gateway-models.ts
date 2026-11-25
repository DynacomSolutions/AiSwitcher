import { readdir, readFile, stat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { writeFileAtomic } from "./pool/fs.ts";
import { t3Paths } from "./t3-anthropic-proxy.ts";

/**
 * Keeps the model lists of T3 Code gateway folders (`<t3Home>/gateway/<instance>/`) equal to what the gateway serves
 * at `GET <base>/models`. Only the clients that cannot list models themselves are written:
 *
 * - kimi-code (`config.toml`, KIMI_CODE_HOME): a custom `[providers.<p>] type = "kimi"` exposes only its
 *   `[models.<id>]` blocks. Every block of that provider is replaced by one per gateway model (provider, model,
 *   display_name, max_context_size, capabilities); keys AIS does not derive stay on a model that is still served.
 * - OpenCode (`opencode.json`): `provider.<p>.models` of a provider with `options.baseURL` is set to the gateway's ids;
 *   an entry that stays keeps its own keys, `name` follows the gateway.
 * - ZCode (the Z.ai ACP agent's personal provider config, a JSON file): the gateway provider's `personalModelIds` and
 *   `modelOrder` are set to the gateway's ids, and its `providerModelRules` gain one entry per gateway model. A rule that
 *   stays keeps its own keys. The config file is found from the ZCode ACP launcher named in T3 Code's settings.json.
 *
 * Everything else in each file is left as it is. A list that cannot be read (network, 401, empty) changes nothing.
 * The host profile-sync daemon runs `syncT3GatewayModels` on a timer, so a new gateway model appears without a command.
 *
 * Clients that list models themselves are not written: grok-build fetches the gateway list into its own models_cache.json,
 * and Codex fetches it through its CLI. The glm-acp-agent advertises a built-in list (or `ACP_GLM_AVAILABLE_MODELS`), but
 * T3 Code stores its key redacted in settings.json, so AIS cannot read a key to fetch that list.
 */

export interface GatewayModel {
  id: string;
  displayName?: string;
  contextLength?: number;
  maxOutput?: number;
  input: string[];
  reasoning: boolean;
  alwaysThinking: boolean;
  dynamicTools: boolean;
}

export type FolderStatus = "updated" | "current" | "failed";

export interface FolderResult {
  dir: string;
  file: string;
  provider: string;
  status: FolderStatus;
  gatewayIds?: string[];
  fileIds: string[];
  error?: string;
}

export interface SyncOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Writes nothing; results say what would change (`updated` = out of date). */
  check?: boolean;
  timeoutMs?: number;
}

const FETCH_TIMEOUT_MS = 15_000;
const KIMI_CAPABILITIES = ["image_in", "video_in", "audio_in", "thinking", "always_thinking", "tool_use", "dynamically_loaded_tools"] as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** Gateway `/models` body (OpenAI-style `data[]`, or a bare array) as normalised entries, in gateway order, ids unique. */
export function parseGatewayModels(body: unknown): GatewayModel[] {
  const list = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.data) ? body.data : isObj(body) && Array.isArray(body.models) ? body.models : undefined;
  if (!list) throw new Error("model list has no data[]");
  const seen = new Set<string>();
  const out: GatewayModel[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = str(raw.id) ?? str(raw.slug);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const modalities = isObj(raw.modalities) ? raw.modalities : undefined;
    const input = new Set<string>(Array.isArray(modalities?.input) ? modalities.input.filter((x): x is string => typeof x === "string") : []);
    if (raw.supports_image_in === true) input.add("image");
    if (raw.supports_video_in === true) input.add("video");
    if (raw.supports_audio_in === true) input.add("audio");
    const limit = isObj(raw.limit) ? raw.limit : undefined;
    const reasoningObj = isObj(raw.reasoning) ? raw.reasoning : undefined;
    const thinkingType = str(raw.supports_thinking_type) ?? str(reasoningObj?.type);
    const tools = isObj(raw.tools) ? raw.tools : undefined;
    const displayName = str(raw.display_name) ?? str(raw.name);
    const contextLength = num(raw.context_length) ?? num(limit?.context) ?? num(raw.context_window);
    const maxOutput = num(limit?.output) ?? num(raw.max_output_tokens) ?? num(raw.max_completion_tokens);
    out.push({
      id,
      ...(displayName ? { displayName } : {}),
      ...(contextLength ? { contextLength } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      input: [...input],
      reasoning: raw.supports_reasoning === true || raw.reasoning === true || thinkingType !== undefined,
      alwaysThinking: thinkingType === "only",
      dynamicTools: raw.supports_dynamic_tools === true || tools?.dynamic_load === true,
    });
  }
  return out;
}

/** kimi-code capability names for a gateway model. */
export function kimiCapabilities(m: GatewayModel): string[] {
  const caps = new Set<string>();
  if (m.input.includes("image")) caps.add("image_in");
  if (m.input.includes("video")) caps.add("video_in");
  if (m.input.includes("audio")) caps.add("audio_in");
  if (m.alwaysThinking) caps.add("always_thinking");
  else if (m.reasoning) caps.add("thinking");
  if (m.dynamicTools) caps.add("dynamically_loaded_tools");
  return KIMI_CAPABILITIES.filter((c) => caps.has(c));
}

const HEADER = /^\s*\[\[?\s*(.*?)\s*\]\]?\s*(?:#.*)?$/;

/** Dotted TOML key of a table header line (quotes removed), or undefined for a non-header line. */
function headerPath(line: string): string[] | undefined {
  const m = HEADER.exec(line);
  if (!m) return undefined;
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let rest = m[1]!;
  re.lastIndex = 0;
  while (rest.length > 0) {
    const p = re.exec(rest);
    if (!p) return undefined;
    parts.push(p[1] !== undefined ? JSON.parse(`"${p[1]}"`) as string : (p[2] ?? p[3]!));
    rest = rest.slice(re.lastIndex);
    re.lastIndex = 0;
    if (p[4] === "") break;
  }
  return parts;
}

/** The kimi providers (type kimi, with base_url and api_key) in a config.toml. */
export function kimiGatewayProviders(configText: string): { name: string; baseUrl: string; apiKey: string }[] {
  const parsed = parseToml(configText) as Json;
  const providers = isObj(parsed.providers) ? parsed.providers : {};
  const out: { name: string; baseUrl: string; apiKey: string }[] = [];
  for (const [name, p] of Object.entries(providers)) {
    if (!isObj(p) || p.type !== "kimi") continue;
    const baseUrl = str(p.base_url);
    const apiKey = str(p.api_key);
    if (baseUrl && apiKey) out.push({ name, baseUrl, apiKey });
  }
  return out;
}

/**
 * New config.toml text whose `[models.*]` blocks for `provider` are exactly `models` (gateway order), inserted where the
 * first old block stood (end of file when there was none). Blocks of other providers, comments and every other key
 * stay. A `default_model` naming a model that is gone moves to the first gateway model. Idempotent.
 */
export function transformKimiConfig(configText: string, provider: string, models: GatewayModel[]): string {
  const parsed = parseToml(configText) as Json;
  const oldModels = isObj(parsed.models) ? parsed.models : {};
  const owned = new Set(Object.entries(oldModels).filter(([, m]) => isObj(m) && m.provider === provider).map(([id]) => id));
  const derived = new Set(["provider", "model", "display_name", "max_context_size", "capabilities"]);
  const table: Json = {};
  for (const m of models) {
    const old = owned.has(m.id) && isObj(oldModels[m.id]) ? (oldModels[m.id] as Json) : {};
    const keep = Object.fromEntries(Object.entries(old).filter(([k]) => !derived.has(k)));
    const prevContext = num(old.max_context_size);
    table[m.id] = {
      provider,
      model: m.id,
      display_name: m.displayName ?? str(old.display_name) ?? m.id,
      ...(m.contextLength ?? prevContext ? { max_context_size: m.contextLength ?? prevContext } : {}),
      capabilities: kimiCapabilities(m),
      ...keep,
    };
  }
  const block = stringifyToml({ models: table }).trim();

  const lines = configText.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = false;
  let insertAt = -1;
  for (const line of lines) {
    const path = headerPath(line);
    if (path) {
      skipping = path[0] === "models" && path.length >= 2 && owned.has(path[1]!);
      if (skipping && insertAt < 0) insertAt = out.length;
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  // Trailing blank lines of the kept text before the insertion point stay single.
  const before = out.slice(0, insertAt < 0 ? out.length : insertAt);
  const after = insertAt < 0 ? [] : out.slice(insertAt);
  while (before.length > 0 && before[before.length - 1]!.trim() === "") before.pop();
  while (after.length > 0 && after[0]!.trim() === "") after.shift();
  const parts = [before.join("\n"), block, after.join("\n")].filter((p) => p.trim() !== "");
  let text = `${parts.join("\n\n").replace(/\n+$/, "")}\n`;

  const defaultModel = str(parsed.default_model);
  const ids = new Set([...Object.keys(oldModels).filter((id) => !owned.has(id)), ...models.map((m) => m.id)]);
  if (defaultModel !== undefined && !ids.has(defaultModel) && models.length > 0) {
    // Top level only: the lines before the first table header.
    const all = text.split("\n");
    for (let i = 0; i < all.length && !headerPath(all[i]!); i++) {
      if (/^\s*default_model\s*=/.test(all[i]!)) {
        all[i] = `default_model = ${JSON.stringify(models[0]!.id)}`;
        break;
      }
    }
    text = all.join("\n");
  }
  // Same content in other formatting (a hand-written file): leave the text alone.
  return Bun.deepEquals(parseToml(text), parsed, true) ? configText : text;
}

/** opencode.json providers that point at an HTTP base with a key AIS can read. */
export function opencodeGatewayProviders(config: Json): { name: string; baseUrl: string; apiKey: string; headers: Record<string, string> }[] {
  const providers = isObj(config.provider) ? config.provider : {};
  const out: { name: string; baseUrl: string; apiKey: string; headers: Record<string, string> }[] = [];
  for (const [name, p] of Object.entries(providers)) {
    if (!isObj(p) || !isObj(p.options) || !isObj(p.models)) continue;
    const baseUrl = str(p.options.baseURL);
    const apiKey = str(p.options.apiKey);
    if (!baseUrl || !apiKey) continue;
    const headers = isObj(p.options.headers) ? Object.fromEntries(Object.entries(p.options.headers).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
    out.push({ name, baseUrl, apiKey, headers });
  }
  return out;
}

/** Output limit when the gateway gives none: OpenCode needs `output` beside `context`, so use a safe cap. */
const DEFAULT_OUTPUT_LIMIT = 32768;

/** New `provider.<name>.models` map: gateway ids in gateway order; a kept entry keeps its keys, `name` and `limit` follow the gateway (a hand-set `limit` stays when the gateway has no context). */
export function opencodeModelsMap(old: Json, models: GatewayModel[]): Json {
  const out: Json = {};
  for (const m of models) {
    const prev = isObj(old[m.id]) ? (old[m.id] as Json) : {};
    const prevLimit = isObj(prev.limit) ? prev.limit : {};
    const limit = m.contextLength
      ? { ...prevLimit, context: m.contextLength, output: Math.min(m.maxOutput ?? num(prevLimit.output) ?? DEFAULT_OUTPUT_LIMIT, m.contextLength) }
      : undefined;
    out[m.id] = { ...prev, name: m.displayName ?? str(prev.name) ?? m.id, ...(limit ? { limit } : {}) };
  }
  return out;
}

/** OpenCode `{file:path}` / `{env:NAME}` substitution of a key value (relative file paths are against the config dir). */
async function resolveOpencodeValue(value: string, dir: string, env: Record<string, string | undefined>): Promise<string> {
  let result = value;
  for (const m of value.matchAll(/\{(file|env):([^}]+)\}/g)) {
    let sub: string;
    if (m[1] === "env") sub = env[m[2]!] ?? "";
    else {
      const raw = m[2]!.trim();
      const p = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(dir, raw);
      sub = (await readFile(p, "utf8")).trim();
    }
    result = result.replace(m[0], sub);
  }
  return result;
}

async function fetchGatewayModels(baseUrl: string, apiKey: string, headers: Record<string, string>, opts: SyncOptions): Promise<GatewayModel[]> {
  const doFetch = opts.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await doFetch(url, { headers: { ...headers, authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    let reason = "";
    try {
      const body = (await res.json()) as Json;
      const err = isObj(body.error) ? body.error : undefined;
      reason = str(err?.code) ?? str(err?.type) ?? "";
    } catch {}
    throw new Error(`GET ${url}: HTTP ${res.status}${reason ? ` (${reason})` : ""}`);
  }
  const models = parseGatewayModels(await res.json());
  if (models.length === 0) throw new Error(`GET ${url}: empty model list`);
  return models;
}

async function writeKeepingMode(path: string, text: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  await writeFileAtomic(path, text);
  await chmod(path, mode);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function syncKimiFolder(dir: string, opts: SyncOptions): Promise<FolderResult[]> {
  const file = join(dir, "config.toml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let providers: ReturnType<typeof kimiGatewayProviders>;
  try {
    providers = kimiGatewayProviders(text);
  } catch (e) {
    return [{ dir, file, provider: "?", status: "failed", fileIds: [], error: `config.toml: ${errText(e)}` }];
  }
  const results: FolderResult[] = [];
  let next = text;
  for (const p of providers) {
    const fileIds = kimiModelIds(next, p.name);
    try {
      const models = await fetchGatewayModels(p.baseUrl, p.apiKey, {}, opts);
      const updated = transformKimiConfig(next, p.name, models);
      results.push({ dir, file, provider: p.name, status: updated === next ? "current" : "updated", gatewayIds: models.map((m) => m.id), fileIds });
      next = updated;
    } catch (e) {
      results.push({ dir, file, provider: p.name, status: "failed", fileIds, error: errText(e) });
    }
  }
  if (!opts.check && next !== text) await writeKeepingMode(file, next);
  return results;
}

/** Ids of the `[models.*]` blocks that belong to `provider`. */
export function kimiModelIds(configText: string, provider: string): string[] {
  const parsed = parseToml(configText) as Json;
  const models = isObj(parsed.models) ? parsed.models : {};
  return Object.entries(models).filter(([, m]) => isObj(m) && m.provider === provider).map(([id]) => id);
}

async function syncOpencodeFolder(dir: string, opts: SyncOptions): Promise<FolderResult[]> {
  const file = join(dir, "opencode.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let config: Json;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObj(parsed)) throw new Error("not an object");
    config = parsed;
  } catch (e) {
    return [{ dir, file, provider: "?", status: "failed", fileIds: [], error: `opencode.json: ${errText(e)}` }];
  }
  const env = opts.env ?? process.env;
  const results: FolderResult[] = [];
  let changed = false;
  for (const p of opencodeGatewayProviders(config)) {
    const entry = (config.provider as Json)[p.name] as Json;
    const old = entry.models as Json;
    const fileIds = Object.keys(old);
    try {
      const key = await resolveOpencodeValue(p.apiKey, dir, env);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.headers)) headers[k] = await resolveOpencodeValue(v, dir, env);
      const models = await fetchGatewayModels(await resolveOpencodeValue(p.baseUrl, dir, env), key, headers, opts);
      const map = opencodeModelsMap(old, models);
      const same = JSON.stringify(map) === JSON.stringify(old);
      if (!same) {
        entry.models = map;
        changed = true;
      }
      results.push({ dir, file, provider: p.name, status: same ? "current" : "updated", gatewayIds: models.map((m) => m.id), fileIds });
    } catch (e) {
      results.push({ dir, file, provider: p.name, status: "failed", fileIds, error: errText(e) });
    }
  }
  if (!opts.check && changed) await writeKeepingMode(file, `${JSON.stringify(config, null, 2)}\n`);
  return results;
}

/** The ZCode personal provider config rules that point at an HTTP base with a key AIS can read. */
export function zcodeGatewayProviders(config: Json): { providerId: string; baseUrl: string; apiKey: string }[] {
  const inner = isObj(config.config) ? config.config : {};
  const rulesRoot = isObj(inner.providerConfigRules) ? inner.providerConfigRules : {};
  const rules = Array.isArray(rulesRoot.providerRules) ? rulesRoot.providerRules : [];
  const out: { providerId: string; baseUrl: string; apiKey: string }[] = [];
  for (const r of rules) {
    if (!isObj(r)) continue;
    const providerId = str(r.providerId);
    const rc = isObj(r.config) ? r.config : {};
    const api = isObj(rc.api) ? rc.api : {};
    const access = isObj(rc.access) ? rc.access : {};
    const baseUrl = str(api.baseUrl);
    const apiKey = str(access.apiKey);
    if (providerId && baseUrl && apiKey) out.push({ providerId, baseUrl, apiKey });
  }
  return out;
}

/** The `personalModelIds` a ZCode provider rule lists now. */
export function zcodeModelIds(config: Json, providerId: string): string[] {
  const inner = isObj(config.config) ? config.config : {};
  const rulesRoot = isObj(inner.providerConfigRules) ? inner.providerConfigRules : {};
  const rules = Array.isArray(rulesRoot.providerRules) ? rulesRoot.providerRules : [];
  for (const r of rules) {
    if (!isObj(r) || r.providerId !== providerId) continue;
    const rc = isObj(r.config) ? r.config : {};
    return Array.isArray(rc.personalModelIds) ? rc.personalModelIds.filter((x): x is string => typeof x === "string") : [];
  }
  return [];
}

/**
 * New ZCode config whose gateway provider lists exactly `models` (gateway order). `personalModelIds` and `modelOrder`
 * become the gateway ids. The provider's `providerModelRules` gain one entry per model: a rule that stays keeps its keys
 * (its `contextWindow` follows the gateway when the gateway gives one), a new model gets the gateway's context and output
 * limits when present. Rules of other providers, `manualProviderModelRules` and every other key stay. A
 * `defaultModelSelection` naming a model that is gone moves to the first gateway model. Idempotent.
 */
export function transformZcodeConfig(config: Json, providerId: string, models: GatewayModel[]): Json {
  const ids = models.map((m) => m.id);
  const served = new Set(ids);
  const out: Json = { ...config };
  const inner: Json = isObj(out.config) ? { ...out.config } : {};

  const rulesRoot: Json = isObj(inner.providerConfigRules) ? { ...inner.providerConfigRules } : {};
  const rules = Array.isArray(rulesRoot.providerRules) ? rulesRoot.providerRules : [];
  rulesRoot.providerRules = rules.map((r) => {
    if (!isObj(r) || r.providerId !== providerId) return r;
    const rc: Json = isObj(r.config) ? { ...r.config } : {};
    rc.personalModelIds = [...ids];
    rc.modelOrder = [...ids];
    return { ...r, config: rc };
  });
  inner.providerConfigRules = rulesRoot;

  const modelRoot: Json = isObj(inner.modelConfigRules) ? { ...inner.modelConfigRules } : {};
  const oldRules = Array.isArray(modelRoot.providerModelRules) ? modelRoot.providerModelRules : [];
  const otherRules = oldRules.filter((r) => isObj(r) && r.providerId !== providerId);
  const ownRules = models.map((m) => {
    const old = oldRules.find((r) => isObj(r) && r.providerId === providerId && r.modelId === m.id);
    if (isObj(old)) {
      const oc: Json = isObj(old.config) ? { ...old.config } : {};
      if (m.contextLength) oc.properties = { ...(isObj(oc.properties) ? oc.properties : {}), contextWindow: m.contextLength };
      return { ...old, config: oc };
    }
    const nc: Json = {};
    if (m.contextLength) nc.properties = { contextWindow: m.contextLength };
    if (m.maxOutput) nc.optionSpecs = { maxOutputTokens: { max: m.maxOutput } };
    return { modelId: m.id, providerId, config: nc };
  });
  modelRoot.providerModelRules = [...otherRules, ...ownRules];
  inner.modelConfigRules = modelRoot;

  const dms = isObj(inner.defaultModelSelection) ? { ...inner.defaultModelSelection } : undefined;
  if (dms && dms.providerId === providerId && typeof dms.modelId === "string" && !served.has(dms.modelId) && models.length > 0) {
    dms.modelId = models[0]!.id;
    inner.defaultModelSelection = dms;
  }
  out.config = inner;
  return out;
}

/**
 * The ZCode personal provider config path a launcher exports (`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`), with `$HOME` and
 * `~` expanded. Undefined when the launcher does not name one (it is not a ZCode launcher).
 */
export function zcodeConfigPathFromLauncher(launcherText: string, home: string): string | undefined {
  const m = /ZCODE_PERSONAL_PROVIDER_CONFIG_FILE\s*=\s*["']?([^"'\s]+)/.exec(launcherText);
  if (!m) return undefined;
  let p = m[1]!.replace(/\$\{HOME\}|\$HOME/g, home);
  if (p.startsWith("~/")) p = join(home, p.slice(2));
  return isAbsolute(p) ? p : undefined;
}

const shUnquote = (s: string): string => s.slice(1, -1).replace(/'\\''/g, "'");

/** The original launcher a generated ZCode launcher records, or undefined when the text is not one. */
export function zcodeLauncherOriginal(text: string): string | undefined {
  if (!text.includes("Written by `ais gateway t3-acp`")) return undefined;
  const m = /^ORIGINAL=('(?:[^']|'\\'')*')\s*$/m.exec(text);
  return m ? shUnquote(m[1]!) : undefined;
}

/**
 * The ZCode personal provider config path the launcher at `commandPath` names. A launcher written by this module names
 * none itself: the path comes from the original launcher it records.
 */
export async function zcodeConfigPathFromCommand(commandPath: string, home: string): Promise<string | undefined> {
  let path = commandPath;
  for (let hop = 0; hop < 2; hop++) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    const found = zcodeConfigPathFromLauncher(text, home);
    if (found) return found;
    const original = zcodeLauncherOriginal(text);
    if (!original) return undefined;
    path = original;
  }
  return undefined;
}

async function syncZcodeConfigFile(file: string, opts: SyncOptions): Promise<FolderResult[]> {
  const dir = dirname(file);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let config: Json;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObj(parsed)) throw new Error("not an object");
    config = parsed;
  } catch (e) {
    return [{ dir, file, provider: "?", status: "failed", fileIds: [], error: `${file}: ${errText(e)}` }];
  }
  const results: FolderResult[] = [];
  let changed = false;
  for (const p of zcodeGatewayProviders(config)) {
    const fileIds = zcodeModelIds(config, p.providerId);
    try {
      const models = await fetchGatewayModels(p.baseUrl, p.apiKey, {}, opts);
      const next = transformZcodeConfig(config, p.providerId, models);
      const same = JSON.stringify(next) === JSON.stringify(config);
      if (!same) {
        config = next;
        changed = true;
      }
      results.push({ dir, file, provider: p.providerId, status: same ? "current" : "updated", gatewayIds: models.map((m) => m.id), fileIds });
    } catch (e) {
      results.push({ dir, file, provider: p.providerId, status: "failed", fileIds, error: errText(e) });
    }
  }
  if (!opts.check && changed) await writeKeepingMode(file, `${JSON.stringify(config, null, 2)}\n`);
  return results;
}

/**
 * ZCode ACP instances list only the models their personal provider config names. Find each instance's launcher in T3
 * Code's settings.json, read the config path it exports, and sync that file. Settings or a launcher that cannot be read
 * changes nothing. grok-build and glm-acp-agent launchers name no ZCode config, so they are left alone.
 */
async function syncZcodeAcpInstances(opts: SyncOptions): Promise<FolderResult[]> {
  const home = opts.home ?? homedir();
  const t3Home = t3Paths({ ...(opts.home ? { home: opts.home } : {}), ...(opts.env ? { env: opts.env } : {}) }).t3Home;
  let settings: Json;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(t3Home, "userdata", "settings.json"), "utf8"));
    if (!isObj(parsed)) return [];
    settings = parsed;
  } catch {
    return [];
  }
  const instances = isObj(settings.providerInstances) ? settings.providerInstances : {};
  const results: FolderResult[] = [];
  const seen = new Set<string>();
  for (const inst of Object.values(instances)) {
    if (!isObj(inst) || inst.driver !== "acpRegistry") continue;
    const commandPath = str(isObj(inst.config) ? inst.config.commandPath : undefined);
    if (!commandPath) continue;
    const file = await zcodeConfigPathFromCommand(commandPath, home);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    results.push(...(await syncZcodeConfigFile(file, opts)));
  }
  return results;
}

/** Every T3 gateway folder's model lists, synced (or checked) against the gateway. No folders: empty result. */
export async function syncT3GatewayModels(opts: SyncOptions = {}): Promise<FolderResult[]> {
  const root = join(t3Paths({ ...(opts.home ? { home: opts.home } : {}), ...(opts.env ? { env: opts.env } : {}) }).t3Home, "gateway");
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    names = [];
  }
  const results: FolderResult[] = [];
  for (const name of names) {
    const dir = join(root, name);
    results.push(...(await syncKimiFolder(dir, opts)), ...(await syncOpencodeFolder(dir, opts)));
  }
  results.push(...(await syncZcodeAcpInstances(opts)));
  return results;
}

/** One line per folder/provider; never prints a key. */
export function describeResult(r: FolderResult, check = false): string {
  const where = `${r.dir} [${r.provider}]`;
  if (r.status === "failed") return `${where}: failed, ${r.error ?? "unknown error"} (file left as it is)`;
  const n = r.gatewayIds?.length ?? 0;
  if (r.status === "current") return `${where}: current (${n} models)`;
  const gw = new Set(r.gatewayIds ?? []);
  const file = new Set(r.fileIds);
  const added = [...gw].filter((id) => !file.has(id));
  const removed = [...file].filter((id) => !gw.has(id));
  const delta = [added.length ? `+${added.join(",")}` : "", removed.length ? `-${removed.join(",")}` : ""].filter(Boolean).join(" ");
  return `${where}: ${check ? "out of date" : "updated"} (${n} models${delta ? `; ${delta}` : "; details changed"})`;
}
