import { basename } from "node:path";
import { homedir } from "node:os";
import { resolveAwsProfileForIdentity, type AwsProfileDeps, type AwsProfileTarget } from "../identities/aws-profile.ts";
import type { Identity, ToolConfig } from "../identities/types.ts";
import { periodStartForTimeUnit } from "./state.ts";
import type { AccountSpendState } from "./state.ts";
import { estimateIdentityLocalSpend } from "./local-estimate.ts";
import { cacheAgeS, loadSpendGuardCache, type SpendGuardCache } from "./cache.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The LAUNCH GATE: every wrapped session start flows through here before
 * the real binary (or the desktop app) is spawned. Semantics, fixed by
 * design and with NO override of any kind:
 *
 *   - The gate applies only when the active identity resolves to an AWS
 *     account through the machine-local mapping (identities/aws-profile.ts).
 *     No mapping -> the gate is invisible (<50ms: one tiny config read).
 *   - A cached account state is the enforcement input, whatever its age:
 *     enforcement runs on LAST-KNOWN state, refreshed opportunistically in
 *     the background (detached `ais __spend_refresh`). A fresh cache makes
 *     the whole gate a single JSON read.
 *   - enforced && breached -> print the refusal (account, budget, cap,
 *     local estimate vs real spend, period) and exit non-zero. There is no
 *     env var, no flag, no interactive bypass; editing the budget in AWS or
 *     the machine-local mapping is the only escape.
 *   - No cached state for the account (first launch after setup, cache
 *     deleted): the cap is unknowable offline, so the launch is ALLOWED but
 *     loudly warned, the local estimate is computed inline (fast, offline)
 *     for the warning, and a background refresh is queued. Never block on
 *     missing data; never silently skip either.
 *   - Degraded (cap unfetchable): allow, but say so out loud every launch.
 */

export interface LaunchGateOutcome {
  /** True when the identity mapped to an AWS account (the gate had skin in
   * the game, even when it allowed). */
  applies: boolean;
  decision: "allow" | "block";
  state?: AccountSpendState;
  /** Full multi-line refusal text for stderr when blocked. */
  refusal?: string;
  /** One-line stderr notice when allowed but degraded/unmonitored. */
  warn?: string;
  /** True when a background refresh should be spawned (stale or missing
   * cache). */
  refresh: boolean;
}

export interface LaunchGateDeps {
  cache?: SpendGuardCache;
  now?: () => Date;
  intervalS?: number;
  awsProfileDeps?: AwsProfileDeps;
  /** Injectable inline estimator (tests); default computes the local
   * estimate from the identity's own session logs. */
  inlineEstimate?: (periodStart: Date) => number;
  /** Pre-resolved profile target (tests); presence in deps skips the real
   * mapping resolution entirely (use `target: undefined` for "no mapping"). */
  target?: AwsProfileTarget | undefined;
}

export const LAUNCH_GATE_FRESHNESS_FALLBACK_S = 300;

export function evaluateLaunchGate(toolName: ToolConfig["toolName"], identityName: string, deps: LaunchGateDeps): LaunchGateOutcome {
  const now = deps.now?.() ?? new Date();
  const intervalS = deps.intervalS ?? LAUNCH_GATE_FRESHNESS_FALLBACK_S;

  let target: AwsProfileTarget | undefined;
  if ("target" in deps) {
    target = deps.target;
  } else {
    try {
      target = resolveAwsProfileForIdentity({ name: identityName, label: identityName, configDir: "" } as Identity, deps.awsProfileDeps);
    } catch (err) {
      return {
        applies: false,
        decision: "allow",
        refresh: false,
        warn: `AWS spend guard: the identity->AWS mapping is invalid (${err instanceof Error ? err.message : String(err)}) — launch allowed, account unmonitored this launch`,
      };
    }
  }
  const accountId = target?.accountId;
  if (!target || !accountId) return { applies: false, decision: "allow", refresh: false };

  const suffix = accountId.slice(-4);
  const cache = deps.cache;
  const state = cache?.accounts[accountId];
  const stale = (age: number | undefined): boolean => age === undefined || age > intervalS;
  const needsRefresh = stale(cacheAgeS(cache, now));

  if (state) {
    if (state.enforced && state.breached) {
      return {
        applies: true,
        decision: "block",
        state,
        refusal: buildRefusal(toolName, identityName, state),
        refresh: needsRefresh,
      };
    }
    if (state.degraded) {
      return {
        applies: true,
        decision: "allow",
        state,
        refresh: needsRefresh,
        warn: `AWS spend guard: account ...${suffix} is UNENFORCED (${state.reason}) — launches not gated this cycle`,
      };
    }
    return { applies: true, decision: "allow", state, refresh: needsRefresh };
  }

  // No cached state: the cap is unknowable offline. Compute the local
  // estimate inline so the warning says something real, allow, refresh.
  const inlineUsd = deps.inlineEstimate?.(periodStartForTimeUnit("MONTHLY", now)) ?? 0;
  return {
    applies: true,
    decision: "allow",
    refresh: true,
    warn:
      `AWS spend guard: no spend state cached for account ...${suffix} (cap unknown this launch); ` +
      `local estimate so far this month $${inlineUsd.toFixed(2)}; background refresh queued — launches not gated until the first cycle`,
  };
}

