import { randomUUID } from "node:crypto";
import type { ManualResetInfo } from "../cli/limits/types.ts";
import {
  CLAUDE_RESETS_USER_AGENT, CLAUDE_USAGE_URL, manualResetFromCedarEmber, parseUsageBody,
} from "../identities/claude-usage-api.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { AutoResetUsage } from "./auto-reset.ts";
import { claudeAdapter } from "./providers/claude.ts";
import type { ProviderCredential } from "./providers/shared.ts";

const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const claudeResetUrl = (org: string): string => `https://api.anthropic.com/api/organizations/${encodeURIComponent(org)}/reset_rate_limits`;

/** The call behind Claude Code `/limit-reset`. It needs the claude-cli User-Agent, else the grants are not sent. */
export const CLAUDE_RESET_INVENTORY_URL = `${CLAUDE_USAGE_URL}?cedar_ember=1&skip_spend=1`;

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ClaudeResetOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export interface ClaudeResetRead {
  usage: AutoResetUsage;
  credits: ManualResetInfo | undefined;
}

export interface ClaudeResetSelection {
  /** The grant ID that the claim named. */
  id: string;
  /** The grant expiry that the claim named (ISO). */
  endsAt: string;
  signal: AbortSignal;
  now: () => number;
  stillCurrent(): boolean;
  stillEligible(): Promise<boolean>;
  /** Called before the one POST. It marks the claim as spending, and it throws when the claim is not ours. */
  beforePost(): Promise<void>;
  onPost(): void;
}

function headers(credential: ProviderCredential, extra: Record<string, string> = {}): Record<string, string> {
  return { ...claudeAdapter.authHeaders(credential, new Headers()), "user-agent": CLAUDE_RESETS_USER_AGENT, accept: "application/json", ...extra };
}

/**
 * Only a full grant clears the weekly limit of every model. A Fable grant clears one model window, so it never counts.
 * A grant needs a usable count, no pause and an absolute expiry.
 */
export function claudeCreditInventory(info: ManualResetInfo | undefined, now: number, readAt: number): ManualResetInfo | undefined {
  if (!info) return undefined;
  // A stale list or a cooldown cannot be confirmed now, so no grant counts.
  if (info.stale || (info.cooldownUntil !== undefined && Date.parse(info.cooldownUntil) > now)) return { availableCount: 0 };
  const grants = (info.grants ?? []).filter((grant) => grant.kind === "full" && grant.usableNow && !grant.paused && grant.resetsLeft >= 1 &&
    grant.endsAt !== undefined && Date.parse(grant.endsAt) > now);
  return {
    availableCount: grants.length,
    creditExpiries: grants.map((grant) => ({ id: grant.id, ...(grant.label ? { label: grant.label } : {}), endsAt: grant.endsAt as string })),
    readAt: new Date(readAt).toISOString(),
  };
}

function poolUsage(body: unknown, capturedAt: string): AutoResetUsage {
  const usage = parseUsageBody(body, capturedAt);
  const windows: PoolUsage["windows"] = [
    ...(usage.fiveHour ? [{ label: "five-hour", utilization: usage.fiveHour.utilization, ...(usage.fiveHour.resetsAt ? { resetsAt: usage.fiveHour.resetsAt } : {}) }] : []),
    ...(usage.sevenDay ? [{ label: "seven-day", utilization: usage.sevenDay.utilization, ...(usage.sevenDay.resetsAt ? { resetsAt: usage.sevenDay.resetsAt } : {}) }] : []),
    ...(usage.scoped ?? []).map((w) => ({ label: `seven-day (${w.model})`, model: w.model, utilization: w.utilization, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) })),
  ];
  return {
    status: usage.status, capturedAt, windows,
    ...(usage.maxUtilization !== undefined ? { maxUtilization: usage.maxUtilization } : {}),
    ...(usage.extraUsage ? { extraUsage: usage.extraUsage } : {}),
    ...(usage.error ? { error: usage.error } : {}),
  };
}

