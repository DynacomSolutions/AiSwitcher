import type { AwsProfileDeps } from "../identities/aws-profile.ts";
import { resolveAwsProfileForIdentity } from "../identities/aws-profile.ts";
import type { ToolLimitResult } from "../cli/limits/types.ts";
import type { SpendGuardMode } from "./config.ts";
import type { SpendGuardCache } from "./cache.ts";

/**
 * Surfaces the spend guard's last-known account state on `ais limits` AWS
 * Bedrock rows: a breached account's budget windows carry the loud
 * over-cap note, qualified by the machine-local mode ("warning only, not
 * blocking" for the default warn response; "launches blocked, active
 * sessions terminated" for enforce), and a degraded (unenforced) account
 * says why. Healthy accounts stay silent — the bars already tell that
 * story. Read-only over the shared cache; the daemon (or the gate's
 * detached refresh) keeps it current.
 */

export function annotateWithSpendGuard(
  results: ToolLimitResult[],
  cache: SpendGuardCache | undefined,
  deps: { awsProfileDeps?: AwsProfileDeps; mode?: SpendGuardMode } = {},
): ToolLimitResult[] {
  if (!cache || Object.keys(cache.accounts).length === 0) return results;
  return results.map((result) => {
    let accountId: string | undefined;
    try {
      accountId = resolveAwsProfileForIdentity(result.identity, deps.awsProfileDeps)?.accountId;
    } catch {
      return result; // malformed mapping: rows render exactly as before
    }
    const state = accountId !== undefined ? cache.accounts[accountId] : undefined;
    if (!state) return result;

    let note: string | undefined;
    if (state.breached && state.enforced) {
      note =
        deps.mode === "enforce"
          ? "SPEND GUARD: over cap — new launches blocked, active sessions terminated"
          : "SPEND GUARD: over cap — warning only, not blocking (set mode=enforce in ~/.ais/config/spend-guard.json to block)";
    } else if (state.degraded) {
      note = `spend guard: unenforced (${state.reason})`;
    }
    if (note === undefined) return result;

    return {
      ...result,
      windows: result.windows.map((w) => ({ ...w, ...(w.note ? { note: `${w.note}; ${note}` } : { note }) })),
    };
  });
}
