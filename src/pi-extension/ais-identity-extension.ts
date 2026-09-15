/**
 * AIS identity extension for Pi (@earendil-works/pi-coding-agent).
 *
 * Installed and kept current by the `ais pi` wrapper (see
 * src/identities/pi-extension-install.ts) into
 * `$PI_CODING_AGENT_DIR/extensions/ais-identity.ts`, which Pi auto-discovers
 * and loads via jiti (TypeScript needs no compilation). This file must stay a
 * self-contained single module: the installed copy cannot resolve sibling
 * imports. Runtime imports are node: builtins plus `@earendil-works/pi-ai`,
 * which Pi's extension loader aliases to its OWN bundled copy in every
 * runtime mode (dist/core/extensions/loader.js), so the version always
 * matches the running pi.
 *
 * SINGLE-INSTANCE MODE (v2, 2026-09-13): pi no longer proxies per AIS
 * identity. One shared pi instance exposes EVERY identity from
 * ~/.pi/identities.json: each (identity, provider) credential becomes a
 * namespaced provider `<provider>--<identity>` registered from pi-ai's own
 * built-in catalogue (or the identity's models.json for custom providers),
 * with auth resolved LIVE from the source identity's auth.json on every
 * request. OAuth refreshes are performed by the native provider's own
 * refresh logic and written back into the SOURCE identity's auth.json, so
 * AIS's one-credential-per-(identity, provider) attribution law holds and
 * whole-identity switching no longer requires a relaunch.
 *
 * What it provides:
 * - A persistent footer status (`ctx.ui.setStatus`) showing the AIS identity
 *   LABEL (e.g. "Personal", not "personal"), provider and model in use.
 * - `/ais` - an INTERACTIVE SWITCHER: pick an identity (by display label),
 *   then pick one of its models; the session switches immediately.
 * - `/ais show` - the context widget panel: active identity, its providers,
 *   credential types, model counts and honest gap notes.
 * - `/ais use [<identity> ]<provider>[/<model>]` - non-interactive switch.
 * - `/ais identities` - the identity table (labels + launch commands).
 * - Model persistence: every model selection is written into the instance's
 *   settings.json as defaultProvider/defaultModel, so pi NATIVELY restores
 *   the last-used model on the next launch (pi only saved those via Ctrl+S
 *   in /model before; a one-off `--model` flag does not overwrite them).
 * - Default-identity seeding: wrapper marker env (flag/env/directory match)
 *   > persisted last active identity > extension-side directory match >
 *   first registry identity.
 */

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { stream as compatStream, streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

/** Version stamp the installer matches against; bump to force a refresh of
 * installed copies on next launch. */
export const AIS_EXTENSION_VERSION = "2.0.0";

export const STATUS_KEY = "ais";
export const WIDGET_KEY = "ais";

/** AIS sets this on the wrapper's spawned child only
 * (src/shared/exec.ts IDENTITY_SESSION_MARKER). */
const IDENTITY_ENV_VAR = "AI_PROFILE_SWITCHER_SESSION";

/** AIS's complete-profile boundary for Pi (src/identities/tool-configs.ts). */
const CONFIG_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

/** Separator between base provider id and identity name in namespaced
 * provider ids: `anthropic--personal`. Base provider ids and identity names
 * ([a-z0-9]+(-[a-z0-9]+)*) never contain a double hyphen. */
export const NS_SEPARATOR = "--";

/** Refresh an OAuth credential this far before its stated expiry, so a
 * long request never starts on a token that dies mid-flight. */
export const REFRESH_WINDOW_MS = 120_000;

export interface AiModel {
  id: string;
  provider: string;
  name?: string;
}

/** A registered model object: pi's full Model shape carries api/baseUrl/cost
 * etc.; the index signature keeps custom-catalogue literals honest without
 * modelling all of pi-ai's types locally. */
export interface RegisteredModel extends AiModel {
  [key: string]: unknown;
}

interface ModelRegistrySubset {
  getAvailable(): AiModel[];
  find(provider: string, modelId: string): AiModel | undefined;
  hasConfiguredAuth(model: AiModel): boolean;
  getProviderDisplayName(provider: string): string;
}

interface UiSubset {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: readonly string[] | undefined): void;
  select?(title: string, options: string[]): Promise<string | undefined>;
}

export interface ExtensionContextSubset {
  hasUI: boolean;
  cwd?: string;
  model: AiModel | undefined;
  modelRegistry: ModelRegistrySubset;
  ui: UiSubset;
}

interface RegisteredCommandSubset {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: ExtensionContextSubset) => void | Promise<void>;
}

export interface ExtensionApiSubset {
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContextSubset) => void | Promise<void>): void;
  on(
    event: "model_select",
    handler: (event: { model: AiModel }, ctx: ExtensionContextSubset) => void | Promise<void>,
  ): void;
  registerCommand(name: string, options: RegisteredCommandSubset): void;
  registerProvider(provider: unknown): void;
  setModel(model: AiModel): Promise<boolean>;
}

export interface AuthCredential {
  type?: string;
  [key: string]: unknown;
}

export type AuthMap = Record<string, AuthCredential>;

/** Providers Pi can speak for which AIS holds no credential of its own, so a
 * missing auth.json entry is a known, explainable gap rather than an
 * oversight. AWS Bedrock auth rides the ambient AWS credential chain (SSO or
 * keys); AIS's aws-profile.ts is reporting-only by design. */
