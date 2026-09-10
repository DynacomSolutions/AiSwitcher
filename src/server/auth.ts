import { join } from "node:path";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { loadAll, TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { requireTool } from "./registries.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import { readAliApiKey, writeAliAuthFile } from "../identities/ali-auth.ts";
import { readZaiApiKey, writeZaiAuthFile } from "../identities/zai-auth.ts";
import { withUsableCwd } from "../shared/exec.ts";
import { resolveRealBinary } from "../shared/resolve-binary.ts";
import { LOGIN_FLOW_SPECS, type LoginFlowSpec } from "./login-specs.ts";
import type { RefreshStatusDto } from "./auth-refresh.ts";
import type { ToolConfig } from "../identities/types.ts";
import {
  HttpError,
  type AuthDto,
  type AuthEntryDto,
  type LoginFlowManagerLike,
  type LoginResultDto,
  type LoginStartResultDto,
} from "./types.ts";

/** Per-identity auth health plus the fix actions. Probes are file-presence
 * and shape checks only; nothing here ever returns a secret's value (the
 * masked "state" model is the point). Expiry timestamps are read where a
 * credential shape exposes one so the WebUI can show logged in / expiring /
 * expired / missing per identity. */

interface ProbeResult {
  kind: AuthEntryDto["kind"];
  state: AuthEntryDto["state"];
  detail?: string;
  fixable: string[];
  expiresAt?: string;
}

function exists(path: string): Promise<boolean> {
  return Bun.file(path)
    .exists()
    .catch(() => false);
}

/** Every on-disk file that constitutes "credentials" for a tool identity.
 * The single source of truth shared by the status probes and the login
 * flow manager's callback detection, so the two can never drift. */
export function credentialPathsForTool(toolName: ToolConfig["toolName"], configDir: string): string[] {
  switch (toolName) {
    case "claude":
      return [join(configDir, ".credentials.json")];
    case "codex":
      return [join(configDir, "auth.json")];
    case "grok":
      return ["credentials.json", "auth.json", "auth.toml"].map((name) => join(configDir, name));
    case "kimi":
      return [join(configDir, "credentials", "kimi-code.json")];
    case "pi":
      return [join(configDir, "auth.json")];
    case "opencode":
      // XDG_DATA_HOME points at <configDir>/data (tool-configs.ts), and
      // opencode appends its own /opencode segment: auth.json lives under
      // data/opencode/.
      return [join(configDir, "data", "opencode", "auth.json"), join(configDir, "opencode", "auth.json")];
    default:
      // zai (crush.json provider key) and ali (console-cookie.txt) are
      // handled by their own probes; nothing else to watch.
      return [];
  }
}

/** Expires-in state mapping shared by every probe with a known expiry. */
function stateFromExpiry(expiresAtMs: number): { state: AuthEntryDto["state"]; detail: string } {
  const hoursLeft = (expiresAtMs - Date.now()) / 3_600_000;
  if (hoursLeft <= 0) {
    return { state: "expired", detail: `token expired ${Math.abs(hoursLeft).toFixed(1)}h ago` };
  }
  if (hoursLeft < 24) {
    return { state: "expiring", detail: `token expires in ${hoursLeft.toFixed(1)}h` };
  }
  return { state: "ok", detail: `token expires in ${(hoursLeft / 24).toFixed(1)}d` };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function findExpiry(value: unknown, depth = 0): number | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (/expire|expiresat|expir/i.test(key)) {
        const n = typeof child === "number" ? child : typeof child === "string" ? Number.parseFloat(child) : NaN;
        if (Number.isFinite(n)) {
          // Epoch seconds vs milliseconds: a value under 10^11 must be seconds.
          return n < 1e11 ? n * 1000 : n;
        }
      }
      const nested = findExpiry(child, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** Best-effort JWT expiry extraction (id_token/access_token shapes): decodes
 * the payload's exp claim. Never verifies signatures and never surfaces the
 * token itself; only used when no plain expiry field exists. */
function jwtExpiry(value: unknown, depth = 0): number | undefined {
  if (depth > 3) return undefined;
  if (typeof value === "string") {
    const parts = value.split(".");
    if (parts.length !== 3) return undefined;
    try {
      const payload = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/"))) as { exp?: unknown };
      const exp = typeof payload.exp === "number" ? payload.exp : Number.parseFloat(String(payload.exp ?? ""));
      return Number.isFinite(exp) ? (exp < 1e11 ? exp * 1000 : exp) : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      const found = jwtExpiry(child, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Reads a JSON credential file, returning undefined for absence or
 * corruption (both are probe states, not probe crashes). */
async function readJsonCredential(path: string): Promise<unknown | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    return (await file.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function probeClaude(configDir: string): Promise<ProbeResult> {
  const path = join(configDir, ".credentials.json");
  if (!(await exists(path))) {
    return { kind: "oauth", state: "missing", detail: "no .credentials.json in configDir", fixable: ["login"] };
  }
  const raw = await readJsonCredential(path);
  if (raw === undefined) {
    return { kind: "oauth", state: "unknown", detail: ".credentials.json unreadable", fixable: ["login"] };
  }
  const expiry = findExpiry(raw) ?? jwtExpiry(raw);
  if (expiry === undefined) {
    return { kind: "oauth", state: "ok", detail: ".credentials.json present (no parsable expiry)", fixable: ["login"] };
  }
  const derived = stateFromExpiry(expiry);
  return {
    kind: "oauth",
    state: derived.state,
    detail: derived.detail,
    fixable: ["login"],
    expiresAt: toIso(expiry),
  };
}

async function probeCodex(configDir: string): Promise<ProbeResult> {
  const path = join(configDir, "auth.json");
  if (!(await exists(path))) {
    return { kind: "oauth", state: "missing", detail: "no auth.json in configDir", fixable: ["login"] };
  }
  const raw = await readJsonCredential(path);
  if (raw === undefined) {
    return { kind: "oauth", state: "unknown", detail: "auth.json unreadable", fixable: ["login"] };
  }
  // codex tokens carry their expiry inside the id_token/access_token JWTs;
  // API-key-only logins have no expiry at all.
  const expiry = findExpiry(raw) ?? jwtExpiry(raw);
  if (expiry === undefined) {
    return { kind: "oauth", state: "ok", detail: "auth.json present (API key or unparsable expiry)", fixable: ["login"] };
  }
  const derived = stateFromExpiry(expiry);
  return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry) };
}

async function probeGrok(configDir: string): Promise<ProbeResult> {
  for (const name of ["credentials.json", "auth.json", "auth.toml"]) {
    const path = join(configDir, name);
    if (!(await exists(path))) continue;
    // JSON shapes get a best-effort expiry read; auth.toml stays "unknown".
    const raw = name.endsWith(".json") ? await readJsonCredential(path) : undefined;
    const expiry = raw === undefined ? undefined : (findExpiry(raw) ?? jwtExpiry(raw));
    if (expiry === undefined) {
      return { kind: "oauth", state: "unknown", detail: `${name} present (freshness not verifiable)`, fixable: ["login"] };
    }
    const derived = stateFromExpiry(expiry);
    return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry) };
  }
  return { kind: "oauth", state: "missing", detail: "no known credential file in configDir", fixable: ["login"] };
}

/** Kimi stores its OAuth token as JSON with an expiry field whose exact name
 * has drifted across versions; scan for any key containing "expire" rather
 * than hardcoding one. */
async function probeKimi(configDir: string): Promise<ProbeResult> {
  const path = join(configDir, "credentials", "kimi-code.json");
  const raw = await readJsonCredential(path);
  if (raw === undefined) {
    return { kind: "oauth", state: "missing", detail: "credentials/kimi-code.json absent", fixable: ["refresh", "login"] };
  }
  const expiry = findExpiry(raw);
  if (expiry === undefined) {
    return { kind: "oauth", state: "unknown", detail: "token present but no parsable expiry field", fixable: ["refresh", "login"] };
  }
  const derived = stateFromExpiry(expiry);
  return {
    kind: "oauth",
    state: derived.state,
    detail: `${derived.detail} (refresh happens on next live fetch)`,
    fixable: ["refresh", "login"],
    expiresAt: toIso(expiry),
  };
}

async function probeZai(configDir: string): Promise<ProbeResult> {
  const key = await readZaiApiKey(configDir).catch(() => undefined);
  if (key) return { kind: "apikey", state: "ok", detail: "zai provider key configured in crush.json", fixable: ["zai-key"] };
  return { kind: "apikey", state: "missing", detail: "no usable zai provider key in crush.json", fixable: ["zai-key"] };
}

async function probeAli(configDir: string): Promise<ProbeResult> {
  const cookiePath = join(configDir, "console-cookie.txt");
  const cookie = await exists(cookiePath);
  const key = await readAliApiKey(configDir).catch(() => undefined);
  if (!cookie && !key) {
    return { kind: "none", state: "missing", detail: "no console-cookie.txt and no alibaba provider key", fixable: ["ali-cookie", "zai-key"] };
  }
  if (!cookie) {
    return { kind: "cookie", state: "missing", detail: "provider key set but console-cookie.txt absent (quota checks need it)", fixable: ["ali-cookie", "zai-key"] };
  }
  // Cookie age is a useful freshness hint: the daemon (or a host timer)
  // renews it roughly every 10 minutes while the session stays alive.
  let ageDetail = "console cookie present";
  try {
    const info = await stat(cookiePath);
    const ageHours = (Date.now() - (info.mtimeMs ?? 0)) / 3_600_000;
    if (Number.isFinite(ageHours)) ageDetail = `console cookie written ${ageHours < 1 ? `${Math.round(ageHours * 60)}m` : `${ageHours.toFixed(1)}h`} ago`;
  } catch {
    // Stat raced with a renewal; presence detail stands.
  }
  return { kind: "cookie", state: "unknown", detail: `${ageDetail} (server-side freshness not verifiable cheaply)`, fixable: ["ali-cookie", "zai-key"] };
}

async function probePi(configDir: string): Promise<ProbeResult> {
  const path = join(configDir, "auth.json");
  if (!(await exists(path))) {
    return { kind: "oauth", state: "missing", detail: "no auth.json in configDir (ais auth import can seed it)", fixable: ["login"] };
  }
  const raw = await readJsonCredential(path);
  if (raw === undefined) {
    return { kind: "oauth", state: "unknown", detail: "auth.json unreadable", fixable: ["login"] };
  }
  const expiry = findExpiry(raw) ?? jwtExpiry(raw);
  if (expiry === undefined) {
    return { kind: "oauth", state: "ok", detail: "auth.json present (no parsable expiry)", fixable: ["login"] };
  }
  const derived = stateFromExpiry(expiry);
  return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry) };
}

async function probeOpencode(configDir: string): Promise<ProbeResult> {
  for (const path of credentialPathsForTool("opencode", configDir)) {
    if (!(await exists(path))) continue;
    const raw = await readJsonCredential(path);
    if (raw === undefined) {
      return { kind: "oauth", state: "unknown", detail: `auth file unreadable (${path})`, fixable: ["login"] };
    }
    const expiry = findExpiry(raw) ?? jwtExpiry(raw);
    if (expiry === undefined) {
      return { kind: "oauth", state: "ok", detail: "auth.json present (no parsable expiry)", fixable: ["login"] };
    }
    const derived = stateFromExpiry(expiry);
    return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry) };
  }
  return { kind: "oauth", state: "missing", detail: "no auth.json under this identity's opencode data dir", fixable: ["login"] };
}

