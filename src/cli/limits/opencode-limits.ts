import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { canonicalUsageProvider } from "../usage/providers.ts";
import { fetchWithRetry } from "./http.ts";
import { fetchZaiQuotaForKey } from "./zai-limits.ts";
import type { LimitCategory, LimitWindow, ToolLimitResult } from "./types.ts";

/** OpenCode keeps one credential per upstream provider in
 * `<configDir>/data/opencode/auth.json` (its XDG data root, redirected into
 * the identity's own `data/` subdirectory by OPENCODE_CONFIG's
 * extraEnvVarNames). Entries are static API credentials — the same key an
 * upstream-owning AIS tool would hold when the credential was provisioned
 * through it. */
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

/** The live Go-plan quota read for ONE OpenCode Go API key. The user hit
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
    return { error: `authentication rejected (HTTP ${response.status}) — check this identity's OpenCode Go API key` };
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

/**
 * Limits for one OpenCode identity, one result per upstream provider
 * OpenCode holds a fetchable credential for (the Z.ai coding plan — the
 * same quota endpoint the zai tool's fetcher uses — and OpenCode Go, whose
 * own gateway reports the plan's dollar-window usage). Everything else is
 * skipped: native-covered plans (alibaba) get their branch from the tool
 * that can actually answer, and unknown provider ids are ignored rather
 * than guessed at. With no readable auth.json or no fetchable entries the
 * identity contributes nothing to an unscoped report; an explicit
 * `ais limits --tool=opencode` gets one honest "unavailable" row instead of
 * silence (same explicit-question rule as the usage pipeline).
 */
export async function fetchOpencodeLimits(identity: Identity, explicitTool = false): Promise<ToolLimitResult[]> {
  const auth = await readOpencodeAuth(identity.configDir);
  if (!auth) {
    return explicitTool
      ? [unavailable(identity, "no readable OpenCode auth.json — nothing to fetch limits from")]
      : [];
  }

  const results: ToolLimitResult[] = [];
  for (const { provider, entry } of fetchableOpencodeProviders(auth)) {
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

  if (results.length === 0 && explicitTool) {
    return [unavailable(identity, "no fetchable OpenCode providers configured (native tools cover the rest)")];
  }
  return results;
}
