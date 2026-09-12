import type { Identity } from "../../identities/types.ts";
import { oauthRefreshHealth } from "../../identities/oauth-refresh.ts";
import { lastRefreshState } from "../../server/auth-refresh.ts";
import { fetchCodexLimits } from "../limits/codex-limits.ts";
import type { DoctorResult } from "./types.ts";

/**
 * Reuses limits/codex-limits.ts's existing live handshake (`codex app-server
 * --stdio`'s `initialize` + `account/rateLimits/read`) rather than
 * re-implementing its JSON-RPC/NDJSON framing here — that framing was
 * hard-won (see codex-limits.ts's own doc comment) and this probe needs
 * nothing beyond "did the process answer in time," which that call already
 * tells us via its own `controller.signal.aborted`-based timeout detection.
 *
 * When the probe fails on auth, the expired-access states are rendered
 * distinctly: an expired access token with a live refresh token is
 * REFRESHABLE (the daemon's proactive refresher renews it inside the expiry
 * window; `ais auth refresh <identity> --tool=codex` heals it on demand),
 * while a refresh token the provider has revoked (the scheduler's pinned
 * diagnosis) means re-login is the only fix. A refresh is never triggered
 * from the doctor itself.
 */
export async function probeCodexDoctor(identity: Identity): Promise<DoctorResult> {
  const base = { toolName: "codex" as const, identity };
  const startedAt = Date.now();
  const result = await fetchCodexLimits(identity);
  const elapsedMs = Date.now() - startedAt;

  if (result.status === "live") return { ...base, status: "responsive", elapsedMs };

  const error = result.error ?? "";
  if (error.includes("did not respond within")) {
    return { ...base, status: "hung", elapsedMs, detail: error };
  }
  if (error.startsWith("Could not locate the real")) {
    return { ...base, status: "unavailable", detail: error };
  }
  // Auth rejections get the refreshable-vs-revoked classification so the
  // two fixes (wait for / run a refresh vs re-login) are never confused.
  if (/token_expired|http 401|\b401\b|unauthorized|token.*expired|expired.*token/i.test(error)) {
    const state = await lastRefreshState("codex", identity.name).catch(() => undefined);
    const health = await oauthRefreshHealth("codex", identity, state?.revokedFingerprint ?? undefined).catch(
      () => undefined,
    );
    if (health?.state === "revoked") {
      return { ...base, status: "degraded", elapsedMs, statusWord: "revoked - re-login required", detail: health.detail };
    }
    if (health?.state === "expired-refreshable") {
      return { ...base, status: "degraded", elapsedMs, statusWord: "token expired (refreshable)", detail: health.detail };
    }
    if (health?.state === "expired-no-refresh-token") {
      return {
        ...base,
        status: "degraded",
        elapsedMs,
        statusWord: "token expired (no refresh token)",
        detail: health.detail,
      };
    }
  }
  // Any other "unavailable" (auth gate, no rate-limit windows, ...) still
  // means the process answered within budget — just with nothing usable.
  return { ...base, status: "responsive", elapsedMs, detail: error || undefined };
}
