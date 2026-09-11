/**
 * AIS identity extension for Pi (@earendil-works/pi-coding-agent).
 *
 * Installed and kept current by the `ais pi` wrapper (see
 * src/identities/pi-extension-install.ts) into
 * `$PI_CODING_AGENT_DIR/extensions/ais-identity.ts`, which Pi auto-discovers
 * and loads via jiti (TypeScript needs no compilation). This file must stay a
 * self-contained single module: the installed copy cannot resolve sibling
 * imports, so the few Pi API types it needs are modelled locally below and
 * the only runtime imports are node: builtins.
 *
 * What it provides:
 * - A persistent footer status (`ctx.ui.setStatus`) showing the AIS identity,
 *   provider and model currently in use.
 * - `/ais` - the same context as a widget panel plus a per-provider table of
 *   this identity's credentials (from auth.json) mapped to the models Pi's
 *   catalogue actually offers, with honest gap notes.
 * - `/ais use <provider>[/<model>]` - switches the in-session model via
 *   Pi's own `pi.setModel()` API. Never sends a request, changes no files
 *   and does not touch the defaults new sessions start with.
 * - `/ais identities` - lists every AIS Pi identity from ~/.pi/identities.json
 *   with its launch command. Whole-identity switching is deliberately NOT
 *   performed in-session: a swapped-in copy of another identity's rotating
 *   OAuth credentials would refresh into THIS identity's auth.json and break
 *   AIS's one-credential-per-(identity, provider) attribution (kimi rotates
 *   its refresh token on every refresh - see src/cli/limits/kimi-store.ts).
 *   Switching identities requires a relaunch; the command says so.
 */

import { readFileSync } from "node:fs";

/** Version stamp the installer matches against; bump to force a refresh of
 * installed copies on next launch. */
export const AIS_EXTENSION_VERSION = "1.0.0";

export const STATUS_KEY = "ais";
export const WIDGET_KEY = "ais";

/** AIS sets this on the wrapper's spawned child only
 * (src/shared/exec.ts IDENTITY_SESSION_MARKER). */
const IDENTITY_ENV_VAR = "AI_PROFILE_SWITCHER_SESSION";

/** AIS's complete-profile boundary for Pi (src/identities/tool-configs.ts). */
const CONFIG_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

export interface AiModel {
  id: string;
  provider: string;
  name?: string;
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
}

export interface ExtensionContextSubset {
  hasUI: boolean;
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

function authPath(): string {
  const configDir = process.env[CONFIG_DIR_ENV_VAR];
  const base = configDir && configDir.length > 0 ? configDir : `${process.env.HOME ?? ""}/.pi/agent`;
  return `${base}/auth.json`;
}

/** Reads auth.json into a provider -> credential map. A missing or invalid
 * file is an empty map, never a crash: the table then renders the honest
 * "no credentials" row. Values are never exposed, only key names and the
 * credential type. */
export function readAuthMap(path = authPath()): AuthMap {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as AuthMap;
  } catch {
    return {};
  }
}

export interface ProviderRow {
  provider: string;
  display: string;
  credential: string;
  models: number;
  current: boolean;
  note?: string;
}

/** Pure: builds the per-provider table rows for /ais from the identity's
 * credentials plus Pi's own model catalogue. Only model COUNTS and names are
 * surfaced; credential values stay in auth.json. */
