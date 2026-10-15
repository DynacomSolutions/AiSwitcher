import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aisCacheDir } from "../../shared/ais-home.ts";
import type { Identity } from "../../identities/types.ts";
import { fetchUsageBodyWithResets, manualResetFromCedarEmber, fetchMemberResets } from "../../identities/claude-usage-api.ts";
import { reconcileOnceForFetch } from "../../identities/oauth-refresh.ts";
import { spawnCapturedBounded } from "../../shared/exec.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import { categorizeByLabel } from "./bucket.ts";
import type { LimitWindow, OverageInfo, FetchedLimitResult } from "./types.ts";

const AUTH_STATUS_TIMEOUT_MS = 10_000;
// Was 30s — bumped after real hangs at 30s turned out to just need more time
// (2026-07-20), not a genuinely stuck process; 90s gives `claude -p "/usage"`
// enough room before this gives up and reports it as hung.
const USAGE_TIMEOUT_MS = 90_000;

// "Current session: 25% used · resets Jul 15 at 2pm (Asia/Bangkok)"
// "Current week (all models): 30% used · resets Jul 18 at 8am (Asia/Bangkok)"
// "Current week (Fable): 0% used"
const USAGE_LINE = /^Current (.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+))?$/;

/** Spawn the real binary with the full inherited environment, only
 * overriding CLAUDE_CONFIG_DIR — NOT a stripped/empty env. Confirmed the
 * hard way: an `env -i`-style stripped environment breaks credential/keychain
 * resolution even for an identity that is unambiguously, actively logged in
 * — every one of identity-a/personal/work falsely reported
 * loggedIn:false until the full environment was preserved instead. Thin
 * wrapper over shared/exec.ts's spawnCapturedBounded (shared with
 * doctor/claude-doctor.ts, which needs the exact same shape). */
async function runReal(
  binaryPath: string,
  args: string[],
  identity: Identity,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  return spawnCapturedBounded(binaryPath, args, { CLAUDE_CONFIG_DIR: identity.configDir }, timeoutMs);
}

function normalizeLabel(raw: string): string {
  if (raw === "session") return "session (5h)";
  if (raw === "week (all models)") return "week (all)";
  return raw;
}

function parseUsageWindows(stdout: string): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const line of stdout.split("\n")) {
    const match = USAGE_LINE.exec(line.trim());
    if (!match) continue;
    const [, rawLabel, pct, resets] = match;
    windows.push({
      label: normalizeLabel(rawLabel!),
      category: categorizeByLabel(rawLabel!),
      usedPercent: Number(pct),
      resetsAt: resets,
    });
  }
  return windows;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function humanReset(iso: unknown): { resetsAt?: string; resetsAtMs?: number } {
  const ms = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return {};
  const resetsAt = new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return { resetsAt, resetsAtMs: ms };
}

/** Windows from the `GET /api/oauth/usage` body: `limits[]` when present, else five_hour/seven_day. */
export function windowsFromUsageBody(body: unknown): LimitWindow[] {
  const rec = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const make = (rawLabel: string, label: string, pct: unknown, resets: unknown): LimitWindow[] =>
    typeof pct === "number" && Number.isFinite(pct)
      ? [{ label, category: categorizeByLabel(rawLabel), usedPercent: pct, ...humanReset(resets) }]
      : [];
  if (Array.isArray(rec.limits)) {
    return rec.limits.flatMap((raw: unknown) => {
      const l = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const kind = str(l.kind) ?? "other";
      const model = (l.scope as { model?: { display_name?: unknown } } | null)?.model?.display_name;
      const surface = (l.scope as { surface?: unknown } | null)?.surface;
      const label =
        kind === "session" ? "session (5h)"
        : kind === "weekly_all" ? "week (all)"
        : kind === "weekly_scoped" ? `week (${str(model) ?? str(surface) ?? "scoped"})`
        : kind;
      // Raw label mirrors what the text path passed, so categorisation is identical.
      const rawLabel = kind === "session" ? "session" : kind.startsWith("weekly") ? "week" : kind;
      return make(rawLabel, label, l.percent, l.resets_at);
    });
  }
  const five = rec.five_hour as Record<string, unknown> | null | undefined;
  const seven = rec.seven_day as Record<string, unknown> | null | undefined;
  return [...make("session", "session (5h)", five?.utilization, five?.resets_at), ...make("week", "week (all)", seven?.utilization, seven?.resets_at)];
}