export const KNOWN_PROVIDER_GAPS: Record<string, string> = {
  "amazon-bedrock": "uses the ambient AWS credential chain; AIS holds no Bedrock credential to sync",
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function instanceConfigDir(env: Record<string, string | undefined> = process.env): string {
  const configDir = env[CONFIG_DIR_ENV_VAR];
  return configDir && configDir.length > 0 ? configDir : `${env.HOME ?? homedir()}/.pi/agent`;
}

function authPath(): string {
  return `${instanceConfigDir()}/auth.json`;
}

function settingsPath(): string {
  return `${instanceConfigDir()}/settings.json`;
}

function statePath(): string {
  return `${instanceConfigDir()}/ais-state.json`;
}

export function identitiesRegistryPath(env: Record<string, string | undefined> = process.env): string {
  return `${env.HOME ?? homedir()}/.pi/identities.json`;
}

// ---------------------------------------------------------------------------
// Namespacing
// ---------------------------------------------------------------------------

/** Pure: `<provider>--<identityName>` - the provider id an identity's
 * credential is exposed under in the shared instance. */
export function namespacedProviderId(provider: string, identityName: string): string {
  return `${provider}${NS_SEPARATOR}${identityName}`;
}

/** Pure: inverse of namespacedProviderId. Splits on the LAST separator: base
 * provider ids never contain "--", identity names never contain "--". */
export function parseNamespacedProviderId(id: string): { provider: string; identityName: string } | undefined {
  const index = id.lastIndexOf(NS_SEPARATOR);
  if (index <= 0 || index + NS_SEPARATOR.length >= id.length) return undefined;
  return { provider: id.slice(0, index), identityName: id.slice(index + NS_SEPARATOR.length) };
}

/** Pure: the base provider id for display ("anthropic" for
 * "anthropic--personal"; unchanged for native providers). */
export function baseProviderOf(providerId: string): string {
  return parseNamespacedProviderId(providerId)?.provider ?? providerId;
}

// ---------------------------------------------------------------------------
// Registry + directory matching
// ---------------------------------------------------------------------------

export interface RegistryIdentity {
  name: string;
  label: string;
  configDir: string;
  directories?: string[];
  aliases?: string[];
}

export interface IdentityListing {
  name: string;
  label: string;
  configDir: string;
  current: boolean;
}

/** Pure: rows for /ais identities from the AIS Pi registry
 * (~/.pi/identities.json, version 1 shape). */
export function buildIdentityListings(
  registry: unknown,
  activeIdentity: string | undefined,
): { listings: IdentityListing[]; note?: string } {
  const identities = parseRegistryIdentities(registry);
  if (identities === undefined) {
    if (typeof registry !== "object" || registry === null) {
      return { listings: [], note: "AIS Pi registry not readable - cannot list identities" };
    }
    return { listings: [], note: "AIS Pi registry has an unexpected shape - cannot list identities" };
  }
  return {
    listings: identities.map((identity) => ({
      name: identity.name,
      label: identity.label,
      configDir: identity.configDir,
      current: identity.name === activeIdentity,
    })),
  };
}

/** Pure: parse the registry file into identities. Returns undefined when the
 * file is missing/unreadable/badly shaped (callers render honest notes). */
export function parseRegistryIdentities(registry: unknown): RegistryIdentity[] | undefined {
  if (typeof registry !== "object" || registry === null) return undefined;
  const file = registry as { version?: unknown; identities?: unknown };
  if (file.version !== 1 || !Array.isArray(file.identities)) return undefined;
  const identities: RegistryIdentity[] = [];
  for (const raw of file.identities) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as {
      name?: unknown;
      label?: unknown;
      configDir?: unknown;
      directories?: unknown;
      aliases?: unknown;
    };
    if (typeof entry.name !== "string" || typeof entry.configDir !== "string") continue;
    identities.push({
      name: entry.name,
      label: typeof entry.label === "string" && entry.label.length > 0 ? entry.label : entry.name,
      configDir: entry.configDir,
      ...(Array.isArray(entry.directories)
        ? { directories: entry.directories.filter((d): d is string => typeof d === "string") }
        : {}),
      ...(Array.isArray(entry.aliases)
        ? { aliases: entry.aliases.filter((a): a is string => typeof a === "string") }
        : {}),
    });
  }
  return identities;
}

/** Pure: the display label for an identity name (the REAL label from the
 * registry - "Personal", not "personal"); falls back to the name itself. */
export function identityLabelFor(identities: readonly RegistryIdentity[], name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return identities.find((identity) => identity.name === name)?.label ?? name;
}

function expandTilde(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolvePath(home, raw.slice(2));
  return raw;
}

/** Same canonicalisation as src/identities/match.ts's normalizePath:
 * tilde-expand, resolve, realpath-if-exists (best effort), strip trailing
 * slash. realpathSync failures fall back to the lexical path. */
export function normalizeDirPath(raw: string, home: string): string {
  const expanded = expandTilde(raw, home);
  const absolute = isAbsolute(expanded) ? expanded : resolvePath(expanded);
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    canonical = absolute;
  }
  return canonical.length > 1 && canonical.endsWith("/") ? canonical.slice(0, -1) : canonical;
}

/** Pure: AIS directory-pattern grammar (src/identities/match.ts): no "*" is
 * an exact match; a trailing "/*" segment matches that directory and
 * everything beneath it. Most-specific (longest canonical base) match wins;
 * ties resolve to the first declared identity. Anything else never matches. */
export function matchIdentityForCwd(
  identities: readonly RegistryIdentity[],
  cwd: string,
  home: string,
): RegistryIdentity | undefined {
  const target = normalizeDirPath(cwd, home);
  let best: { identity: RegistryIdentity; baseLength: number } | undefined;
  for (const identity of identities) {
    for (const raw of identity.directories ?? []) {
      let base: string;
      let recursive: boolean;
      if (raw.endsWith("/*") && raw.indexOf("*") === raw.length - 1) {
        base = normalizeDirPath(raw.slice(0, -2) || "/", home);
        recursive = true;
      } else if (!raw.includes("*")) {
        base = normalizeDirPath(raw, home);
        recursive = false;
      } else {
        continue;
      }
      const matches = recursive ? target === base || target.startsWith(`${base}/`) : target === base;
      if (matches && (best === undefined || base.length > best.baseLength)) {
        best = { identity, baseLength: base.length };
      }
    }
  }
  return best?.identity;
}

/** Pure: startup default-identity chain: wrapper marker (flag/env/dir match,
 * only when it names a registry identity) > persisted last active identity
 * (only when still registered) > extension-side directory match > first
 * registry identity. */
export function pickDefaultIdentityName(inputs: {
  identities: readonly RegistryIdentity[];
  envMarker: string | undefined;
  persisted: string | undefined;
  cwdMatch: string | undefined;
}): string | undefined {
  const known = new Set(inputs.identities.map((identity) => identity.name));
  if (inputs.envMarker !== undefined && known.has(inputs.envMarker)) return inputs.envMarker;
  if (inputs.persisted !== undefined && known.has(inputs.persisted)) return inputs.persisted;
  if (inputs.cwdMatch !== undefined && known.has(inputs.cwdMatch)) return inputs.cwdMatch;
  return inputs.identities[0]?.name;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface OAuthCredentialShape {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
}

interface ApiKeyCredentialShape {
  type: "api_key";
  key: string;
}

export type CredentialShape = OAuthCredentialShape | ApiKeyCredentialShape;

/** Reads an auth.json into a provider -> credential map. A missing or
 * invalid file is an empty map, never a crash. Values are never exposed by
 * any rendering path, only key names and credential types. */
export function readAuthMap(path: string): AuthMap {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as AuthMap;
  } catch {
    return {};
  }
}