/** Local "YYYY-MM-DD" from an ISO timestamp (an ISO slice would show the
 * UTC date, a day off for UTC+ timezones). */
function localDay(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso.slice(0, 10);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The refusal is the user's complete picture: which account, which budget,
 * the cap, what the guard is enforcing on, the two spend signals behind it,
 * and the only escape that exists. */
export function buildRefusal(toolName: ToolConfig["toolName"], identityName: string, state: AccountSpendState): string {
  const lines = [
    `${toolName}: launch REFUSED for identity "${identityName}" — AWS account ...${state.accountId.slice(-4)} (profile ${state.profile}) is over its spend cap.`,
  ];
  if (state.budgetName !== undefined && state.budgetLimitUsd !== undefined) {
    lines.push(
      `  budget: ${state.budgetName}  cap $${state.budgetLimitUsd.toFixed(2)}  enforcing on $${state.effectiveUsd.toFixed(2)}`,
    );
  } else {
    lines.push(`  enforcing on $${state.effectiveUsd.toFixed(2)}`);
  }
  const real = state.realReportedUsd !== undefined ? `Cost Explorer $${state.realReportedUsd.toFixed(2)}` : undefined;
  const actual = state.budgetActualUsd !== undefined ? `budget actual $${state.budgetActualUsd.toFixed(2)}` : undefined;
  if (real || actual) {
    lines.push(`  local estimate $${state.localEstimateUsd.toFixed(2)}; AWS-reported this cycle: ${[real, actual].filter(Boolean).join(", ")}`);
  } else {
    lines.push(`  local estimate $${state.localEstimateUsd.toFixed(2)} (no AWS-reported figure this cycle)`);
  }
  if (state.periodStart !== undefined) {
    lines.push(`  period since ${localDay(state.periodStart)}${state.periodEnd ? `, resets ${localDay(state.periodEnd)}` : ""}`);
  }
  lines.push("  New wrapped sessions for this account are blocked, and active sessions are being terminated.");
  lines.push("  There is no override flag or env var: raise or remove the budget in AWS to resume.");
  return lines.join("\n");
}

/** Same discovery as sync/background.ts's detached sync worker: prefer the
 * installed shim sibling, fall to PATH. */
function resolveInstalledAisBinary(): string | undefined {
  const shimDir = process.env.AI_PROFILE_SWITCHER_SHIM_DIR ?? join(homedir(), ".local", "bin");
  const sibling = join(shimDir, "ais");
  return existsSync(sibling) ? sibling : Bun.which("ais") ?? undefined;
}

export function triggerBackgroundSpendRefresh(
  deps: { resolveBinary?: () => string | undefined; spawn?: (binary: string) => void } = {},
): boolean {
  const binary = (deps.resolveBinary ?? resolveInstalledAisBinary)();
  if (!binary) return false;
  try {
    const spawn = deps.spawn ?? ((bin: string) => {
      Bun.spawn([bin, "__spend_refresh"], {
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      }).unref();
    });
    spawn(binary);
    return true;
  } catch {
    return false;
  }
}

/** The run-wrapper entry point: resolve the active identity name exactly as
 * the wrapper does (registry identity name, else config-dir basename),
 * evaluate the gate, and queue the background refresh when needed. Blocking
 * is the CALLER's job (it owns process.exit), keeping this testable. */
export async function runLaunchGate(args: {
  toolName: ToolConfig["toolName"];
  identity?: Identity;
  configDir: string;
  cachePath?: string;
  intervalS?: number;
  refresh?: typeof triggerBackgroundSpendRefresh;
}): Promise<LaunchGateOutcome> {
  const identityName = args.identity?.name ?? basename(args.configDir.replace(/\/$/, ""));
  const cache = await loadSpendGuardCache(args.cachePath);
  const outcome = evaluateLaunchGate(args.toolName, identityName, {
    cache,
    intervalS: args.intervalS,
    inlineEstimate: (periodStart: Date) => estimateIdentityLocalSpend(args.toolName, args.configDir, periodStart).usd,
  });
  if (outcome.refresh) (args.refresh ?? triggerBackgroundSpendRefresh)();
  return outcome;
}