/** One usage and grant read with the gateway credential. A failed read answers `unavailable` and no credits. */
export async function fetchGatewayClaudeState(
  credential: ProviderCredential, doFetch: Fetch, now: () => number, signal: AbortSignal,
): Promise<ClaudeResetRead> {
  signal.throwIfAborted();
  const unavailable = (error: string): ClaudeResetRead => ({
    usage: { status: "unavailable", capturedAt: new Date(now()).toISOString(), error }, credits: undefined,
  });
  let response: Response;
  try {
    response = await doFetch(CLAUDE_RESET_INVENTORY_URL, {
      headers: headers(credential), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: "manual",
    });
  } catch {
    signal.throwIfAborted();
    return unavailable("usage endpoint unreachable");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return unavailable(`usage endpoint answered HTTP ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  signal.throwIfAborted();
  const capturedAt = now();
  const cedar = (body as { cedar_ember?: unknown } | null | undefined)?.cedar_ember;
  const credits = claudeCreditInventory(manualResetFromCedarEmber(cedar, capturedAt), capturedAt, capturedAt);
  return { usage: poolUsage(body, new Date(capturedAt).toISOString()), credits };
}

class ClaudeResetError extends Error {
  constructor(message: string, readonly status: number, readonly postAttempted?: boolean) {
    super(message);
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The body was already closed.
  }
}

/**
 * Spends one named Claude grant with the stored gateway credential. The grant list is read again first, and the POST is sent once.
 * A 2xx answer without a clear result is an unknown outcome: the claim keeps its credit ID and nothing sends a second POST.
 */
export async function consumeClaudeResetForIdentity(
  identity: string,
  credential: ProviderCredential,
  doFetch: Fetch,
  selection: ClaudeResetSelection,
  newRequestId: () => string = randomUUID,
): Promise<{ identity: string; result: ClaudeResetOutcome; creditId?: string }> {
  if (credential.identity !== identity) throw new ClaudeResetError("The Claude credential did not match the requested account", 409, false);
  const { signal } = selection;
  const operation = () => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  if (!await selection.stillEligible()) return { identity, result: "no_credit" };

  const state = await fetchGatewayClaudeState(credential, doFetch, selection.now, signal);
  const available = state.credits?.creditExpiries?.filter(({ id }) => id === selection.id);
  if (!available?.length || available.some(({ endsAt }) => Date.parse(endsAt) !== Date.parse(selection.endsAt) || Date.parse(endsAt) <= selection.now())) {
    return { identity, result: "no_credit" };
  }
  const stillBlocked = state.usage.windows?.some((w) => w.model === undefined && /^seven-day$/i.test(w.label) && w.utilization >= 100);
  if (!stillBlocked) return { identity, result: "nothing_to_reset" };

  let profile: Response;
  try {
    profile = await doFetch(CLAUDE_PROFILE_URL, { headers: headers(credential), signal: operation(), redirect: "manual" });
  } catch {
    throw new ClaudeResetError("The Claude profile could not be read", 502, false);
  }
  if (!profile.ok) {
    await discard(profile);
    throw new ClaudeResetError(`The Claude profile answered HTTP ${profile.status}`, 502, false);
  }
  const org = ((await profile.json().catch(() => undefined)) as { organization?: { uuid?: unknown } } | undefined)?.organization?.uuid;
  if (typeof org !== "string" || org === "") throw new ClaudeResetError("The Claude profile has no organisation", 502, false);

  signal.throwIfAborted();
  await selection.beforePost();
  if (!selection.stillCurrent()) return { identity, result: "no_credit" };
  signal.throwIfAborted();
  let spent: Response;
  try {
    selection.onPost();
    // The POST finishes after the caller's deadline, so the outcome is recorded.
    spent = await doFetch(claudeResetUrl(org), {
      method: "POST",
      headers: headers(credential, { "content-type": "application/json" }),
      body: JSON.stringify({ program: "cedar_ember", grant_id: selection.id, request_id: newRequestId() }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
  } catch {
    throw new ClaudeResetError("The Claude reset outcome is unknown. Refresh limits before another attempt.", 502);
  }
  const body = await spent.json().catch(() => undefined) as { result?: unknown; grant_id?: unknown; cleared?: unknown } | undefined;
  const reported = typeof body?.grant_id === "string" && body.grant_id.trim() !== "" ? body.grant_id : undefined;
  if (!spent.ok) throw Object.assign(new ClaudeResetError(`Claude refused the reset (HTTP ${spent.status})`, spent.status), { creditedId: reported });
  const result = typeof body?.result === "string" ? body.result.toLowerCase() : "";
  const cleared = Array.isArray(body?.cleared) && body.cleared.length > 0;
  const creditId = reported ?? selection.id;
  if (/^(?:reset|ok|success|applied|redeemed|used)$/.test(result) || (result === "" && cleared)) return { identity, result: "reset", creditId };
  if (/^(?:nothing_to_reset|no_reset_needed|not_limited)$/.test(result)) return { identity, result: "nothing_to_reset", creditId };
  if (/^(?:no_credit|no_grant|grant_exhausted|exhausted)$/.test(result)) return { identity, result: "no_credit", creditId };
  if (/^already_redeemed$/.test(result)) return { identity, result: "already_redeemed", creditId };
  throw Object.assign(new ClaudeResetError("The Claude reset outcome is unknown. Refresh limits before another attempt.", 502), { creditedId: creditId });
}
