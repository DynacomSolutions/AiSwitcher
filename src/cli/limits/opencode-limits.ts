import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { canonicalUsageProvider } from "../usage/providers.ts";
import { fetchWithRetry } from "./http.ts";
import { fetchZaiQuotaForKey } from "./zai-limits.ts";
import type { LimitCategory, LimitWindow, ToolLimitResult } from "./types.ts";

/** OpenCode keeps one credential per upstream provider in
 * `<configDir>/data/opencode/auth.json` (its XDG data root, redirected into
 * the identity's own `data/` subdirectory by OPENCODE_CONFIG's
 * extraEnvVarNames). OpenCode v2 migrates those legacy credentials once,
 * then writes new/updated credentials ONLY to
 * `<configDir>/data/opencode/opencode.db` table `credential`; auth.json is
 * never updated again, so its entries can be stale (the live 2026-10-25 401:
 * a fresh Console login landed in the db while auth.json kept the dead
 * `opencode-go` key). This adapter reads both: v2 db rows win per provider,
 * auth.json remains the fallback for v1 or when the db/table/usable row is
 * absent. */
export interface OpencodeAuthEntry {
  type?: string;
  key?: string;
}

export type OpencodeAuthFile = Record<string, OpencodeAuthEntry>;

/** `zai_coding_plan`/`alibaba_token_plan` are OpenCode's ids for the same
 * upstream plans the zai/ali tools serve — canonicalUsageProvider already
 * aliases them onto zai/alibaba. alibaba is additionally native-covered: the
 * Token plan has no API-key quota endpoint (see ali-limits.ts), so its
 * provider branch comes from the ali tool's console-cookie fetch or not at
 * all. */
const NATIVE_COVERED_OPENCODE_PROVIDERS = new Set(["alibaba"]);

async function readOpencodeAuth(configDir: string): Promise<OpencodeAuthFile | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(join(configDir, "data", "opencode", "auth.json")).text()) as unknown;
    if (typeof parsed !== "object" && parsed === null) return undefined;
    if (typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as OpencodeAuthFile;
  } catch {
    return undefined;
  }
}

/** Live v2 schema: `credential(id, integration_id, label, value,
 * connector_id, method_id, active, time_created, time_updated)`. Only the
 * four columns this adapter needs are read; `value` is credential JSON and
 * is parsed but never logged. */
interface OpencodeV2CredentialRow {
  integration_id?: unknown;
  value?: unknown;
  active?: unknown;
  time_updated?: unknown;
}

/** One usable v2 credential: the object form's static `key`, or an OAuth
 * grant's `access` token (OpenCode's Go gateway accepts the access token as
 * the Authorization credential for the quota request). Anything else is
 * unusable. */
function parseOpencodeV2CredentialValue(value: unknown): OpencodeAuthEntry | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const key =
    typeof record.key === "string" && record.key.length > 0
      ? record.key
      : typeof record.access === "string" && record.access.length > 0
        ? record.access
        : undefined;
  if (!key) return undefined;
  return { type: typeof record.type === "string" ? record.type : undefined, key };
}

/** The v2 db renamed the Go plan's integration to `opencode`; AIS keeps
 * the `opencode-go` provider id, mapped HERE only: canonicalUsageProvider
 * intentionally leaves `opencode` as the multi-provider wrapper label for
 * usage attribution elsewhere. */
function opencodeV2CredentialProvider(integrationId: string): string {
  return integrationId === "opencode" ? "opencode-go" : canonicalUsageProvider(integrationId);
}

/** Usable OpenCode v2 credentials from the identity's opencode.db, one per
 * fetchable provider (the newest row wins when several collapse to the same
 * provider). Active semantics: explicit `active = 0` rows are excluded;
 * `active = 1` and null-active imported/legacy rows are both usable. Returns
 * undefined when the db or table is absent/unreadable (v1 installs), and []
 * when the db WAS read but held no usable row; auth.json stays the fallback
 * in both cases, but only the undefined case means the v2 store itself was
 * not readable. */
