import type { Identity, ToolConfig } from "../../identities/types.ts";

/** Generic bucket derived from a window's actual duration/semantics, not
 * hardcoded per tool — a Codex "primary" window might be a 5h session or a
 * 7d week depending on the account, and Grok's currentPeriod.type might be
 * WEEKLY or MONTHLY depending on subscription tier. Whichever categories
 * turn up in real data are the only ones ever rendered — no empty rows for
 * categories nothing reported. */
export type LimitCategory = "session" | "week" | "month" | "other";

export interface LimitWindow {
  /** Raw/human label as reported by the tool, e.g. "session (5h)", "week (all)", "week (Fable)". */
  label: string;
  category: LimitCategory;
  usedPercent: number;
  /** Already human-formatted (tools return this in wildly different raw
   * shapes — unix seconds, ISO strings, locale strings — so each adapter
   * normalizes to one display string here rather than pushing that
   * conversion into the report renderer). */
  resetsAt?: string;
  /** Extra free-text status, e.g. "credits depleted". */
  note?: string;
}

/** "pending" is a display-only state a fetch result never actually settles
 * into — it's what limits/dispatch.ts's live TTY render seeds a row with
 * before that identity's fetch has resolved, so report.ts has something to
 * render a spinner for. No fetcher (claude-limits.ts etc.) ever returns it. */
export type LimitFetchStatus = "live" | "cached" | "unavailable" | "pending";

/**
 * Whether this identity is currently drawing on real, billed usage beyond its
 * included subscription/plan quota — the actual-money counterpart to `ais
 * usage`'s tokscale-estimated "token cost", which is never real spend (it's a
 * public-pricing valuation of token counts, paid or not). Only claude, codex,
 * and kimi have any such concept at all: confirmed live that zai's Coding
 * Plan hard-stops with no overage mechanism, and no evidence of one was found
 * for grok's consumer plan either — both fetchers simply never set this
 * field. `undefined` on a ToolLimitResult therefore means "not applicable to
 * this tool" OR "couldn't be determined this time", never "confirmed no
 * overage" — an absent field is not itself a negative result.
 */
export interface OverageInfo {
  /** True when extra/paid usage is currently active. Each fetcher's own
   * comment documents exactly what its source signal can and can't
   * distinguish (kimi's is a real spent-this-month figure; claude's is a
   * live status line; codex's is only a "blocked by a spend cap" signal, not
   * a confirmed "actively spending" one — see codex-limits.ts). */
  active: boolean;
  /** Human-readable status, rendered directly in the report (e.g. "using
   * extra usage", "extra usage: $4.20 of $20.00 cap this month"). */
  label: string;
  /** Real dollars spent on overage this period. Only kimi's API exposes an
   * actual figure — always undefined for claude/codex, which only expose a
   * boolean-ish status. */
  spentUsd?: number;
  /** Configured monthly overage spend cap, when known. Only kimi. */
  limitUsd?: number;
}

/**
 * A manual rate-limit reset the account can spend right now to wipe its
 * active usage window(s) early, instead of waiting for the scheduled
 * resetsAt rollover — e.g. OpenAI grants some Codex accounts "Full reset
 * (Weekly + 5 hr)" credits (confirmed live 2026-09-04: two team accounts on
 * this machine each held `rateLimitResetCredits.availableCount: 1` with one
 * `status: "available"` credit). This is an ACTION the user can take in the
 * provider's own UI/CLI, not a scheduled event; absence of this field means
 * the provider exposes no such concept or nothing is currently available.
 * Only codex surfaces it today; other providers' adapters simply never set
 * it.
 */
export interface ManualResetInfo {
  /** How many resets can be used right now (the wire's own availableCount
   * where provided, else derived from the credits list). */
  availableCount: number;
  /** Provider's own title for the grant, e.g. "Full reset (Weekly + 5 hr)". */
  label?: string;
  /** When the grant itself expires, human-formatted by the adapter. */
  expiresAt?: string;
}

export interface ToolLimitResult {
  toolName: ToolConfig["toolName"];
  /** The upstream provider these windows belong to — the report's grouping
   * key, per the provider-first views rule (the tool/wrapper is collection
   * provenance, not a reporting dimension). For the six 1:1 tools this is
   * just providerForTool(toolName); the multi-provider clients (pi, opencode)
   * set one result per provider they can actually answer for, so a single Pi
   * identity can contribute a Kimi row and a Z.ai row at once. Canonical
   * aliases come from usage/providers.ts. */
  provider: string;
  identity: Identity;  windows: LimitWindow[];
  status: LimitFetchStatus;
  /** Human-readable reason when status is "unavailable" (not authenticated,
   * binary missing, RPC error, ...) — always set together with an empty
   * `windows` array. */
  error?: string;
  /** ISO timestamp of when this snapshot was actually captured — "now" for a
   * live fetch, the source data's own timestamp for a cached/log-scraped one. */
  capturedAt?: string;
  /** See OverageInfo. Absent whenever the tool has no overage concept, or a
   * live fetch didn't happen (pending/unavailable/cached results never set
   * this). */
  overage?: OverageInfo;
  /** See ManualResetInfo. Present only when the provider reports at least
   * one usable manual reset right now. */
  manualReset?: ManualResetInfo;
}

/** What a single-provider fetcher returns: a complete result EXCEPT the
 * provider stamp, which limits/collect.ts's singleToolFetcher applies from
 * the tool it fetched for (1:1 tools always map to one provider, so the
 * fetcher doesn't need to know its own tool name). The multi-provider
 * adapters (pi/opencode) construct full ToolLimitResults themselves — only
 * they know which upstream each answer came from. Typing the fetchers this
 * narrow keeps the stamping in exactly one place, compiler-enforced. */
export type FetchedLimitResult = Omit<ToolLimitResult, "provider">;