export async function authStatus(
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
  refreshStatus: RefreshStatusDto[] = [],
): Promise<AuthDto> {
  const loaded = await loadAll(configs);
  const entries: AuthEntryDto[] = [];
  for (const { cfg, file } of loaded) {
    for (const identity of file.identities) {
      let result: ProbeResult;
      try {
        switch (cfg.toolName) {
          case "claude":
            result = await probeClaude(identity.configDir);
            break;
          case "codex":
            result = await probeCodex(identity.configDir);
            break;
          case "grok":
            result = await probeGrok(identity.configDir);
            break;
          case "kimi":
            result = await probeKimi(identity.configDir);
            break;
          case "zai":
            result = await probeZai(identity.configDir);
            break;
          case "ali":
            result = await probeAli(identity.configDir);
            break;
          case "pi":
            result = await probePi(identity.configDir);
            break;
          case "opencode":
            result = await probeOpencode(identity.configDir);
            break;
          default:
            result = { kind: "none", state: "unknown", detail: "no auth probe for this tool", fixable: [] };
            break;
        }
      } catch (err) {
        result = { kind: "none", state: "unknown", detail: err instanceof Error ? err.message : "probe failed", fixable: [] };
      }
      const refresh = refreshStatus.find((entry) => entry.tool === cfg.toolName && entry.identity === identity.name);
      entries.push({
        toolName: cfg.toolName,
        identity: identity.name,
        kind: result.kind,
        state: result.state,
        ...(result.detail ? { detail: result.detail } : {}),
        fixable: result.fixable,
        ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
        ...(refresh?.lastSuccessAt ? { lastRefreshAt: refresh.lastSuccessAt } : {}),
        ...(refresh?.lastError ? { refreshError: refresh.lastError } : {}),
      });
    }
  }
  return { entries };
}