export function buildProviderRows(
  auth: AuthMap,
  available: readonly AiModel[],
  current: AiModel | undefined,
  displayName: (provider: string) => string,
): ProviderRow[] {
  const counts = new Map<string, number>();
  for (const model of available) {
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }
  const providers = new Set<string>([...Object.keys(auth), ...counts.keys()]);
  const rows: ProviderRow[] = [];
  for (const provider of [...providers].sort()) {
    const credential = auth[provider];
    const modelCount = counts.get(provider) ?? 0;
    const isCurrent = current !== undefined && current.provider === provider;
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
  if (typeof registry !== "object" || registry === null) {
    return { listings: [], note: "AIS Pi registry not readable - cannot list identities" };
  }
  const file = registry as { version?: unknown; identities?: unknown };
  if (file.version !== 1 || !Array.isArray(file.identities)) {
    return { listings: [], note: "AIS Pi registry has an unexpected shape - cannot list identities" };
  }
  const listings: IdentityListing[] = [];
  for (const raw of file.identities) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { name?: unknown; label?: unknown; configDir?: unknown };
    if (typeof entry.name !== "string" || typeof entry.configDir !== "string") continue;
    listings.push({
      name: entry.name,
      label: typeof entry.label === "string" ? entry.label : entry.name,
      configDir: entry.configDir,
      current: entry.name === activeIdentity,
    });
  }
  return { listings };
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

/** Pure: parse a `/ais use` argument into a provider/model target. */
export function parseUseTarget(
  args: string,
): { provider: string; modelId?: string } | { error: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { error: "usage: /ais use <provider>[/<model>] (example: /ais use zai/glm-4.6)" };
  }
  const [providerPart, modelPart] = trimmed.split("/", 2);
  const provider = (providerPart ?? "").trim();
  if (provider.length === 0) return { error: "provider name is empty" };
  const modelId = (modelPart ?? "").trim();
  return modelId.length > 0 ? { provider, modelId } : { provider };
}

/** Pure: pick a model for /ais use when only a provider was named. Prefers
 * the first catalogue model the provider offers; exact-id matches win when a
 * partial id was given. */
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

