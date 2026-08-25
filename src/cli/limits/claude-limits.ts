import type { Identity } from "../../identities/types.ts";
import { spawnCapturedBounded } from "../../shared/exec.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import { categorizeByLabel } from "./bucket.ts";
import type { LimitWindow, OverageInfo, ToolLimitResult } from "./types.ts";

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
export async function fetchClaudeLimits(identity: Identity): Promise<ToolLimitResult> {
  const base: Pick<ToolLimitResult, "toolName" | "identity"> = { toolName: "claude", identity };

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
  return { ...base, windows, status: "live", capturedAt: new Date().toISOString(), ...(overage ? { overage } : {}) };
}