/* ------------------------------- fix actions ------------------------------ */

async function registryIdentity(toolName: ToolConfig["toolName"], identityName: string): Promise<{ cfg: ToolConfig; configDir: string }> {
  const cfg = requireTool(toolName);
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const identity = findIdentityByNameOrAlias(file.identities, identityName);
  if (!identity) throw new HttpError(404, `identity "${identityName}" not found in ${toolName}'s registry`);
  return { cfg, configDir: identity.configDir };
}

export async function writeProviderKey(toolName: "zai" | "ali", identityName: string, apiKey: string): Promise<{ ok: true }> {
  if (!apiKey) throw new HttpError(400, "apiKey must not be empty");
  const { configDir } = await registryIdentity(toolName, identityName);
  if (toolName === "zai") await writeZaiAuthFile(configDir, apiKey);
  else await writeAliAuthFile(configDir, apiKey);
  return { ok: true };
}

export async function writeAliConsoleCookie(identityName: string, cookie: string): Promise<{ ok: true }> {
  if (!cookie.trim()) throw new HttpError(400, "cookie must not be empty");
  const { configDir } = await registryIdentity("ali", identityName);
  await Bun.write(join(configDir, "console-cookie.txt"), `${cookie.trim()}\n`);
  return { ok: true };
}

/** A kimi token refresh is exactly what fetchKimiLimits already does when it
 * sees an expired token (refresh + persist), so reuse that path instead of
 * duplicating the OAuth dance here. */
