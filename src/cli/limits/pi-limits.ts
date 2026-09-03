import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { canonicalUsageProvider } from "../usage/providers.ts";
import { fetchKimiUsageForCredentials, type KimiOAuthCredentials } from "./kimi-limits.ts";
import { fetchZaiQuotaForKey } from "./zai-limits.ts";
import type { OverageInfo, ToolLimitResult } from "./types.ts";

/** Pi stores one credential per upstream provider in
 * `<configDir>/auth.json` — the same file `identities/pi-auth.ts` writes at
 * import time and Pi itself keeps refreshed. Two shapes exist, matching what
 * the upstream actually uses: OAuth accounts (access/refresh/expires-ms) and
 * static API keys. */
export interface PiAuthEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
}

export type PiAuthFile = Record<string, PiAuthEntry>;

/** Providers whose limits are already fetched through a native AIS tool
 * against the SAME account: Pi's credentials for these were imported from
 * those very tools (see identities/pi-auth.ts), and each native fetcher
 * reaches its own upstream through its client's own authenticated path —
 * something Pi's stored copy can't reproduce (Claude/Codex/Grok limit reads
 * go through the native CLI itself, and the Alibaba Token plan has no
 * API-key quota endpoint at all — see ali-limits.ts). Reporting a row here
 * would either duplicate the native tool's row for the same provider +
 * identity or add an unactionable "can't fetch" line, so these are skipped
 * entirely: the provider/identity branch appears once, from the source that
 * can actually answer it. */
const NATIVE_COVERED_PI_PROVIDERS = new Set(["anthropic", "openai-codex", "xai", "alibaba-plan"]);

async function readPiAuth(configDir: string): Promise<PiAuthFile | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(join(configDir, "auth.json")).text()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as PiAuthFile;
  } catch {
    return undefined;
  }
}

/** Write a refreshed OAuth credential back into Pi's own auth.json —
 * read-modify-write preserving every other provider entry and unknown keys,
 * atomically (temp file + rename) and mode 0600, the same discipline
 * identities/pi-auth.ts and kimi-limits.ts apply to their own stores. */