export function currentIdentityName(): string | undefined {
  const value = process.env[IDENTITY_ENV_VAR];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function statusLine(identity: string | undefined, model: AiModel | undefined): string {
  const target = model ? `${model.provider}/${model.id}` : "no model selected";
  return identity ? `ais ${identity}: ${target}` : `ais: ${target} (launched outside the ais wrapper)`;
}

/** The extension factory Pi calls. Exported default per Pi's extension
 * contract; kept synchronous (no startup I/O on this path). The optional
 * second argument exists purely for tests: jiti calls the factory with the
 * Pi API only, so production always uses the real environment and file
 * readers - unit tests inject fixtures and never touch live state. */
export default function aisIdentityExtension(
  pi: ExtensionApiSubset,
  deps: {
    readAuth?: () => AuthMap;
    readRegistry?: () => unknown;
    identityName?: () => string | undefined;
  } = {},
): void {
  const readAuth = deps.readAuth ?? readAuthMap;
  const readRegistry = deps.readRegistry ?? readIdentitiesRegistry;
  const identityName = deps.identityName ?? currentIdentityName;
  let knownProviders: string[] = [];
  /** Whether the /ais context panel is currently displayed: a later model
   * switch re-renders it so the table never shows a stale current row. */
  let contextWidgetShown = false;

  const refreshKnownProviders = (ctx: ExtensionContextSubset): void => {
    try {
      knownProviders = [...new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider))].sort();
    } catch {
      knownProviders = [];
    }
  };

  const showStatus = (ctx: ExtensionContextSubset, model: AiModel | undefined): void => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus(STATUS_KEY, statusLine(identityName(), model));
    } catch {
      // A status-line failure must never take the session down.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    refreshKnownProviders(ctx);
    showStatus(ctx, ctx.model);
  });

  pi.on("model_select", (event, ctx) => {
    showStatus(ctx, event.model);
    if (contextWidgetShown) showContextWidget(ctx);
  });

  pi.registerCommand("ais", {
    description:
      "AIS context: identity/provider/model table (/ais), switch (/ais use provider[/model]), identities (/ais identities)",
    getArgumentCompletions: (prefix: string) => {
      const suggestions = ["use", "identities", ...knownProviders];
      const matches = suggestions.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "" || trimmed === "show") {
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
        `unknown /ais argument "${trimmed}" - use /ais, /ais use <provider>[/<model>], or /ais identities`,
        "warning",
      );
    },
  });

  const showContextWidget = (ctx: ExtensionContextSubset): void => {
    const identity = identityName();
    const auth = readAuth();
    const rows = buildProviderRows(
      auth,
      safeAvailable(ctx),
      ctx.model,
      (provider) => safeDisplayName(ctx, provider),
    );
    // Pi renders at most 10 widget lines (InteractiveMode.MAX_WIDGET_LINES),
    // so the panel is compact by design: one context line, one usage hint,
    // then the table with the CURRENT provider first (a long tail is cut by
    // pi itself, losing only the least relevant rows).
    const lines = [
      `ais identity: ${identity ?? "unknown (launched outside the ais wrapper)"} · ` +
        `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
      "/ais use <provider>[/<model>] switches in-session; whole-identity switches need a relaunch (/ais identities)",
      ...formatProviderTable(rows, ctx.model),
    ];
    const gapNotes = Object.entries(KNOWN_PROVIDER_GAPS)
      .filter(([provider]) => auth[provider] === undefined)
      .map(([provider, note]) => `${provider}: ${note}`);
    const widget = gapNotes.length > 0 ? [...lines, ...gapNotes] : lines;
    if (!ctx.hasUI) {
      ctx.ui.notify(`ais: ${identity ?? "unknown"} ${lines[0] ?? ""}`.trim(), "info");
      return;
    }
    contextWidgetShown = true;
    ctx.ui.setWidget(WIDGET_KEY, widget);
  };

  const showIdentitiesWidget = (ctx: ExtensionContextSubset): void => {
    const registry = readRegistry();
    const { listings, note } = buildIdentityListings(registry, identityName());
    // Compact for pi's 10-line widget cap: relaunch honesty fits in two
    // header lines before the table.
    const lines = [
      "AIS Pi identities. Switching requires a relaunch: swapping another",
      "identity's auth.json in-session would mis-attribute rotating OAuth tokens.",
      "",
      ...(listings.length > 0 ? formatIdentityTable(listings) : ["(no identities found)"]),
      ...(note !== undefined ? ["", note] : []),
    ];
    if (!ctx.hasUI) {
      ctx.ui.notify(`ais identities: ${listings.map((listing) => listing.name).join(", ") || "none"}`, "info");
      return;
    }
    contextWidgetShown = false;
    ctx.ui.setWidget(WIDGET_KEY, lines);
  };

  const handleUse = async (ctx: ExtensionContextSubset, args: string): Promise<void> => {
    const target = parseUseTarget(args);
    if ("error" in target) {
      ctx.ui.notify(target.error, "warning");
      return;
    }
    const resolved = resolveModel(target, ctx.modelRegistry);
    if ("error" in resolved) {
      ctx.ui.notify(resolved.error, "error");
      return;
    }
    const success = await pi.setModel(resolved.model);
    if (!success) {
      ctx.ui.notify(
        `Pi refused the switch to ${resolved.model.provider}/${resolved.model.id}: no authentication configured for that provider`,
        "error",
      );
      return;
    }
    // pi.setModel emits model_select, which refreshes the status line; the
    // explicit refresh keeps the widget truthful even if the event is
    // coalesced.
    showStatus(ctx, resolved.model);
    // pi accepts models whose provider has no stored credential when the
    // provider's own configuration carries auth (a models.json custom
    // provider, for example). Say so instead of implying every switch is
    // guaranteed to work.
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
        " (new sessions still start on the identity's configured default)" +
        credentialNote,
      "info",
    );
  };
}

function safeAvailable(ctx: ExtensionContextSubset): AiModel[] {
  try {
    return ctx.modelRegistry.getAvailable();
  } catch {
    return [];
  }
}

function safeDisplayName(ctx: ExtensionContextSubset, provider: string): string {
  try {
    return ctx.modelRegistry.getProviderDisplayName(provider);
  } catch {
    return provider;
  }
}

/** Reads ~/.pi/identities.json (the AIS Pi registry). Returns undefined when
 * unreadable so the caller renders its honest note. */
export function readIdentitiesRegistry(path = `${process.env.HOME ?? ""}/.pi/identities.json`): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