export async function refreshKimiToken(identityName: string): Promise<{ ok: true; detail: string }> {
  const { configDir } = await registryIdentity("kimi", identityName);
  const identity = { name: identityName, label: identityName, configDir };
  const { fetchKimiLimits } = await import("../cli/limits/kimi-limits.ts");
  const result = await fetchKimiLimits(identity);
  if (result.status === "live") return { ok: true, detail: "quota fetched live; token refreshed if it had expired" };
  throw new HttpError(502, result.error ?? "kimi fetch failed; token may still be expired");
}

/* ----------------------------- login spawning ----------------------------- */

/** Terminal fallback args, derived from the managed specs so the two can
 * never disagree about what "the same standard flow" is. */
const LOGIN_ARGS = Object.fromEntries(
  Object.entries(LOGIN_FLOW_SPECS).map(([tool, spec]) => [tool, (spec as LoginFlowSpec).args]),
) as Partial<Record<ToolConfig["toolName"], string[]>>;

function findTerminal(): { bin: string; prefix: string[] } | undefined {
  const candidates: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["-e"]],
    ["gnome-terminal", ["--"]],
    ["konsole", ["-e"]],
    ["alacritty", ["-e"]],
    ["kitty", []],
    ["wezterm", ["start", "--always-new-process", "--"]],
  ];
  for (const [bin, prefix] of candidates) {
    const found = Bun.which(bin);
    if (found) return { bin: found, prefix };
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Best-effort handoff to a terminal emulator with the identity env applied.
 * Used by tools without a managed login flow (pi, opencode, zai, ali) and as
 * the fallback when the daemon cannot allocate a PTY. Never blocks. */
export async function spawnLogin(toolName: ToolConfig["toolName"], identityName: string): Promise<LoginResultDto> {
  const { cfg, configDir } = await registryIdentity(toolName, identityName);

  // zai/ali have no interactive login at all by design (plain API key files).
  if (cfg.toolName === "zai" || cfg.toolName === "ali") {
    const command = `${cfg.realBinaryName} has no login flow; use the api-key / ali-cookie actions instead`;
    return { spawned: false, command };
  }

  // Resolve the REAL binary (exec.ts convention), falling back to the shim
  // path for a user-attended terminal where the shim's own resolution is
  // part of the designed interactive flow.
  let realBin: string;
  try {
    realBin = resolveRealBinary(cfg.realBinaryName);
  } catch {
    realBin = Bun.which(cfg.realBinaryName) ?? cfg.realBinaryName;
  }

  const args = LOGIN_ARGS[cfg.toolName] ?? [];
  const inner = [realBin ?? cfg.realBinaryName, ...args].map(shellQuote).join(" ");
  const terminal = findTerminal();
  const commandLine = terminal
    ? [terminal.bin, ...terminal.prefix, process.env.SHELL ?? "/bin/bash", "-lc", inner]
    : ["bash", "-lc", inner];

  const proc = withUsableCwd(() =>
    Bun.spawn(commandLine, {
      env: {
        ...process.env,
        [cfg.envVarName]: configDir,
        ...Object.fromEntries(
          (cfg.extraEnvVarNames ?? []).map((extra) => [
            extra.name,
            extra.subdir ? join(configDir, extra.subdir) : configDir,
          ]),
        ),
      },
      stdio: ["ignore", "ignore", "ignore"],
    }),
  );
  proc.unref();
  const display = commandLine.map((part) => (part.includes(" ") ? shellQuote(part) : part)).join(" ");
  return { spawned: true, command: display.replace(homedir(), "~") };
}

/** POST /api/auth/login: managed flow when the tool has one and the daemon
 * can run it, terminal handoff otherwise. Identity errors (404/409) always
 * propagate; only "cannot run managed" (503, no PTY support) downgrades to
 * the terminal handoff. */
export async function startLogin(
  toolName: ToolConfig["toolName"],
  identityName: string,
  flows?: LoginFlowManagerLike,
): Promise<LoginStartResultDto> {
  if (flows && LOGIN_FLOW_SPECS[toolName]) {
    try {
      const flow = await flows.start(toolName, identityName);
      return { kind: "managed", flow };
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 503) throw err;
      // No PTY support on this host: fall through to the terminal handoff.
    }
  }
  const terminal = await spawnLogin(toolName, identityName);
  return { kind: "terminal", ...terminal };
}