async function persistKimiCredential(configDir: string, updated: KimiOAuthCredentials): Promise<void> {
  const authPath = join(configDir, "auth.json");
  const auth = await readPiAuth(configDir);
  if (!auth) throw new Error("could not re-read Pi auth.json to persist the refreshed token");
  const existing = auth["kimi-coding"];
  auth["kimi-coding"] = {
    ...(typeof existing === "object" && existing !== null ? existing : {}),
    type: "oauth",
    access: updated.access_token,
    ...(updated.refresh_token ? { refresh: updated.refresh_token } : {}),
    ...(updated.expires_at !== undefined ? { expires: updated.expires_at * 1000 } : {}),
  };
  const temporary = `${authPath}.ais-${process.pid}-${crypto.randomUUID()}`;
  try {
    await mkdir(join(configDir), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, authPath);
    await chmod(authPath, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function piKimiCredentials(entry: PiAuthEntry): KimiOAuthCredentials | undefined {
  if (entry.type !== "oauth" || typeof entry.access !== "string" || entry.access.length === 0) return undefined;
  return {
    access_token: entry.access,
    ...(typeof entry.refresh === "string" && entry.refresh.length > 0 ? { refresh_token: entry.refresh } : {}),
    ...(typeof entry.expires === "number" && Number.isFinite(entry.expires) ? { expires_at: Math.floor(entry.expires / 1000) } : {}),
  };
}

function result(
  toolName: "pi",
  provider: string,
  identity: Identity,
  fields: Pick<ToolLimitResult, "status" | "windows"> & { error?: string; overage?: OverageInfo },
): ToolLimitResult {
  return {
    toolName,
    provider: canonicalUsageProvider(provider),
    identity,
    windows: fields.windows,
    status: fields.status,
    ...(fields.error ? { error: fields.error } : {}),
    ...(fields.overage ? { overage: fields.overage } : {}),
    ...(fields.status === "live" ? { capturedAt: new Date().toISOString() } : {}),
  };
}

function unavailable(toolName: "pi", provider: string, identity: Identity, error: string): ToolLimitResult {
  return result(toolName, provider, identity, { status: "unavailable", windows: [], error });
}

/** Live windows from a Z.ai API key stored under Pi's `zai` entry — the same
 * quota endpoint the zai tool's fetcher uses; only the key's home differs. */
async function zaiResult(toolName: "pi", identity: Identity, entry: PiAuthEntry): Promise<ToolLimitResult | undefined> {
  if (typeof entry.key !== "string" || entry.key.length === 0) return undefined;
  const outcome = await fetchZaiQuotaForKey(entry.key);
  if (outcome.error || !outcome.windows) return unavailable(toolName, "zai", identity, outcome.error ?? "quota fetch failed");
  return result(toolName, "zai", identity, { status: "live", windows: outcome.windows });
}

async function kimiResult(toolName: "pi", identity: Identity, entry: PiAuthEntry): Promise<ToolLimitResult | undefined> {
  const credentials = piKimiCredentials(entry);
  if (!credentials) return undefined;
  const outcome = await fetchKimiUsageForCredentials(credentials, (next) => persistKimiCredential(identity.configDir, next));
  if (outcome.error || !outcome.windows) return unavailable(toolName, "kimi", identity, outcome.error ?? "usage fetch failed");
  return result(toolName, "kimi", identity, {
    status: "live",
    windows: outcome.windows,
    ...(outcome.overage ? { overage: outcome.overage } : {}),
  });
}

/** OpenCode Go is a Pi-native provider with no AIS tool of its own and no
 * known quota endpoint for its keys — reported honestly rather than silently
 * dropped, so the OpenCode Go section still shows which identities hold one. */
function opencodeGoResult(toolName: "pi", identity: Identity, entry: PiAuthEntry): ToolLimitResult | undefined {
  if (typeof entry.key !== "string" || entry.key.length === 0) return undefined;
  return unavailable(toolName, "opencode-go", identity, "no limits API is known for OpenCode Go keys yet");
}

/** The auth.json entries this adapter will act on, in file order, with every
 * skip decision already applied: native-covered providers are dropped (their
 * branch comes from the native tool), providers with no fetcher and no
 * coverage decision are dropped (never guessed at), and only entries whose
 * credential is in the shape the corresponding fetch needs survive. Pure —
 * exported for tests. */
export function fetchablePiProviders(auth: PiAuthFile): Array<{ provider: string; entry: PiAuthEntry }> {
  const fetchable: Array<{ provider: string; entry: PiAuthEntry }> = [];
  for (const [piProvider, entry] of Object.entries(auth)) {
    const provider = canonicalUsageProvider(piProvider);
    if (NATIVE_COVERED_PI_PROVIDERS.has(provider)) continue;
    if (provider === "zai") {
      if (typeof entry.key !== "string" || entry.key.length === 0) continue;
    } else if (provider === "kimi") {
      if (!piKimiCredentials(entry)) continue;
    } else if (provider === "opencode-go") {
      if (typeof entry.key !== "string" || entry.key.length === 0) continue;
    } else {
      continue;
    }
    fetchable.push({ provider, entry });
  }
  return fetchable;
}

/**
 * Limits for one Pi identity, one result per upstream provider Pi can
 * actually answer for — Pi is a multi-provider client, so the provider-first
 * report gets its Pi-sourced rows from here rather than a per-tool blob.
 *
 * Fetchable today: `zai` (static API key, same quota endpoint as the zai
 * tool) and `kimi-coding` (OAuth, same usages endpoint as the kimi tool,
 * with refresh-and-persist back into Pi's own auth.json). Native-covered
 * providers are skipped (see NATIVE_COVERED_PI_PROVIDERS); a provider whose
 * entry isn't in a fetchable shape is skipped too. With no readable
 * auth.json the identity contributes nothing to an unscoped report; an
 * explicit `ais limits --tool=pi` gets one honest "unavailable" row instead
 * of silence (same explicit-question rule as the usage pipeline).
 */
export async function fetchPiLimits(identity: Identity, explicitTool = false): Promise<ToolLimitResult[]> {
  const auth = await readPiAuth(identity.configDir);
  if (!auth) {
    return explicitTool ? [unavailable("pi", "unattributed", identity, "no readable Pi auth.json — nothing to fetch limits from")] : [];
  }

  const results: ToolLimitResult[] = [];
  for (const { provider, entry } of fetchablePiProviders(auth)) {
    if (provider === "zai") {
      const r = await zaiResult("pi", identity, entry);
      if (r) results.push(r);
    } else if (provider === "kimi") {
      const r = await kimiResult("pi", identity, entry);
      if (r) results.push(r);
    } else if (provider === "opencode-go") {
      const r = opencodeGoResult("pi", identity, entry);
      if (r) results.push(r);
    }
  }

  if (results.length === 0 && explicitTool) {
    return [unavailable("pi", "unattributed", identity, "no fetchable Pi providers configured (native tools cover the rest)")];
  }
  return results;
}