/** Pure: narrow an auth.json entry to the credential shape the resolver
 * needs; anything else is "no usable credential" (undefined). */
export function asCredential(entry: AuthCredential | undefined): CredentialShape | undefined {
  if (!entry) return undefined;
  if (entry.type === "oauth") {
    const { access, refresh, expires } = entry as { access?: unknown; refresh?: unknown; expires?: unknown };
    if (typeof access !== "string" || typeof refresh !== "string") return undefined;
    return { type: "oauth", access, refresh, expires: typeof expires === "number" ? expires : 0 };
  }
  if (entry.type === "api_key") {
    const { key } = entry as { key?: unknown };
    if (typeof key !== "string") return undefined;
    return { type: "api_key", key };
  }
  return undefined;
}

/** Pure: should this OAuth credential be refreshed before use? A missing/0
 * expiry means "unknown lifetime" - serve as-is and let the provider's own
 * error path (and the next launch's reconcile) handle it. */
export function needsCredentialRefresh(credential: CredentialShape, now: number): boolean {
  return (
    credential.type === "oauth" &&
    typeof credential.expires === "number" &&
    credential.expires > 0 &&
    credential.expires - now < REFRESH_WINDOW_MS
  );
}

/** Atomic JSON write: temp file in the destination directory + rename, so a
 * crash mid-write can never leave a truncated credential/config file. */
function writeJsonAtomic(path: string, data: unknown, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.ais-ext-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // best effort
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Instance state + settings (last-used-model persistence)
// ---------------------------------------------------------------------------

export interface AisState {
  activeIdentity?: string;
  /** Per-identity last selected model, keyed by identity name. */
  lastModel?: Record<string, { provider: string; id: string }>;
}

export function readAisState(path: string): AisState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AisState;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Pure: settings.json content with defaultProvider/defaultModel set to the
 * last-used model, preserving every other key. This is pi's OWN startup
 * default mechanism (docs/settings.md) - writing it on every model selection
 * is what makes pi remember the last-used model across launches. */
export function settingsWithDefaultModel(existing: unknown, model: AiModel): string {
  let settings: Record<string, unknown> = {};
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    settings = { ...(existing as Record<string, unknown>) };
  }
  settings.defaultProvider = model.provider;
  settings.defaultModel = model.id;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function readSettingsRaw(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Provider table rendering (context panel)
// ---------------------------------------------------------------------------

export interface ProviderRow {
  provider: string;
  display: string;
  credential: string;
  models: number;
  current: boolean;
  note?: string;
}

/** Pure: builds the per-provider table rows for /ais show from the ACTIVE
 * identity's credentials plus the models registered for it in this instance.
 * Only model COUNTS and names are surfaced; credential values stay in the
 * identity's auth.json. */
export function buildProviderRows(
  auth: AuthMap,
  available: readonly AiModel[],
  current: AiModel | undefined,
  displayName: (provider: string) => string,
): ProviderRow[] {
  const counts = new Map<string, number>();
  for (const model of available) {
    const base = baseProviderOf(model.provider);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const providers = new Set<string>([...Object.keys(auth), ...counts.keys()]);
  const rows: ProviderRow[] = [];
  for (const provider of [...providers].sort()) {
    const credential = auth[provider];
    const modelCount = counts.get(provider) ?? 0;
    const isCurrent = current !== undefined && baseProviderOf(current.provider) === provider;
    let note: string | undefined;
    if (!credential && isCurrent) note = "active via environment or provider defaults";
    else if (!credential) note = KNOWN_PROVIDER_GAPS[provider] ?? "no credential in auth.json";
    else if (modelCount === 0) note = "credential present but no models in Pi's catalogue";
    rows.push({
      provider,
      display: displayName(provider),
      credential: credentialType(credential),
      models: modelCount,
      current: isCurrent,
      ...(note !== undefined ? { note } : {}),
    });
  }
  return rows;
}

function credentialType(credential: AuthCredential | undefined): string {
  if (!credential) return "-";
  if (credential.type === "oauth") return "oauth";
  if (credential.type === "api_key") return "api key";
  return typeof credential.type === "string" ? credential.type : "unknown";
}

/** Pure: fixed-width table rendering (plain text; the widget trims to the
 * terminal width itself). */
export function formatProviderTable(rows: readonly ProviderRow[], current: AiModel | undefined): string[] {
  const header = ["PROVIDER", "CREDENTIAL", "MODELS", "NOTE"];
  const ordered = [...rows].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.provider.localeCompare(b.provider);
  });
  const body = ordered.map((row) => [
    `${row.current ? "> " : "  "}${row.provider}`,
    row.credential,
    row.models > 0 ? String(row.models) : "0",
    row.note ?? (row.current ? `in use: ${current?.id ?? ""}` : ""),
  ]);
  return formatTable(header, body);
}

/** Pure: generic fixed-width table. Exported for tests. */
export function formatTable(header: readonly string[], body: readonly (readonly string[])[]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [line(header), separator, ...body.map(line)];
}

export function formatIdentityTable(listings: readonly IdentityListing[]): string[] {
  const header = ["IDENTITY", "LABEL", "LAUNCH COMMAND"];
  const body = listings.map((listing) => [
    `${listing.current ? "> " : "  "}${listing.name}`,
    listing.label,
    `ais pi --identity=${listing.name}`,
  ]);
  return formatTable(header, body);
}

// ---------------------------------------------------------------------------
// /ais use parsing + model resolution
// ---------------------------------------------------------------------------

export type UseTarget =
  | { identity?: string; provider: string; modelId?: string }
  | { error: string };

/** Pure: parse a `/ais use` argument. Accepted forms:
 *   <provider>                     first model of provider (active identity first)
 *   <provider>/<model>             exact/partial model of provider
 *   <identity> <provider>[/<model>]  identity-scoped switch
 *   <provider>--<identity>[/<model>] fully namespaced provider id
 * An identity token is recognised by name or alias (caller passes the known
 * identity keys). */
export function parseUseTarget(args: string, identityKeys: readonly string[] = []): UseTarget {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return {
      error:
        "usage: /ais use [<identity> ]<provider>[/<model>] " +
        "(example: /ais use zai/glm-4.6, or /ais use personal anthropic/claude-opus-5)",
    };
  }
  const tokens = trimmed.split(/\s+/);
  let identity: string | undefined;
  let providerPart = tokens[0] ?? "";
  if (tokens.length > 1) {
    if (identityKeys.includes(tokens[0] as string)) {
      identity = tokens[0];
      providerPart = tokens[1] as string;
    } else {
      return { error: `unknown /ais use argument "${tokens.slice(1).join(" ")}" (identity, provider or provider/model expected)` };
    }
  }
  const namespaced = parseNamespacedProviderId(providerPart.split("/", 1)[0] ?? "");
  if (identity === undefined && namespaced !== undefined && identityKeys.includes(namespaced.identityName)) {
    identity = namespaced.identityName;
    providerPart = `${namespaced.provider}${providerPart.includes("/") ? providerPart.slice(providerPart.indexOf("/")) : ""}`;
  }
  const slash = providerPart.indexOf("/");
  const provider = (slash === -1 ? providerPart : providerPart.slice(0, slash)).trim();
  const modelId = slash === -1 ? "" : providerPart.slice(slash + 1).trim();
  if (provider.length === 0) return { error: "provider name is empty" };
  return {
    ...(identity !== undefined ? { identity } : {}),
    provider,
    ...(modelId.length > 0 ? { modelId } : {}),
  };
}

