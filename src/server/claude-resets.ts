import { randomUUID } from "node:crypto";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { loadLastGood, saveLastGood } from "../cli/limits/claude-limits.ts";
import { CLAUDE_RESETS_USER_AGENT, CLAUDE_USAGE_BETA, usableAccessToken, type FetchUsageDeps } from "../identities/claude-usage-api.ts";
import { isSwapPool } from "../identities/pool/swap-pool.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { Identity } from "../identities/types.ts";
import { aisCacheDir } from "../shared/ais-home.ts";
import { HttpError } from "./types.ts";

/**
 * Spends one Claude reset grant (cedar_ember), the same call Claude Code's
 * /limit-reset makes: the org uuid from GET /api/oauth/profile, then
 * POST /api/organizations/<uuid>/reset_rate_limits with the account's own
 * OAuth token. The console asks for confirmation before calling this.
 */

export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const claudeResetUrl = (orgUuid: string): string => `https://api.anthropic.com/api/organizations/${encodeURIComponent(orgUuid)}/reset_rate_limits`;

export interface UseResetResult {
  identity: string;
  grantId: string;
  result: string;
  resetsLeft?: number;
  cleared: string[];
  cooldownUntil?: string;
}

export interface UseResetDeps extends FetchUsageDeps {
  /** Resolves the identity (tests); defaults to the claude registry. */
  resolveIdentity?: (name: string) => Promise<Identity>;
  newRequestId?: () => string;
}

const TIMEOUT_MS = 15_000;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

async function registryIdentity(name: string): Promise<Identity> {
  const file = await loadIdentitiesFile(TOOL_CONFIGS.claude.identitiesJsonPath);
  const found = findIdentityByNameOrAlias(file.identities, name);
  if (!found) throw new HttpError(404, `no claude identity "${name}"`);
  return found;
}

/** Short safe reason from an Anthropic error body; never echoes headers or tokens. */
async function reason(res: Response): Promise<string> {
  const body = (await res.json().catch(() => undefined)) as { error?: { message?: unknown; type?: unknown } | string; detail?: unknown } | undefined;
  const err = body?.error;
  const text = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : typeof body?.detail === "string" ? body.detail : "";
  return text ? `: ${text.slice(0, 200)}` : "";
}

export async function useClaudeReset(identityName: string, grantId: string, deps: UseResetDeps = {}): Promise<UseResetResult> {
  if (!GRANT_ID.test(grantId)) throw new HttpError(400, "invalid grant id");
  const identity = await (deps.resolveIdentity ?? registryIdentity)(identityName);
  if (identity.retired) throw new HttpError(409, `identity "${identity.name}" is retired`);
  // A pool mirrors its active member's login: spending through it would hit whichever member is active.
  if (isSwapPool(identity)) throw new HttpError(409, `"${identity.name}" is a swap pool; use the reset on the member account`);
  const { token, error } = await usableAccessToken(identity, deps);
  if (!token) throw new HttpError(409, `no usable Claude login for "${identity.name}": ${error ?? "no token"}`);
  const doFetch = deps.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": CLAUDE_USAGE_BETA,
    "User-Agent": CLAUDE_RESETS_USER_AGENT,
    Accept: "application/json",
  };

  let profile: Response;
  try {
    profile = await doFetch(CLAUDE_PROFILE_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, "Anthropic profile endpoint unreachable");
  }
  if (!profile.ok) throw new HttpError(502, `Anthropic profile answered HTTP ${profile.status}${await reason(profile)}`);
  const org = ((await profile.json().catch(() => undefined)) as { organization?: { uuid?: unknown } } | undefined)?.organization?.uuid;
  if (typeof org !== "string" || org === "") throw new HttpError(502, "Anthropic profile has no organization uuid");

  let res: Response;
  try {
    res = await doFetch(claudeResetUrl(org), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: (deps.newRequestId ?? randomUUID)() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, "Anthropic reset endpoint unreachable");
  }
  if (!res.ok) {
    const status = res.status === 400 || res.status === 403 || res.status === 404 || res.status === 409 || res.status === 429 ? res.status : 502;
    throw new HttpError(status, `Anthropic refused the reset (HTTP ${res.status})${await reason(res)}`);
  }
  const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const resetsLeft = typeof body.resets_left === "number" ? body.resets_left : undefined;
  const cooldownUntil = typeof body.cooldown_until === "string" ? body.cooldown_until : undefined;
  const out: UseResetResult = {
    identity: identity.name,
    grantId: typeof body.grant_id === "string" ? body.grant_id : grantId,
    result: typeof body.result === "string" ? body.result : "unknown",
    ...(resetsLeft !== undefined ? { resetsLeft } : {}),
    cleared: Array.isArray(body.cleared) ? body.cleared.map((c) => (typeof c === "string" ? c : JSON.stringify(c))) : [],
    ...(cooldownUntil ? { cooldownUntil } : {}),
  };
  await recordSpend(identity, out, deps.cacheDir ?? aisCacheDir());
  return out;
}

/** Updates the cached grant list so the Limits page shows the new count before the next read. Never fails the spend. */
async function recordSpend(identity: Identity, spent: UseResetResult, cacheDir: string): Promise<void> {
  try {
    const last = await loadLastGood(identity, cacheDir);
    const reset = last?.manualReset;
    if (!last || !reset?.grants) return;
    const grants = reset.grants.map((g) =>
      g.id !== spent.grantId ? g : { ...g, ...(spent.resetsLeft !== undefined ? { resetsLeft: spent.resetsLeft, usableNow: g.usableNow && spent.resetsLeft > 0 } : { usableNow: false }) },
    );
    const availableCount = grants.filter((g) => g.usableNow).reduce((n, g) => n + g.resetsLeft, 0);
    await saveLastGood(identity, { ...last, manualReset: { ...reset, grants, availableCount, ...(spent.cooldownUntil ? { cooldownUntil: spent.cooldownUntil } : {}) } }, cacheDir);
  } catch {
    // Bookkeeping only.
  }
}
