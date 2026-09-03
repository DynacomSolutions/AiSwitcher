import { join } from "node:path";
import { homedir } from "node:os";
import { loadAll, TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { requireTool } from "./registries.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import { readAliApiKey, writeAliAuthFile } from "../identities/ali-auth.ts";
import { readZaiApiKey, writeZaiAuthFile } from "../identities/zai-auth.ts";
import { withUsableCwd } from "../shared/exec.ts";
import type { ToolConfig } from "../identities/types.ts";
import { HttpError, type AuthDto, type AuthEntryDto, type LoginResultDto } from "./types.ts";

/** Per-identity auth health plus the fix actions. Probes are file-presence
 * and shape checks only; nothing here ever returns a secret's value (the
 * masked "state" model is the point). */

interface ProbeResult {
  kind: AuthEntryDto["kind"];
  state: AuthEntryDto["state"];
  detail?: string;
  fixable: string[];
}

function exists(path: string): Promise<boolean> {
  return Bun.file(path)
    .exists()
    .catch(() => false);
}

async function probeClaude(configDir: string): Promise<ProbeResult> {
  const creds = join(configDir, ".credentials.json");
  if (await exists(creds)) return { kind: "oauth", state: "ok", detail: ".credentials.json present", fixable: ["login"] };
  return { kind: "oauth", state: "missing", detail: "no .credentials.json in configDir", fixable: ["login"] };
}

async function probeCodex(configDir: string): Promise<ProbeResult> {
  if (await exists(join(configDir, "auth.json"))) return { kind: "oauth", state: "ok", detail: "auth.json present", fixable: ["login"] };
  return { kind: "oauth", state: "missing", detail: "no auth.json in configDir", fixable: ["login"] };
}

async function probeGrok(configDir: string): Promise<ProbeResult> {
  for (const name of ["credentials.json", "auth.json", "auth.toml"]) {
    if (await exists(join(configDir, name))) {
      return { kind: "oauth", state: "unknown", detail: `${name} present (freshness not verifiable)`, fixable: ["login"] };
    }
  }
  return { kind: "oauth", state: "missing", detail: "no known credential file in configDir", fixable: ["login"] };
}

/** Kimi stores its OAuth token as JSON with an expiry field whose exact name
 * has drifted across versions; scan for any key containing "expire" rather
 * than hardcoding one. */
async function probeKimi(configDir: string): Promise<ProbeResult> {
  const path = join(configDir, "credentials", "kimi-code.json");
  let raw: unknown;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { kind: "oauth", state: "missing", detail: "credentials/kimi-code.json absent", fixable: ["refresh", "login"] };
    }
    raw = await file.json();
  } catch {
    return { kind: "oauth", state: "unknown", detail: "credential file unreadable", fixable: ["refresh", "login"] };
  }
  const record = raw as Record<string, unknown>;
  const expiry = findExpiry(record);
  if (expiry === undefined) {
    return { kind: "oauth", state: "unknown", detail: "token present but no parsable expiry field", fixable: ["refresh", "login"] };
  }
  const hoursLeft = (expiry - Date.now()) / 3_600_000;
  if (hoursLeft <= 0) {
    return { kind: "oauth", state: "expired", detail: `token expired ${Math.abs(hoursLeft).toFixed(1)}h ago (refresh happens on next live fetch)`, fixable: ["refresh", "login"] };
  }
  if (hoursLeft < 24) {
    return { kind: "oauth", state: "expiring", detail: `token expires in ${hoursLeft.toFixed(1)}h`, fixable: ["refresh", "login"] };
  }
  return { kind: "oauth", state: "ok", detail: `token expires in ${(hoursLeft / 24).toFixed(1)}d`, fixable: ["refresh", "login"] };
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

async function probeZai(configDir: string): Promise<ProbeResult> {
  const key = await readZaiApiKey(configDir).catch(() => undefined);
  if (key) return { kind: "apikey", state: "ok", detail: "zai provider key configured in crush.json", fixable: ["zai-key"] };
  return { kind: "apikey", state: "missing", detail: "no usable zai provider key in crush.json", fixable: ["zai-key"] };
}

async function probeAli(configDir: string): Promise<ProbeResult> {
  const cookie = await exists(join(configDir, "console-cookie.txt"));
  const key = await readAliApiKey(configDir).catch(() => undefined);
  if (!cookie && !key) {
    return { kind: "none", state: "missing", detail: "no console-cookie.txt and no alibaba provider key", fixable: ["ali-cookie", "zai-key"] };
  }
  if (!cookie) {
    return { kind: "cookie", state: "missing", detail: "provider key set but console-cookie.txt absent (quota checks need it)", fixable: ["ali-cookie", "zai-key"] };
  }
  return { kind: "cookie", state: "unknown", detail: "console cookie pasted (server-side freshness not verifiable cheaply)", fixable: ["ali-cookie", "zai-key"] };
}

async function probePi(configDir: string): Promise<ProbeResult> {
  if (await exists(join(configDir, "auth.json"))) return { kind: "oauth", state: "ok", detail: "auth.json present", fixable: ["login"] };
  return { kind: "oauth", state: "missing", detail: "no auth.json in configDir (ais auth import can seed it)", fixable: ["login"] };
}

export async function authStatus(configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<AuthDto> {
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
          default:
            result = { kind: "none", state: "unknown", detail: "no auth probe for this tool", fixable: [] };
            break;
        }
      } catch (err) {
        result = { kind: "none", state: "unknown", detail: err instanceof Error ? err.message : "probe failed", fixable: [] };
      }
      entries.push({
        toolName: cfg.toolName,
        identity: identity.name,
        kind: result.kind,
        state: result.state,
        ...(result.detail ? { detail: result.detail } : {}),
        fixable: result.fixable,
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

const LOGIN_ARGS: Partial<Record<ToolConfig["toolName"], string[]>> = {
  codex: ["login"],
  grok: ["login"],
};

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

export async function spawnLogin(toolName: ToolConfig["toolName"], identityName: string): Promise<LoginResultDto> {
  const { cfg, configDir } = await registryIdentity(toolName, identityName);
  const realBin = Bun.which(cfg.realBinaryName);

  // zai/ali have no interactive login at all by design (plain API key files).
  if (cfg.toolName === "zai" || cfg.toolName === "ali") {
    const command = `${cfg.realBinaryName} has no login flow; use the api-key / ali-cookie actions instead`;
    return { spawned: false, command };
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
