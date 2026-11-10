import { join } from "node:path";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { loadAll, TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { requireTool } from "./registries.ts";
import { isRetired } from "../identities/retired.ts";
import { isSwapPool } from "../identities/pool/swap-pool.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import { credentialPathsForTool } from "../identities/credential-paths.ts";
import { readAliApiKey, writeAliAuthFile } from "../identities/ali-auth.ts";
import { readZaiApiKey, writeZaiAuthFile } from "../identities/zai-auth.ts";
import { withUsableCwd } from "../shared/exec.ts";
import { resolveRealBinary } from "../shared/resolve-binary.ts";
import { hasMemberCopy, memberDir, memberStoreRoot, type MemberStoreTool } from "../identities/gateway-members.ts";
import { folderHoldsGatewayEntry } from "../identities/gateway-routed.ts";
import { readLoginRevoked } from "../identities/gateway-revoked.ts";
import { LOGIN_FLOW_SPECS, type LoginFlowSpec } from "./login-specs.ts";
import type { RefreshStatusDto } from "./auth-refresh.ts";
import type { Identity, ToolConfig } from "../identities/types.ts";
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
  /** Short access-token life but a refresh token is held: healthy unless the refresher is failing. */
  selfRefreshing?: boolean;
  /** The result describes the gateway's member-store login: the host's own refresher never touches it (it skips gateway-managed logins), so its status says nothing about this login. */
  viaGateway?: boolean;
}

function exists(path: string): Promise<boolean> {
  return Bun.file(path)
    .exists()
    .catch(() => false);
}

// The path list lives with the identities engine so credential purging on
// retirement shares it; re-exported here for the status probes and login flows.
export { credentialPathsForTool };

/** Expires-in state mapping shared by every probe with a known expiry. */
function stateFromExpiry(
  expiresAtMs: number,
  hasRefreshToken = false,
): { state: AuthEntryDto["state"]; detail: string; selfRefreshing?: boolean } {
  const hoursLeft = (expiresAtMs - Date.now()) / 3_600_000;
  if (hoursLeft <= 0) {
    // A lapsed access token with a refresh token is renewed on next use (kimi's last only 15 min): not a reason to log in again.
    // A refresh token that no longer works shows up as a refresh error, not here.
    if (hasRefreshToken) return { state: "ok", detail: `access token lapsed ${formatAgo(-hoursLeft)} ago; renewed with the refresh token on next use`, selfRefreshing: true };
    return { state: "expired", detail: `token expired ${Math.abs(hoursLeft).toFixed(1)}h ago` };
  }
  if (hoursLeft < 24) {
    // The gateway refreshes short-lived access tokens, so a refresh token makes this healthy.
    if (hasRefreshToken) return { state: "ok", detail: `token expires in ${hoursLeft.toFixed(1)}h (auto-refreshed)`, selfRefreshing: true };
    return { state: "expiring", detail: `token expires in ${hoursLeft.toFixed(1)}h` };
  }
  return { state: "ok", detail: `token expires in ${(hoursLeft / 24).toFixed(1)}d` };
}

/** True when the credential JSON holds a non-empty refresh token under any key. */
function hasRefreshToken(value: unknown, depth = 0): boolean {
  if (depth > 4 || typeof value !== "object" || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^refresh[_-]?token$/i.test(key) && typeof child === "string" && child.length > 0) return true;
    if (hasRefreshToken(child, depth + 1)) return true;
  }
  return false;
}

function formatAgo(hours: number): string {
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : `${hours.toFixed(1)}h`;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function findExpiry(value: unknown, depth = 0): number | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (/expire|expiresat|expir/i.test(key)) {
        // A date string (grok writes "2026-11-10T13:12:18.48Z") is parsed as a date: parseFloat would read only the year.
        if (typeof child === "string" && !/^\s*\d+(?:\.\d+)?\s*$/.test(child)) {
          const ms = Date.parse(child);
          if (Number.isFinite(ms)) return ms;
        }
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
  const derived = stateFromExpiry(expiry, hasRefreshToken(raw));
  return {
    kind: "oauth",
    state: derived.state,
    detail: derived.detail,
    fixable: ["login"],
    expiresAt: toIso(expiry),
    ...(derived.selfRefreshing ? { selfRefreshing: true } : {}),
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
  const derived = stateFromExpiry(expiry, hasRefreshToken(raw));
  return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry), ...(derived.selfRefreshing ? { selfRefreshing: true } : {}) };
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
    const derived = stateFromExpiry(expiry, hasRefreshToken(raw));
    return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry), ...(derived.selfRefreshing ? { selfRefreshing: true } : {}) };
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
  const derived = stateFromExpiry(expiry, hasRefreshToken(raw));
  return {
    kind: "oauth",
    state: derived.state,
    detail: `${derived.detail} (refresh happens on next live fetch)`,
    fixable: ["refresh", "login"],
    expiresAt: toIso(expiry),
    ...(derived.selfRefreshing ? { selfRefreshing: true } : {}),
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
  return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry), ...(derived.selfRefreshing ? { selfRefreshing: true } : {}) };
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
    return { kind: "oauth", state: derived.state, detail: derived.detail, fixable: ["login"], expiresAt: toIso(expiry), ...(derived.selfRefreshing ? { selfRefreshing: true } : {}) };
  }
  return { kind: "oauth", state: "missing", detail: "no auth.json under this identity's opencode data dir", fixable: ["login"] };
}