/** Pure: pick a model from a catalogue: exact id wins, then substring match,
 * then the first model. Empty catalogue -> undefined. */
export function findModelInCatalog(
  catalog: readonly AiModel[],
  provider: string | undefined,
  modelId: string | undefined,
): AiModel | undefined {
  const scoped = provider === undefined ? catalog : catalog.filter((model) => baseProviderOf(model.provider) === provider);
  if (scoped.length === 0) return undefined;
  if (modelId !== undefined) {
    const exact = scoped.find((model) => model.id === modelId);
    if (exact) return exact;
    const partial = scoped.find((model) => model.id.includes(modelId));
    if (partial) return partial;
    return undefined;
  }
  return scoped[0];
}

/** Pure: legacy resolver over pi's own registry (native providers), kept for
 * `/ais use` on non-AIS providers. */
export function resolveModel(
  target: { provider: string; modelId?: string },
  registry: ModelRegistrySubset,
): { model: AiModel } | { error: string } {
  if (target.modelId !== undefined) {
    const exact = registry.find(target.provider, target.modelId);
    if (exact) return { model: exact };
    const partial = registry
      .getAvailable()
      .find((model) => model.provider === target.provider && model.id.includes(target.modelId as string));
    if (partial) return { model: partial };
    return { error: `no model matching "${target.modelId}" for provider "${target.provider}" in Pi's catalogue` };
  }
  const first = registry.getAvailable().find((model) => model.provider === target.provider);
  if (!first) {
    return {
      error:
        `no models for provider "${target.provider}" in Pi's catalogue` +
        (KNOWN_PROVIDER_GAPS[target.provider] !== undefined ? ` (${KNOWN_PROVIDER_GAPS[target.provider]})` : ""),
    };
  }
  return { model: first };
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export function currentIdentityName(): string | undefined {
  const value = process.env[IDENTITY_ENV_VAR];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Pure: footer status. Uses the identity's REAL display label ("Personal",
 * not "personal") and shows the base provider for namespaced models. */
export function statusLine(identityLabel: string | undefined, model: AiModel | undefined): string {
  const target = model ? `${baseProviderOf(model.provider)}/${model.id}` : "no model selected";
  return identityLabel ? `ais ${identityLabel}: ${target}` : `ais: ${target} (no AIS identity resolved)`;
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/** Structural subset of a pi-ai built-in Provider - what the clone needs. */
interface NativeProviderSubset {
  id: string;
  name: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: {
    apiKey?: {
      name: string;
      resolve(input: { ctx: unknown; credential?: unknown; signal: AbortSignal }): Promise<unknown>;
    };
    oauth?: {
      name: string;
      refresh(credential: never, signal: AbortSignal): Promise<never>;
      toAuth(credential: never): Promise<{ apiKey?: string; headers?: Record<string, string>; baseUrl?: string }>;
    };
  };
  getModels(): AiModel[];
  filterModels?(models: AiModel[], credential: unknown): AiModel[];
  stream(model: AiModel, context: unknown, options?: unknown): unknown;
  streamSimple(model: AiModel, context: unknown, options?: unknown): unknown;
}

interface CustomProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
}

export interface ExtensionDeps {
  readAuth?: () => AuthMap;
  readRegistry?: () => unknown;
  identityName?: () => string | undefined;
  /** Read one identity's auth.json (defaults to the real configDir path). */
  readIdentityAuth?: (configDir: string) => AuthMap;
  /** Read one identity's models.json custom-provider catalogue. */
  readIdentityModels?: (configDir: string) => Record<string, CustomProviderConfig>;
  /** Built-in provider catalogue (defaults to pi-ai's builtinProviders). */
  natives?: () => NativeProviderSubset[];
  writeJson?: (path: string, data: unknown, mode: number) => void;
  readJson?: (path: string) => unknown;
  now?: () => number;
  cwd?: () => string;
  argv?: string[];
  home?: () => string;
}

function defaultReadIdentityModels(configDir: string): Record<string, CustomProviderConfig> {
  try {
    const parsed = JSON.parse(readFileSync(`${configDir}/models.json`, "utf8")) as { providers?: unknown };
    if (typeof parsed.providers !== "object" || parsed.providers === null) return {};
    return parsed.providers as Record<string, CustomProviderConfig>;
  } catch {
    return {};
  }
}

/** Resolve `$ENV_VAR` / `${ENV_VAR}` references in a models.json apiKey
 * value (the subset of pi's config value syntax custom catalogues use).
 * `!command` values are NOT supported here and resolve to undefined. */
export function interpolateConfigValue(
  raw: string,
  env: (name: string) => string | undefined,
): string | undefined {
  if (raw.startsWith("!")) return undefined;
  if (raw.startsWith("${") && raw.endsWith("}")) return env(raw.slice(2, -1));
  if (raw.startsWith("$")) return env(raw.slice(1));
  return raw;
}

/** The extension factory Pi calls. Exported default per Pi's extension
 * contract. ASYNC: pi awaits the factory before startup continues, so every
 * namespaced provider is registered before the model catalogue, the settings
 * default and `--list-models`-style reads are resolved. The optional second
 * argument exists purely for tests: jiti calls the factory with the Pi API
 * only, so production always uses the real environment and file readers -
 * unit tests inject fixtures and never touch live state. */
export default async function aisIdentityExtension(
  pi: ExtensionApiSubset,
  deps: ExtensionDeps = {},
): Promise<void> {
  const readRegistry = deps.readRegistry ?? (() => readJsonSafe(identitiesRegistryPath()));
  const identityName = deps.identityName ?? currentIdentityName;
  const readIdentityAuth = deps.readIdentityAuth ?? ((configDir: string) => readAuthMap(`${configDir}/auth.json`));
  const readIdentityModels = deps.readIdentityModels ?? defaultReadIdentityModels;
  const now = deps.now ?? (() => Date.now());
  const cwd = deps.cwd ?? (() => process.cwd());
  const argv = deps.argv ?? process.argv;
  const home = deps.home ?? (() => homedir());
  const writeJson = deps.writeJson ?? writeJsonAtomic;
  const readJson = deps.readJson ?? readJsonSafe;
  const readInstanceAuth = deps.readAuth ?? (() => readAuthMap(authPath()));

  const identities = parseRegistryIdentities(readRegistry()) ?? [];
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));

  /** Per-identity namespaced model catalogues registered in this instance. */
  const modelsByIdentity = new Map<string, AiModel[]>();
  /** Honest gap notes collected during registration (per identity). */
  const gapsByIdentity = new Map<string, string[]>();

  let activeIdentity: string | undefined;
  let knownProviders: string[] = [];
  /** Whether the /ais context panel is currently displayed: a later model
   * switch re-renders it so the table never shows a stale current row. */
  let contextWidgetShown = false;
  /** A one-off `--model` flag must not overwrite the persisted default. */
  let suppressSettingsPersist = argv.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="));
  /** Serialises OAuth refresh per (identity, provider) inside this process. */
  const refreshLocks = new Map<string, Promise<unknown>>();

  function readJsonSafe(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  function stateFile(): AisState {
    const raw = readJson(statePath());
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as AisState) : {};
  }

  function persistState(): void {
    try {
      const current = stateFile();
      const next: AisState = { ...current };
      if (activeIdentity !== undefined) next.activeIdentity = activeIdentity;
      writeJson(statePath(), next, 0o644);
    } catch {
      // State is a convenience; never break a session over it.
    }
  }

  function persistLastModel(model: AiModel): void {
    if (activeIdentity === undefined) return;
    try {
      const current = stateFile();
      const lastModel = { ...(current.lastModel ?? {}), [activeIdentity]: { provider: model.provider, id: model.id } };
      writeJson(statePath(), { ...current, activeIdentity, lastModel }, 0o644);
    } catch {
      // best effort
    }
  }

  // settingsWithDefaultModel is the pure source of truth for the merge;
  // writeJson takes data, so parse its output back here.
  function writeSettingsDefault(model: AiModel): void {
    try {
      writeJson(
        settingsPath(),
        JSON.parse(settingsWithDefaultModel(readJson(settingsPath()), model)) as Record<string, unknown>,
        0o644,
      );
    } catch {
      // never break a session over settings persistence
    }
  }

  // -- credential resolution (live, from the SOURCE identity's store) -------

  /** Read one (identity, provider) credential through the injected reader. */
  function readCred(identity: RegistryIdentity, provider: string): CredentialShape | undefined {
    return asCredential(readIdentityAuth(identity.configDir)[provider]);
  }

  /** Read-modify-write ONE provider key in an identity's auth.json (the
   * write-back half of the one-credential-per-(identity, provider) law: a
   * refresh performed for a namespaced provider lands in the SOURCE
   * identity's store, never the shared instance's). */
  function writeBackCredential(identity: RegistryIdentity, provider: string, credential: CredentialShape): void {
    const current = readIdentityAuth(identity.configDir);
    current[provider] = { ...credential } as AuthCredential;
    writeJson(`${identity.configDir}/auth.json`, current, 0o600);
  }

  const authContext = {
    env: async (name: string) => process.env[name],
    fileExists: async (path: string) => existsSync(path.startsWith("~/") ? `${home()}/${path.slice(2)}` : path),
  };

  async function resolveIdentityAuth(
    identity: RegistryIdentity,
    provider: string,
    native: NativeProviderSubset | undefined,
    custom: CustomProviderConfig | undefined,
    signal: AbortSignal,
  ): Promise<{ auth: Record<string, unknown>; source: string } | undefined> {
    const credential = readCred(identity, provider);
    const source = `AIS identity ${identity.label}`;
    if (!credential) return undefined;

    if (credential.type === "api_key") {
      if (native?.auth.apiKey) {
        const resolved = (await native.auth.apiKey.resolve({
          ctx: authContext,
          credential,
          signal,
        })) as { auth: Record<string, unknown>; source?: string } | undefined;
        return resolved ? { auth: resolved.auth, source: resolved.source ?? source } : undefined;
      }
      if (custom?.authHeader) {
        return { auth: { headers: { Authorization: `Bearer ${credential.key}` } }, source };
      }
      return { auth: { apiKey: credential.key }, source };
    }

    // OAuth: refresh through the NATIVE provider's own refresh logic and
    // write the rotated credential back into the SOURCE identity's auth.json
    // (never the shared instance's) - the attribution law.
    if (native?.auth.oauth) {
      const oauth = native.auth.oauth;
      const lockKey = `${identity.name}/${provider}`;
      const resolveFresh = async (): Promise<CredentialShape | undefined> => {
        let current = readCred(identity, provider);
        if (!current || current.type !== "oauth") return current;
        if (!needsCredentialRefresh(current, now())) return current;
        // Serialised refresh; re-read under the lock so a concurrent refresher
        // (another pi process, `ais auth refresh`) wins instead of doubling.
        const previous = refreshLocks.get(lockKey);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        refreshLocks.set(
          lockKey,
          (previous ?? Promise.resolve()).then(() => gate),
        );
        try {
          await previous;
          current = readCred(identity, provider);
          if (!current || current.type !== "oauth") return current;
          if (!needsCredentialRefresh(current, now())) return current;
          const refreshed = (await oauth.refresh(
            current as never,
            signal,
          )) as unknown as CredentialShape;
          writeBackCredential(identity, provider, refreshed);
          return refreshed;
        } catch (error) {
          // A rotated token may already be on disk (another process won the
          // race): re-read once before surfacing the failure.
          const reread = readCred(identity, provider);
          if (reread && reread.type === "oauth" && !needsCredentialRefresh(reread, now())) return reread;
          throw error;
        } finally {
          release();
        }
      };
      try {
        const fresh = await resolveFresh();
        if (!fresh || fresh.type !== "oauth") return undefined;
        const auth = (await oauth.toAuth(fresh as never)) as Record<string, unknown>;
        return { auth, source: `${source} (oauth)` };
      } catch {
        return undefined;
      }
    }

    // Custom-catalogue OAuth with no native refresh logic: serve the access
    // token while it is valid; an expired one is an honest gap.
    if (credential.type === "oauth") {
      if (needsCredentialRefresh(credential, now())) return undefined;
      if (custom?.authHeader) {
        return { auth: { headers: { Authorization: `Bearer ${credential.access}` } }, source };
      }
      return { auth: { apiKey: credential.access }, source };
    }
    return undefined;
  }

  // -- provider registration ------------------------------------------------

  function registerNativeClone(native: NativeProviderSubset, identity: RegistryIdentity, provider: string): void {
    const nsId = namespacedProviderId(provider, identity.name);
    const models = native.getModels().map((model) => ({ ...model, provider: nsId }));
    modelsByIdentity.set(identity.name, [...(modelsByIdentity.get(identity.name) ?? []), ...models]);
    pi.registerProvider({
      id: nsId,
      name: `${native.name} (${identity.label})`,
      ...(native.baseUrl !== undefined ? { baseUrl: native.baseUrl } : {}),
      ...(native.headers !== undefined ? { headers: native.headers } : {}),
      auth: {
        apiKey: {
          name: `AIS ${identity.label} credential`,
          resolve: (input: { ctx: unknown; credential?: unknown; signal: AbortSignal }) =>
            resolveIdentityAuth(identity, provider, native, undefined, input.signal),
        },
      },
      getModels: () => models,
      ...(native.filterModels
        ? {
            filterModels: (list: AiModel[]) => native.filterModels!(list, readCred(identity, provider)),
          }
        : {}),
      stream: (model: AiModel, context: unknown, options?: unknown) => native.stream(model, context, options),
      streamSimple: (model: AiModel, context: unknown, options?: unknown) =>
        native.streamSimple(model, context, options),
    });
  }

  function registerCustomClone(
    config: CustomProviderConfig,
    identity: RegistryIdentity,
    provider: string,
  ): boolean {
    const rawModels = Array.isArray(config.models) ? config.models : [];
    if (rawModels.length === 0) return false;
    const nsId = namespacedProviderId(provider, identity.name);
    const models: RegisteredModel[] = rawModels.map((raw) => ({
      id: String(raw.id ?? ""),
      provider: nsId,
      name: typeof raw.name === "string" ? raw.name : String(raw.id ?? ""),
      api: (raw.api as string | undefined) ?? config.api,
      baseUrl: (raw.baseUrl as string | undefined) ?? config.baseUrl,
      reasoning: raw.reasoning === true,
      input: Array.isArray(raw.input) ? raw.input : ["text"],
      cost: raw.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : 128000,
      maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : 4096,
      ...(raw.thinkingLevelMap !== undefined ? { thinkingLevelMap: raw.thinkingLevelMap } : {}),
      ...(raw.compat !== undefined ? { compat: raw.compat } : {}),
      ...(raw.headers !== undefined ? { headers: raw.headers } : {}),
    }));
    modelsByIdentity.set(identity.name, [...(modelsByIdentity.get(identity.name) ?? []), ...models]);
    const ambientKey =
      typeof config.apiKey === "string" ? interpolateConfigValue(config.apiKey, (name) => process.env[name]) : undefined;
    pi.registerProvider({
      id: nsId,
      name: `${config.name ?? provider} (${identity.label})`,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      auth: {
        apiKey: {
          name: `AIS ${identity.label} credential`,
          resolve: async (input: { signal: AbortSignal }) => {
            const resolved = await resolveIdentityAuth(identity, provider, undefined, config, input.signal);
            if (resolved) return resolved;
            if (ambientKey) {
              return config.authHeader
                ? { auth: { headers: { Authorization: `Bearer ${ambientKey}` } }, source: `${identity.label} models.json` }
                : { auth: { apiKey: ambientKey }, source: `${identity.label} models.json` };
            }
            return undefined;
          },
        },
      },
      getModels: () => models,
      stream: (model: AiModel, context: unknown, options?: unknown) =>
        (compatStream as (m: unknown, c: unknown, o?: unknown) => unknown)(model, context, options),
      streamSimple: (model: AiModel, context: unknown, options?: unknown) =>
        (compatStreamSimple as (m: unknown, c: unknown, o?: unknown) => unknown)(model, context, options),
    });
    return true;
  }

  function registerIdentityProviders(identity: RegistryIdentity, natives: Map<string, NativeProviderSubset>): void {
    const auth = readIdentityAuth(identity.configDir);
    const customs = readIdentityModels(identity.configDir);
    const gaps: string[] = [];
    for (const provider of Object.keys(auth).sort()) {
      const native = natives.get(provider);
      if (native) {
        registerNativeClone(native, identity, provider);
        continue;
      }
      if (customs[provider] !== undefined) {
        if (!registerCustomClone(customs[provider] as CustomProviderConfig, identity, provider)) {
          gaps.push(`${provider}: credential present but its models.json catalogue is empty`);
        }
        continue;
      }
      gaps.push(
        KNOWN_PROVIDER_GAPS[provider] !== undefined
          ? `${provider}: ${KNOWN_PROVIDER_GAPS[provider]}`
          : `${provider}: credential present but Pi has no catalogue for it (neither built-in nor models.json)`,
      );
    }
    for (const provider of Object.keys(customs).sort()) {
      if (auth[provider] === undefined && !natives.has(provider)) {
        // A custom catalogue with ambient/env auth can still work.
        const config = customs[provider] as CustomProviderConfig;
        if (typeof config.apiKey === "string") registerCustomClone(config, identity, provider);
      }
    }
    if (gaps.length > 0) gapsByIdentity.set(identity.name, gaps);
  }

  try {
    const natives = new Map<string, NativeProviderSubset>(
      (deps.natives ?? (builtinProviders as unknown as () => NativeProviderSubset[]))().map((provider) => [
        provider.id,
        provider,
      ]),
    );
    for (const identity of identities) {
      registerIdentityProviders(identity, natives);
    }
  } catch {
    // Registration failure must never take pi down: the commands below still
    // work against pi's own catalogue and say honestly what is missing.
  }

  // -- status / widgets ------------------------------------------------------

  const refreshKnownProviders = (ctx: ExtensionContextSubset): void => {
    try {
      knownProviders = [...new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider))].sort();
    } catch {
      knownProviders = [];
    }
  };

  const activeLabel = (): string | undefined => identityLabelFor(identities, activeIdentity);

  const showStatus = (ctx: ExtensionContextSubset, model: AiModel | undefined): void => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus(STATUS_KEY, statusLine(activeLabel(), model));
    } catch {
      // A status-line failure must never take the session down.
    }
  };

  const identityCatalog = (name: string | undefined): AiModel[] =>
    name === undefined ? [] : (modelsByIdentity.get(name) ?? []);

  /** Stable, unique option strings for the model picker. */
  const modelOption = (model: AiModel): string =>
    `${baseProviderOf(model.provider)}/${model.id}${model.name !== undefined && model.name !== model.id ? ` — ${model.name}` : ""}`;

  const showContextWidget = (ctx: ExtensionContextSubset): void => {
    const identity = activeIdentity !== undefined ? identityByName.get(activeIdentity) : undefined;
    const auth = identity ? readIdentityAuth(identity.configDir) : {};
    const catalog = identityCatalog(activeIdentity);
    const rows = buildProviderRows(auth, catalog, ctx.model, (provider) => provider);
    // Pi renders at most 10 widget lines (InteractiveMode.MAX_WIDGET_LINES),
    // so the panel is compact by design: one context line, one usage hint,
    // then the table with the CURRENT provider first (a long tail is cut by
    // pi itself, losing only the least relevant rows).
    const lines = [
      `ais identity: ${identity?.label ?? "none (no AIS identities registered)"} · ` +
        `model: ${ctx.model ? `${baseProviderOf(ctx.model.provider)}/${ctx.model.id}` : "none"}`,
      "/ais switches identity+model · /ais use <provider>[/<model>] · /ais identities",
      ...formatProviderTable(rows, ctx.model),
    ];
    const gaps = activeIdentity !== undefined ? (gapsByIdentity.get(activeIdentity) ?? []) : [];
    const widget = gaps.length > 0 ? [...lines, ...gaps] : lines;
    if (!ctx.hasUI) {
      ctx.ui.notify(`ais: ${identity?.label ?? "unknown"} ${lines[0] ?? ""}`.trim(), "info");
      return;
    }
    contextWidgetShown = true;
    ctx.ui.setWidget(WIDGET_KEY, widget);
  };

  const showIdentitiesWidget = (ctx: ExtensionContextSubset): void => {
    const { listings, note } = buildIdentityListings(readRegistry(), activeIdentity);
    // Compact for pi's 10-line widget cap.
    const lines = [
      "AIS Pi identities. Switch in-app with /ais (no relaunch needed);",
      "credentials stay in each identity's own store.",
      "",
      ...(listings.length > 0 ? formatIdentityTable(listings) : ["(no identities found)"]),
      ...(note !== undefined ? ["", note] : []),
    ];
    if (!ctx.hasUI) {
      ctx.ui.notify(`ais identities: ${listings.map((listing) => listing.label).join(", ") || "none"}`, "info");
      return;
    }
    contextWidgetShown = false;
    ctx.ui.setWidget(WIDGET_KEY, lines);
  };

  // -- interactive switcher (/ais) -------------------------------------------

  const runSwitcher = async (ctx: ExtensionContextSubset): Promise<void> => {
    if (identities.length === 0) {
      ctx.ui.notify("ais: no identities in ~/.pi/identities.json - nothing to switch to", "warning");
      return;
    }
    if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
      showIdentitiesWidget(ctx);
      return;
    }
    const labels = identities.map((identity) =>
      identity.name === activeIdentity ? `${identity.label} (current)` : identity.label,
    );
    const pickedLabel = await ctx.ui.select("Switch AIS identity:", labels);
    if (pickedLabel === undefined) return;
    const picked = identities[labels.indexOf(pickedLabel)];
    if (!picked) return;
    activeIdentity = picked.name;

    const catalog = identityCatalog(picked.name);
    if (catalog.length === 0) {
      persistState();
      showStatus(ctx, ctx.model);
      ctx.ui.notify(
        `ais: ${picked.label} active, but no models are registered for it (no credentials in its auth.json?)`,
        "warning",
      );
      return;
    }
    const options = catalog.map(modelOption);
    const last = stateFile().lastModel?.[picked.name];
    if (last) {
      const lastIndex = catalog.findIndex((model) => model.provider === last.provider && model.id === last.id);
      if (lastIndex > 0) {
        const [lastOption] = options.splice(lastIndex, 1);
        options.unshift(`${lastOption} (last used)`);
        const moved = catalog.splice(lastIndex, 1)[0] as AiModel;
        catalog.unshift(moved);
      } else if (lastIndex === 0) {
        options[0] = `${options[0]} (last used)`;
      }
    }
    const pickedOption = await ctx.ui.select(`Model for ${picked.label}:`, options);
    if (pickedOption === undefined) {
      persistState();
      showStatus(ctx, ctx.model);
      return;
    }
    const model = catalog[options.indexOf(pickedOption)];
    if (!model) return;
    await applyModel(ctx, model, picked.label);
  };

  const applyModel = async (ctx: ExtensionContextSubset, model: AiModel, label: string): Promise<void> => {
    const success = await pi.setModel(model);
    if (!success) {
      ctx.ui.notify(
        `Pi refused the switch to ${baseProviderOf(model.provider)}/${model.id}: no authentication configured for that provider`,
        "error",
      );
      return;
    }
    showStatus(ctx, model);
    ctx.ui.notify(`switched to ${label}: ${baseProviderOf(model.provider)}/${model.id} for this session`, "info");
  };

  // -- /ais use ---------------------------------------------------------------

  const handleUse = async (ctx: ExtensionContextSubset, args: string): Promise<void> => {
    const identityKeys = [...identities.map((identity) => identity.name), ...identities.flatMap((identity) => identity.aliases ?? [])];
    const target = parseUseTarget(args, identityKeys);
    if ("error" in target) {
      ctx.ui.notify(target.error, "warning");
      return;
    }
    const requestedIdentity =
      target.identity !== undefined
        ? identities.find((identity) => identity.name === target.identity || (identity.aliases ?? []).includes(target.identity as string))
        : undefined;
    if (target.identity !== undefined && requestedIdentity === undefined) {
      ctx.ui.notify(`ais: unknown identity "${target.identity}"`, "error");
      return;
    }

    // 1) the active (or requested) identity's namespaced catalog
    const scopeName = requestedIdentity?.name ?? activeIdentity;
    const scoped = findModelInCatalog(identityCatalog(scopeName), target.provider, target.modelId);
    // 2) any identity's namespaced catalog (unique provider match only)
    let foreign: AiModel | undefined;
    let foreignIdentity: RegistryIdentity | undefined;
    if (!scoped) {
      const matches: Array<{ model: AiModel; identity: RegistryIdentity }> = [];
      for (const identity of identities) {
        const model = findModelInCatalog(identityCatalog(identity.name), target.provider, target.modelId);
        if (model) matches.push({ model, identity });
      }
      if (matches.length === 1) {
        foreign = matches[0]?.model;
        foreignIdentity = matches[0]?.identity;
      } else if (matches.length > 1) {
        ctx.ui.notify(
          `provider "${target.provider}" exists for several identities (${matches
            .map((match) => match.identity.label)
            .join(", ")}) - use /ais use <identity> ${target.provider}${target.modelId ? `/${target.modelId}` : ""}`,
          "warning",
        );
        return;
      }
    }
    const chosen = scoped ?? foreign;
    if (chosen) {
      if (requestedIdentity) activeIdentity = requestedIdentity.name;
      else if (foreignIdentity) activeIdentity = foreignIdentity.name;
      const label = identityLabelFor(identities, activeIdentity) ?? "AIS";
      persistState();
      await applyModel(ctx, chosen, label);
      return;
    }

    // 3) pi's own native catalogue (instance-level credentials, non-AIS providers)
    const resolved = resolveModel({ provider: target.provider, ...(target.modelId !== undefined ? { modelId: target.modelId } : {}) }, ctx.modelRegistry);
    if ("error" in resolved) {
      ctx.ui.notify(resolved.error, "error");
      return;
    }
    if (requestedIdentity) activeIdentity = requestedIdentity.name;
    persistState();
    const success = await pi.setModel(resolved.model);
    if (!success) {
      ctx.ui.notify(
        `Pi refused the switch to ${resolved.model.provider}/${resolved.model.id}: no authentication configured for that provider`,
        "error",
      );
      return;
    }
    showStatus(ctx, resolved.model);
    let credentialNote = "";
    try {
      if (!ctx.modelRegistry.hasConfiguredAuth(resolved.model)) {
        credentialNote = " (note: auth.json holds no credential for this provider, so requests may still fail)";
      }
    } catch {
      // A registry probe failure must not hide the successful switch.
    }
    ctx.ui.notify(
      `switched to ${resolved.model.provider}/${resolved.model.id} for this session` +
        " (new sessions start on the last-used model)" +
        credentialNote,
      "info",
    );
  };

  // -- lifecycle ---------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    refreshKnownProviders(ctx);
    const state = stateFile();
    const cwdMatch = matchIdentityForCwd(identities, ctx.cwd ?? cwd(), home());
    activeIdentity = pickDefaultIdentityName({
      identities,
      envMarker: identityName(),
      persisted: state.activeIdentity,
      cwdMatch: cwdMatch?.name,
    });
    // pi natively restores settings.json defaultProvider/defaultModel (which
    // this extension persists on every selection). Intervene only when there
    // is no usable model at all: pick this identity's last-used model, else
    // its first registered one. "Usable" for a NATIVE model trusts the
    // instance's own auth.json and the persisted settings default, because
    // hasConfiguredAuth reads an availability snapshot that may not be
    // computed yet at session_start (a race here would stomp the user's
    // configured default).
    try {
      let usable = false;
      if (ctx.model) {
        const parsed = parseNamespacedProviderId(ctx.model.provider);
        if (parsed) {
          usable = identityCatalog(parsed.identityName).some(
            (model) => model.provider === ctx.model?.provider && model.id === ctx.model?.id,
          );
        } else {
          const settings = readJson(settingsPath()) as { defaultProvider?: unknown; defaultModel?: unknown } | undefined;
          const isSettingsDefault =
            settings !== undefined &&
            settings.defaultProvider === ctx.model.provider &&
            settings.defaultModel === ctx.model.id;
          usable = isSettingsDefault || readInstanceAuth()[ctx.model.provider] !== undefined || safeHasAuth(ctx, ctx.model);
        }
      }
      if (!usable) {
        const last = activeIdentity !== undefined ? state.lastModel?.[activeIdentity] : undefined;
        const catalog = identityCatalog(activeIdentity);
        const candidate =
          (last !== undefined
            ? catalog.find((model) => model.provider === last.provider && model.id === last.id)
            : undefined) ?? catalog[0];
        if (candidate) {
          await pi.setModel(candidate);
          ctx.model = candidate;
        }
      }
    } catch {
      // Never block session start on the default-model dance.
    }
    persistState();
    showStatus(ctx, ctx.model);
  });

  function safeHasAuth(ctx: ExtensionContextSubset, model: AiModel): boolean {
    try {
      return ctx.modelRegistry.hasConfiguredAuth(model);
    } catch {
      return true;
    }
  }

  pi.on("model_select", (event, ctx) => {
    const model = event.model;
    const parsed = parseNamespacedProviderId(model.provider);
    if (parsed && identityByName.has(parsed.identityName)) {
      activeIdentity = parsed.identityName;
    }
    showStatus(ctx, model);
    if (suppressSettingsPersist) {
      suppressSettingsPersist = false;
    } else {
      writeSettingsDefault(model);
    }
    persistLastModel(model);
    if (contextWidgetShown) showContextWidget(ctx);
  });

  pi.registerCommand("ais", {
    description:
      "AIS identities: /ais interactive identity+model switcher, /ais show context panel, /ais use [<identity> ]<provider>[/<model>], /ais identities",
    getArgumentCompletions: (prefix: string) => {
      const suggestions = [
        "use",
        "show",
        "identities",
        ...identities.map((identity) => identity.name),
        ...knownProviders.map((provider) => baseProviderOf(provider)),
      ];
      const matches = [...new Set(suggestions)].filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "") {
        await runSwitcher(ctx);
        return;
      }
      if (trimmed === "show") {
        showContextWidget(ctx);
        return;
      }
      if (trimmed === "identities") {
        showIdentitiesWidget(ctx);
        return;
      }
      if (trimmed.startsWith("use")) {
        await handleUse(ctx, trimmed.slice(3));
        return;
      }
      ctx.ui.notify(
        `unknown /ais argument "${trimmed}" - use /ais (switch), /ais show, /ais use [<identity> ]<provider>[/<model>], or /ais identities`,
        "warning",
      );
    },
  });
}

/** Reads ~/.pi/identities.json (the AIS Pi registry). Returns undefined when
 * unreadable so the caller renders its honest note. */
export function readIdentitiesRegistry(path = identitiesRegistryPath()): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