/** Same semantics as overageFromUsageText, read from the body's `extra_usage` block. */
export function overageFromUsageBody(body: unknown): OverageInfo | undefined {
  const extra = (body as { extra_usage?: Record<string, unknown> | null } | null)?.extra_usage;
  if (typeof extra !== "object" || extra === null) return undefined;
  if (extra.is_enabled !== true) {
    // shortcut: seat-lacks-extra-usage matched by a loose substring on disabled_reason; tighten once real values are seen.
    const reason = str(extra.disabled_reason);
    return reason && /seat|plan|not.?(available|eligible|supported)/i.test(reason)
      ? { active: false, label: "extra usage not available on this seat", spentUsd: 0 }
      : { active: false, label: "subscription only", spentUsd: 0 };
  }
  return extra.spend_limit_reached === true
    ? { active: false, label: "out of extra usage" }
    : { active: true, label: "using extra usage" };
}

/**
 * `/usage`'s own intro sentence (currently discarded — parseUsageWindows only
 * keeps the "Current X: Y% used..." lines below it) already states whether
 * this identity is drawing on real, billed "extra usage" instead of its flat
 * subscription. The four variants below were confirmed by extracting the
 * plain-text UI strings straight out of the installed `claude` binary
 * (`strings` on the compiled executable — the same technique this project
 * already uses elsewhere for undocumented env vars): "You're now using extra
 * usage" / "Now using extra usage", "You're out of extra usage", "Your seat
 * type doesn't include extra usage", alongside the default line confirmed
 * live below. The active-overage wording was NOT observed live — doing so
 * would require actually spending real money on a real account to trigger
 * it — so only the default (confirmed live) and the three known alternates
 * (confirmed from the binary's own strings) are matched; anything else
 * yields undefined rather than guessing at a status. No dollar figure is
 * exposed anywhere in this text or the underlying `GET /api/oauth/usage`
 * fields visible in the same binary.
 *
 * Two of the four variants are confirmed-zero states — "subscription only"
 * (extra usage isn't even engaged) and "not available on this seat" (extra
 * usage isn't a thing this account could ever spend on) both unambiguously
 * mean $0, so they carry `spentUsd: 0` rather than just a label — this is
 * what lets usage/report.ts render them as an actual "$0.00" instead of
 * lumping them in with a genuinely unknown amount. "Using extra usage" and
 * "out of extra usage" are real-or-recent nonzero spend with no known
 * figure, so those stay label-only. A row with NO overage at all (undefined)
 * means the live probe didn't produce usable data — not the same as a
 * confirmed $0 — see fetchClaudeLimits: this function is only reached once
 * parseUsageWindows already found real windows in the same output.
 */
export function overageFromUsageText(stdout: string): OverageInfo | undefined {
  const first = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return undefined;

  if (/now using extra usage/i.test(first)) return { active: true, label: "using extra usage" };
  if (/out of extra usage/i.test(first)) return { active: false, label: "out of extra usage" };
  if (/doesn'?t include extra usage/i.test(first)) {
    return { active: false, label: "extra usage not available on this seat", spentUsd: 0 };
  }
  if (/using your subscription/i.test(first)) return { active: false, label: "subscription only", spentUsd: 0 };
  return undefined;
}

/** The non-interactive `/usage` handler (confirmed live: `claude -p "/usage"`
 * hits the same live `fetchUtilization()` -> `GET /api/oauth/usage` call the
 * interactive dialog uses, printing plain text) is the only mechanism here —
 * no cache, no statusLine wrapper needed. `claude auth status` is checked
 * first, separately, since it's the only reliable signal for "not
 * authenticated" — the /usage output shape for that case was never actually
 * observed live (every identity on this machine turned out to be logged in
 * once the env-stripping bug was fixed), so we don't try to infer it from
 * text parsing. */
export interface ClaudeLimitsDeps {
  /** Test hooks. */
  fetchBody?: typeof fetchUsageBodyWithResets;
  cacheDir?: string;
  reconcile?: typeof reconcileOnceForFetch;
}

function lastGoodPath(identity: Identity, cacheDir: string): string {
  return join(cacheDir, "claude-limits", `${encodeURIComponent(identity.name)}.json`);
}

/** Last successful API read, kept so a 429 can still show (stale) numbers. */
async function saveLastGood(identity: Identity, result: FetchedLimitResult, cacheDir: string): Promise<void> {
  try {
    const { identity: _identity, ...rest } = result;
    const path = lastGoodPath(identity, cacheDir);
    await mkdir(join(cacheDir, "claude-limits"), { recursive: true });
    await writeFile(path, JSON.stringify(rest));
  } catch {
    // Bookkeeping only; never fail a fetch over it.
  }
}