/**
 * A claude or codex identity routed through the gateway holds only the gateway entry in its folder (an app key, no expiry);
 * the account's real login is the gateway's member-store copy. Probes that copy instead, so the Identities tab shows what the
 * gateway actually uses: its expiry, and whether the gateway found it revoked (gateway-revoked.ts). Undefined when the
 * folder holds a real login (probed as before). A routed folder with no store copy on this host cannot be verified: "unknown".
 */
async function probeViaGateway(tool: MemberStoreTool, identity: Identity): Promise<ProbeResult | undefined> {
  if (!folderHoldsGatewayEntry(tool, identity)) return undefined;
  const root = memberStoreRoot();
  if (!hasMemberCopy(tool, identity.name, root)) {
    return {
      kind: "oauth",
      state: "unknown",
      viaGateway: true,
      detail: "via gateway: the folder holds the gateway entry, but this host has no member-store login for it (the real login cannot be checked here)",
      fixable: ["login"],
    };
  }
  const revoked = readLoginRevoked(tool, identity.name, root);
  if (revoked) {
    return { kind: "oauth", state: "expired", viaGateway: true, detail: `refresh token revoked: re-login required (via gateway member store; ${revoked.code}, ${revoked.at})`, fixable: ["login"] };
  }
  const dir = memberDir(tool, identity.name, root);
  const inner = tool === "claude" ? await probeClaude(dir) : await probeCodex(dir);
  return { ...inner, viaGateway: true, detail: `via gateway member store: ${inner.detail ?? inner.state}` };
}

export async function authStatus(
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
  refreshStatus: RefreshStatusDto[] = [],
): Promise<AuthDto> {
  const loaded = await loadAll(configs);
  const entries: AuthEntryDto[] = [];
  for (const { cfg, file } of loaded) {
    for (const identity of file.identities) {
      // Retired identities are never probed (no file reads, no refresh
      // lookups): they report a terminal "retired" state with no fixes.
      if (isRetired(identity)) {
        entries.push({
          toolName: cfg.toolName,
          identity: identity.name,
          kind: "none",
          state: "retired",
          detail: "retired: credentials removed; unretire and log in again to use it",
          fixable: [],
        });
        continue;
      }
      // Pools hold only the gateway entry and never an account login: no
      // probe, no expiry, no login or fix actions.
      if (isSwapPool(identity)) {
        entries.push({
          toolName: cfg.toolName,
          identity: identity.name,
          kind: "none",
          state: "gateway",
          detail: "via gateway: pools hold no account login",
          fixable: [],
        });
        continue;
      }
      let result: ProbeResult;
      try {
        switch (cfg.toolName) {
          case "claude":
            result = (await probeViaGateway("claude", identity)) ?? (await probeClaude(identity.configDir));
            break;
          case "codex":
            result = (await probeViaGateway("codex", identity)) ?? (await probeCodex(identity.configDir));
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
      // Failures the host's refresher recorded before the identity was routed never clear (it skips gateway-managed logins): they must not override the member-store probe.
      const refresh = result.viaGateway ? undefined : refreshStatus.find((entry) => entry.tool === cfg.toolName && entry.identity === identity.name);
      // A revoked or failing refresher means the short-lived token is not self-healing.
      const refresherUnhealthy = !!refresh && (refresh.revoked || !!refresh.lastError || refresh.consecutiveFailures > 0);
      const state = result.selfRefreshing && refresherUnhealthy ? "expiring" : result.state;
      const detail =
        result.selfRefreshing && refresh?.revoked
          ? "refresh token revoked: re-login required"
          : result.selfRefreshing && refresherUnhealthy
            ? `${result.detail?.replace(" (auto-refreshed)", "") ?? "token expiring"} (refresh failing)`
            : result.detail;
      entries.push({
        toolName: cfg.toolName,
        identity: identity.name,
        kind: result.kind,
        state,
        ...(detail ? { detail } : {}),
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

/** Logging a pool in would write an account login into it and break the gateway. */
export function refusePool(identity: Identity): void {
  if (isSwapPool(identity)) {
    throw new HttpError(409, `"${identity.name}" is a gateway pool and has no account login; log in to a member account instead`);
  }
}

async function registryIdentity(toolName: ToolConfig["toolName"], identityName: string): Promise<{ cfg: ToolConfig; configDir: string }> {
  const cfg = requireTool(toolName);
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const identity = findIdentityByNameOrAlias(file.identities, identityName);
  if (!identity) throw new HttpError(404, `identity "${identityName}" not found in ${toolName}'s registry`);
  if (isRetired(identity)) throw new HttpError(409, `identity "${identityName}" is retired; unretire it first`);
  refusePool(identity);
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