async function readOpencodeV2Credentials(
  configDir: string,
): Promise<Array<{ provider: string; entry: OpencodeAuthEntry }> | undefined> {
  let db: Database;
  try {
    db = new Database(join(configDir, "data", "opencode", "opencode.db"), { readonly: true });
  } catch {
    return undefined;
  }
  try {
    const rows = db.query("SELECT integration_id, value, active, time_updated FROM credential").all() as OpencodeV2CredentialRow[];
    const newestByProvider = new Map<string, { entry: OpencodeAuthEntry; timeUpdated: number }>();
    for (const row of rows) {
      if (row.active === 0) continue;
      if (typeof row.integration_id !== "string" || row.integration_id.length === 0) continue;
      const provider = opencodeV2CredentialProvider(row.integration_id);
      if (NATIVE_COVERED_OPENCODE_PROVIDERS.has(provider)) continue;
      if (provider !== "zai" && provider !== "opencode-go") continue;
      const entry = parseOpencodeV2CredentialValue(row.value);
      if (!entry) continue;
      const timeUpdated = typeof row.time_updated === "number" && Number.isFinite(row.time_updated) ? row.time_updated : 0;
      const existing = newestByProvider.get(provider);
      if (!existing || timeUpdated >= existing.timeUpdated) newestByProvider.set(provider, { entry, timeUpdated });
    }
    return [...newestByProvider.entries()].map(([provider, { entry }]) => ({ provider, entry }));
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function unavailable(identity: Identity, error: string): ToolLimitResult {
  return { toolName: "opencode", provider: "unattributed", identity, windows: [], status: "unavailable", error };
}

/** The auth.json entries this adapter will act on, in file order, with every
 * skip decision already applied: native-covered plans are dropped (their
 * branch comes from the tool that can actually answer), unknown provider ids
 * are dropped (never guessed at), and only entries with a usable API key
 * survive. Pure — exported for tests. */
export function fetchableOpencodeProviders(auth: OpencodeAuthFile): Array<{ provider: string; entry: OpencodeAuthEntry }> {
  const fetchable: Array<{ provider: string; entry: OpencodeAuthEntry }> = [];
  for (const [opencodeProvider, entry] of Object.entries(auth)) {
    const provider = canonicalUsageProvider(opencodeProvider);
    if (NATIVE_COVERED_OPENCODE_PROVIDERS.has(provider)) continue;
    if (provider !== "zai" && provider !== "opencode-go") continue;
    if (typeof entry.key !== "string" || entry.key.length === 0) continue;
    fetchable.push({ provider, entry });
  }
  return fetchable;
}

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const FETCH_TIMEOUT_MS = 10_000;

/** Wire shape of `GET https://opencode.ai/zen/go/v1/usage`, confirmed live
 * 2026-09-03 against the user's own Go plan (mid-weekly-limit, which is how
 * the endpoint was found): three windows keyed by plan period, each with a
 * 0-100 `percent` (the plan's windows are DOLLAR-denominated — $12 per 5h,
 * $30 weekly, $60 monthly — so the percentage is share-of-window-budget),
 * a status ("ok" / "rate-limited" when the window is exhausted), and an ISO
 * `resetsAt`. */
export interface OpencodeGoUsageWire {
  usage?: {
    rolling?: { status?: string; percent?: number; resetsAt?: string };
    weekly?: { status?: string; percent?: number; resetsAt?: string };
    monthly?: { status?: string; percent?: number; resetsAt?: string };
  };
}

function windowFrom(
  label: string,
  category: LimitCategory,
  window: { status?: string; percent?: number; resetsAt?: string } | undefined,
): LimitWindow | undefined {
  if (!window || typeof window.percent !== "number") return undefined;
  const resetsAt = window.resetsAt ? new Date(window.resetsAt) : undefined;
  return {
    label,
    category,
    usedPercent: Math.min(100, Math.max(0, window.percent)),
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime())
      ? resetsAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : undefined,
    ...(resetsAt && !Number.isNaN(resetsAt.getTime()) ? { resetsAtMs: resetsAt.getTime() } : {}),
    ...(window.status && window.status !== "ok" ? { note: window.status } : {}),
  };
}

/** Pure mapping from the usage wire shape to display windows, exported so
 * tests can exercise it without any network. The rolling window is the
 * plan's 5-hour bucket (docs: "$12 of usage" per 5h) — labelled like the
 * other tools' session windows. */
export function windowsFromOpencodeGoUsage(resp: OpencodeGoUsageWire): LimitWindow[] {
  const usage = resp.usage;
  if (!usage) return [];
  const windows = [
    windowFrom("session (5h)", "session", usage.rolling),
    windowFrom("week", "week", usage.weekly),
    windowFrom("month", "month", usage.monthly),
  ];
  return windows.filter((w): w is LimitWindow => w !== undefined);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface OpencodeGoQuotaOutcome {
  windows?: LimitWindow[];
  error?: string;
}

/** The live Go-plan quota read for ONE OpenCode Go credential: a legacy
 * auth.json API key, or the OAuth access token from a v2 opencode.db
 * credential row. The user hit
 * their weekly limit with no way to see it (2026-09-03) — this endpoint is
 * the answer, found by probing the Go gateway directly. */
export async function fetchOpencodeGoQuotaForKey(apiKey: string): Promise<OpencodeGoQuotaOutcome> {
  let response: Response;
  try {
    response = await fetchWithRetry(OPENCODE_GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
  } catch (err) {
    return { error: `quota fetch failed: ${errorMessage(err)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { error: `authentication rejected (HTTP ${response.status}) - check this identity's OpenCode Go credential` };
  }
  if (!response.ok) {
    return { error: `quota fetch failed (HTTP ${response.status})` };
  }

  let payload: OpencodeGoUsageWire;
  try {
    payload = (await response.json()) as OpencodeGoUsageWire;
  } catch (err) {
    return { error: `could not parse quota response: ${errorMessage(err)}` };
  }

  const windows = windowsFromOpencodeGoUsage(payload);
  if (windows.length === 0) {
    return { error: "OpenCode Go reported no quota windows" };
  }
  return { windows };
}

/** Canonical provider ids `fetchOpencodeLimits` will answer for, from a cheap
 * local credential read (no network); what the live render seeds pending
 * rows from. Same list as the fetch: legacy auth.json entries plus any
 * usable v2 opencode.db credentials. */
export async function pendingOpencodeProviders(identity: Identity): Promise<string[]> {
  return (await fetchableOpencodeCredentials(identity)).credentials.map((f) => f.provider);
}

/** The merged per-provider credential view for one identity: fetchable
 * legacy auth.json entries first, then usable v2 opencode.db credentials,
 * which OVERRIDE the legacy entry for the same provider (v2 writes never
 * touch auth.json, so a legacy `opencode-go` key can be stale while the db
 * holds the fresh grant). `storeReadable` reports whether AT LEAST ONE store
 * could be read, so the caller can distinguish "nothing readable" from
 * "read fine, nothing fetchable". */
async function fetchableOpencodeCredentials(
  identity: Identity,
): Promise<{ credentials: Array<{ provider: string; entry: OpencodeAuthEntry }>; storeReadable: boolean }> {
  const auth = await readOpencodeAuth(identity.configDir);
  const v2 = await readOpencodeV2Credentials(identity.configDir);
  const merged = new Map<string, OpencodeAuthEntry>();
  if (auth) {
    for (const { provider, entry } of fetchableOpencodeProviders(auth)) merged.set(provider, entry);
  }
  for (const { provider, entry } of v2 ?? []) {
    merged.set(provider, entry);
  }
  return {
    credentials: [...merged.entries()].map(([provider, entry]) => ({ provider, entry })),
    storeReadable: auth !== undefined || v2 !== undefined,
  };
}

/**
 * Limits for one OpenCode identity, one result per upstream provider
 * OpenCode holds a fetchable credential for (the Z.ai coding plan — the
 * same quota endpoint the zai tool's fetcher uses — and OpenCode Go, whose
 * own gateway reports the plan's dollar-window usage). Credentials come from
 * both OpenCode stores: the v2 opencode.db `credential` table wins per
 * provider, legacy auth.json is the fallback (v2 never writes back to it, so
 * its keys can be stale). Everything else is
 * skipped: native-covered plans (alibaba) get their branch from the tool
 * that can actually answer, and unknown provider ids are ignored rather
 * than guessed at. With no readable credential store or no fetchable entries
 * the identity contributes nothing to an unscoped report; an explicit
 * `ais limits --tool=opencode` gets one honest "unavailable" row instead of
 * silence (same explicit-question rule as the usage pipeline).
 */
export async function fetchOpencodeLimits(identity: Identity, explicitTool = false): Promise<ToolLimitResult[]> {
  const { credentials, storeReadable } = await fetchableOpencodeCredentials(identity);
  if (credentials.length === 0) {
    if (!explicitTool) return [];
    return [
      storeReadable
        ? unavailable(identity, "no fetchable OpenCode providers configured (native tools cover the rest)")
        : unavailable(identity, "no readable OpenCode auth.json or credential db - nothing to fetch limits from"),
    ];
  }

  const results: ToolLimitResult[] = [];
  for (const { provider, entry } of credentials) {
    const outcome = provider === "opencode-go" ? await fetchOpencodeGoQuotaForKey(entry.key!) : await fetchZaiQuotaForKey(entry.key!);
    results.push(
      outcome.error || !outcome.windows
        ? { toolName: "opencode", provider, identity, windows: [], status: "unavailable", error: outcome.error ?? "quota fetch failed" }
        : {
            toolName: "opencode",
            provider,
            identity,
            windows: outcome.windows,
            status: "live",
            capturedAt: new Date().toISOString(),
          },
    );
  }

  return results;
}