export async function loadLastGood(identity: Identity, cacheDir: string): Promise<FetchedLimitResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lastGoodPath(identity, cacheDir), "utf8")) as Omit<FetchedLimitResult, "identity">;
    return Array.isArray(parsed.windows) && parsed.windows.length > 0 ? { ...parsed, identity } : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchClaudeLimits(identity: Identity, deps: ClaudeLimitsDeps = {}): Promise<FetchedLimitResult> {
  const cacheDir = deps.cacheDir ?? aisCacheDir();
  const base: Pick<FetchedLimitResult, "toolName" | "identity"> = { toolName: "claude", identity };

  // ONE reconcile per fetch, before the binary runs: pi may hold a fresher
  // copy of this account's grant (claude's own copy goes stale whenever pi
  // refreshed the shared account mid-session, and pi's projected copy goes
  // stale whenever claude refreshed on its own). Cheap when the copies
  // agree; never fatal (see oauth-reconcile.ts). kimi is the precedent for
  // this pattern — its fetcher reads the freshest copy and writes a
  // refresh through to both stores; the reconcile is the same law for the
  // stores AIS can only rewrite wholesale.
  await (deps.reconcile ?? reconcileOnceForFetch)("claude", identity);

  // Fast path: one HTTP call. Any failure falls through to the spawn path below.
  const { body, status } = await (deps.fetchBody ?? fetchUsageBodyWithResets)(identity);
  const apiWindows = body === undefined ? [] : windowsFromUsageBody(body);
  if (apiWindows.length > 0) {
    const overage = overageFromUsageBody(body);
    const manualReset = manualResetFromCedarEmber((body as { cedar_ember?: unknown }).cedar_ember);
    const live: FetchedLimitResult = {
      ...base,
      windows: apiWindows,
      status: "live",
      capturedAt: new Date().toISOString(),
      ...(overage ? { overage } : {}),
      ...(manualReset ? { manualReset } : {}),
    };
    await saveLastGood(identity, live, cacheDir);
    return live;
  }
  // 429: the `claude -p /usage` spawn hits the same endpoint, so spawning
  // only adds seconds. Serve the last good read (stale marker comes from its
  // capturedAt) or fail fast.
  if (status === 429) {
    const last = await loadLastGood(identity, cacheDir);
    if (last) return { ...last, status: "cached" };
    return { ...base, windows: [], status: "unavailable", error: "rate-limited by Anthropic usage endpoint, retry shortly" };
  }

  let binaryPath: string;
  try {
    binaryPath = resolveRealBinary("claude");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, windows: [], status: "unavailable", error: message };
  }

  let authStdout: string;
  let authTimedOut: boolean;
  try {
    ({ stdout: authStdout, timedOut: authTimedOut } = await runReal(
      binaryPath,
      ["auth", "status"],
      identity,
      AUTH_STATUS_TIMEOUT_MS,
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, windows: [], status: "unavailable", error: `could not check auth status: ${message}` };
  }
  if (authTimedOut) {
    return {
      ...base,
      windows: [],
      status: "unavailable",
      error: `claude auth status did not respond within ${AUTH_STATUS_TIMEOUT_MS / 1000}s (hung — not a billing issue)`,
    };
  }

  let loggedIn = false;
  try {
    loggedIn = JSON.parse(authStdout).loggedIn === true;
  } catch {
    return { ...base, windows: [], status: "unavailable", error: "could not parse auth status" };
  }
  if (!loggedIn) {
    return { ...base, windows: [], status: "unavailable", error: "not authenticated" };
  }

  let usageStdout: string;
  let usageTimedOut: boolean;
  try {
    ({ stdout: usageStdout, timedOut: usageTimedOut } = await runReal(
      binaryPath,
      ["-p", "/usage", "--no-session-persistence"],
      identity,
      USAGE_TIMEOUT_MS,
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, windows: [], status: "unavailable", error: `usage fetch failed: ${message}` };
  }
  // Confirmed live (2026-07-17) against two real, fully-authenticated
  // Claude.ai identities (team + max plans, 0% usage on both, not an
  // API-key/console-billing account): `claude -p "/usage"` can hang
  // indefinitely with zero output — not a fast auth/billing rejection — for
  // reasons outside this tool (isolated to the real binary itself, no MCP
  // servers, no plugins, reproducible with --strict-mcp-config). That case
  // must not be reported as "no subscription rate-limit data", which reads
  // as a billing-type explanation; it's a hang, plain and simple.
  if (usageTimedOut) {
    return {
      ...base,
      windows: [],
      status: "unavailable",
      error: `claude -p "/usage" did not respond within ${USAGE_TIMEOUT_MS / 1000}s (hung — not a billing issue; try re-authenticating or check for an Anthropic-side incident)`,
    };
  }

  const windows = parseUsageWindows(usageStdout);
  if (windows.length === 0) {
    return {
      ...base,
      windows: [],
      status: "unavailable",
      error: "no subscription rate-limit data (may be using API-key/console billing instead of a Claude.ai plan)",
    };
  }

  const overage = overageFromUsageText(usageStdout);
  // Non-fatal and sequential: it may refresh the token, which must not race the /usage spawn above.
  const manualReset = await fetchMemberResets(identity);
  return {
    ...base,
    windows,
    status: "live",
    capturedAt: new Date().toISOString(),
    ...(overage ? { overage } : {}),
    ...(manualReset ? { manualReset } : {}),
  };
}
