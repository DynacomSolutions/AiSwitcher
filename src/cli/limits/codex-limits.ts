import type { Identity } from "../../identities/types.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import { categorizeByMinutes } from "./bucket.ts";
import type { LimitCategory, LimitWindow, ManualResetInfo, OverageInfo, FetchedLimitResult } from "./types.ts";

/** Whole handshake budget (spawn + initialize + rateLimits/read) per
 * attempt. Live reads against real identities on this machine come back in
 * ~1-2s when chatgpt.com is healthy, but the same endpoint degrades to
 * multi-second (or indefinite) hangs under load — observed live 2026-09-04,
 * when four consecutive runs each burned the previous 9s ceiling without an
 * answer, then one identity succeeded minutes later. 30s matches http.ts's
 * generous per-attempt convention for the same upstream: these fetches are
 * one cheap read when healthy, and the user has been explicit that
 * transient failures must not become rows. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

interface RateLimitWindowWire {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface RateLimitSnapshotWire {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindowWire | null;
  secondary?: RateLimitWindowWire | null;
  spendControlReached?: boolean | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

/** One grantable "spend this to wipe my windows now" credit. Confirmed live
 * 2026-09-04 against two real team accounts on this machine:
 * `RateLimitResetCredit_<hex>` ids, `resetType: "codexRateLimits"`, and a
 * "Full reset (Weekly + 5 hr)" title for a free promo grant. */
export interface RateLimitResetCreditWire {
  /** Wire id, e.g. "RateLimitResetCredit_<hex>" (unread). */
  id?: string;
  /** Confirmed live: "codexRateLimits" (unread). */
  resetType?: string;
  status?: string;
  title?: string;
  description?: string;
  /** Unix seconds. */
  grantedAt?: number;
  /** Unix seconds. */
  expiresAt?: number;
}

/** Sibling of `rateLimits` in the `account/rateLimits/read` result (also
 * confirmed present in the installed binary's own embedded type
 * definitions): the account's manually-spendable rate-limit resets. */
export interface RateLimitResetCreditsWire {
  availableCount?: number;
  credits?: RateLimitResetCreditWire[];
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** codex app-server --stdio's wire framing is one JSON object per line (no
 * Content-Length headers like LSP) — confirmed empirically against all three
 * real identities on this machine. Notifications (e.g.
 * `remoteControl/status/changed`) arrive interleaved with responses and have
 * no `id`, so callers must skip past them rather than assuming the next line
 * is always the reply to their last request. */
/** Minimal shape actually used, rather than the ambient
 * ReadableStreamDefaultReader<Uint8Array> — bun-types' Bun-specific reader
 * type (which adds readMany()) and @types/node's DOM-lib one both declare
 * that global name, and getReader()'s overloaded signature (plain vs BYOB)
 * makes even ReturnType<...> resolve inconsistently. A narrow local
 * interface sidesteps the whole ambiguity. */
interface MinimalStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

class NdjsonReader {
  private reader: MinimalStreamReader;
  private decoder = new TextDecoder();
  private buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** Resolves with the next parsed line, or `undefined` once the stream ends
   * (e.g. the process was killed after an abort-timeout). */
  async next(): Promise<JsonRpcMessage | undefined> {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        try {
          return JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue; // Skip a stray non-JSON line rather than failing the whole read.
        }
      }
      const { value, done } = await this.reader.read();
      if (done) return undefined;
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
}

async function waitForResponse(reader: NdjsonReader, id: number): Promise<JsonRpcMessage> {
  while (true) {
    const msg = await reader.next();
    if (!msg) throw new Error("codex app-server closed its output before responding.");
    if (msg.id === id) return msg;
    // Anything else (a notification with no id, or a response to some other
    // id) is not what we're waiting for — keep reading past it.
  }
}

/** codex-rs' actual wire text for the auth gate, confirmed by inspecting the
 * installed native binary's strings: "chatgpt authentication required to
 * read rate limits" / "codex account authentication required to read rate
 * limits". Matched loosely (case-insensitive substring on the stable middle
 * phrase) rather than the exact full string, since the two known variants
 * only differ in their prefix and a future codex release could add a third. */
function isAuthGateError(message: string): boolean {
  return /authentication required to read rate limits/i.test(message);
}

function labelAndCategoryFor(mins: number | undefined): { label: string; category: LimitCategory } {
  if (mins === undefined) return { label: "usage", category: "other" };
  const category = categorizeByMinutes(mins);
  if (category !== "other") return { label: category, category };
  if (mins >= 1440) return { label: `~${Math.round(mins / 1440)}d`, category };
  return { label: `~${Math.round(mins / 60)}h`, category };
}

/** rateLimitReachedType/spendControlReached live at the snapshot level (they
 * describe why the account overall got throttled, not a specific window), so
 * the same note is attached to every window built from one snapshot. */
function deriveNote(snapshot: RateLimitSnapshotWire): string | undefined {
  const reached = snapshot.rateLimitReachedType;
  if (reached) {
    const lower = reached.toLowerCase();
    if (lower.includes("credits_depleted")) return "credits depleted";
    if (lower.includes("usage_limit_reached")) return "usage limit reached";
    return lower.replace(/_/g, " ");
  }
  if (snapshot.spendControlReached) return "spend control reached";
  return undefined;
}

/**
 * Codex's `account/rateLimits/read` has no clean "actively spending beyond
 * plan right now" boolean the way kimi's boosterWallet or claude's `/usage`
 * intro line do — only whether a configured org spend cap has been hit
 * (`spendControlReached`) or the account ran out of credits altogether
 * (`rateLimitReachedType` containing "credits_depleted"). Both describe a
 * BLOCKED state, not confirmed ongoing overage, so `active` is always false
 * here: this only tells you overage was being drawn on until it ran out, not
 * that spending is happening right now. A separate `rateLimitResetCredits`
 * field exists on the raw response (confirmed from the installed codex
 * binary's own embedded type definitions via `strings`) but is a distinct
 * feature — spending credits to reset a rate-limit window early, not
 * pay-as-you-go overage billing — so it's deliberately not read here. No
 * dollar figure was found anywhere on this response for genuine overage
 * spend.
 */
export function overageFromSnapshot(snapshot: RateLimitSnapshotWire): OverageInfo | undefined {
  // Same precedence as this file's own deriveNote (rateLimitReachedType
  // first, spendControlReached only as a fallback) and the exact same
  // wording, so the two can never disagree when both end up rendered.
  if (snapshot.rateLimitReachedType?.toLowerCase().includes("credits_depleted")) {
    return { active: false, label: "credits depleted" };
  }
  if (snapshot.spendControlReached) return { active: false, label: "spend control reached" };
  return undefined;
}

/**
 * Pure mapping from the `rateLimitResetCredits` sibling of the rateLimits
 * snapshot to a ManualResetInfo — the account's manually-spendable "wipe my
 * usage windows now" grants (a separate feature from overage billing; the
 * count says how many can be used RIGHT NOW). The wire's own
 * availableCount is trusted where present; otherwise the count is derived
 * from the credits list. A count of zero (or an absent wire block — every
 * account without the concept) yields undefined, so nothing renders rather
 * than a fabricated "no resets" row. Title/expiry come from the first
 * available credit; expiry reuses this file's resetsAt display format.
 * Exported pure for tests.
 */
export function manualResetFromWire(wire: RateLimitResetCreditsWire | undefined): ManualResetInfo | undefined {
  if (!wire) return undefined;
  const available = (wire.credits ?? []).filter((c) => c.status === "available");
  const count =
    typeof wire.availableCount === "number" && Number.isFinite(wire.availableCount)
      ? wire.availableCount
      : available.length;
  if (count <= 0) return undefined;
  const first = available[0];
  const expiresAt =
    first?.expiresAt !== undefined
      ? new Date(first.expiresAt * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : undefined;
  return {
    availableCount: count,
    ...(first?.title ? { label: first.title } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function buildWindows(snapshot: RateLimitSnapshotWire): LimitWindow[] {
  const note = deriveNote(snapshot);
  const windows: LimitWindow[] = [];
  for (const raw of [snapshot.primary, snapshot.secondary]) {
    if (!raw) continue;
    const { label, category } = labelAndCategoryFor(raw.windowDurationMins);
    windows.push({
      label,
      category,
      usedPercent: raw.usedPercent,
      resetsAt:
        raw.resetsAt !== undefined
          ? new Date(raw.resetsAt * 1000).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : undefined,
      ...(note ? { note } : {}),
    });
  }
  return windows;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetches live rate-limit usage for one codex identity via
 * `codex app-server --stdio`'s JSON-RPC interface: `initialize` then
 * `account/rateLimits/read`.
 *
 * Protocol notes confirmed empirically against all three real identities on
 * this machine (personal/identity-a/work), not assumed from
 * docs:
 * - The `jsonrpc: "2.0"` field is NOT required — tested both with and
 *   without it; the server accepts either and never echoes it back in
 *   responses either way. Omitted here to match the leaner shape.
 * - The response to `account/rateLimits/read` nests the actual snapshot one
 *   level deeper than the raw `RateLimitSnapshot` shape: `result.rateLimits`
 *   (siblings `rateLimitsByLimitId` and `rateLimitResetCredits` are also
 *   present but unused here).
 * - A "credits depleted" identity (identity-a, live) came back as
 *   `usedPercent: 100` with `rateLimitReachedType:
 *   "workspace_owner_credits_depleted"` rather than an RPC error — the RPC
 *   error path is reserved for the auth gate (API-key-only identities),
 *   never observed live since every identity on this machine already has
 *   ChatGPT-plan auth, but the exact wire message was confirmed by
 *   inspecting the installed native binary's strings table (see
 *   `isAuthGateError`).
 *
 * Env handling: spawns with the FULL inherited environment, only overriding
 * `CODEX_HOME` — never a stripped/empty env. Not independently proven
 * necessary for codex the way it was for claude (codex's auth is a plain
 * `auth.json` file under `CODEX_HOME`, not keychain-backed), but every live
 * probe during development used the full environment and worked, so there
 * was no reason to risk the same class of bug claude-limits.ts hit by
 * stripping it.
 */
/** One full app-server session. Not exported — fetchCodexLimits wraps this
 * with the transient-failure retry. */
async function fetchCodexLimitsOnce(identity: Identity): Promise<FetchedLimitResult> {
  const base: Pick<FetchedLimitResult, "toolName" | "identity"> = { toolName: "codex", identity };

  let binaryPath: string;
  try {
    binaryPath = resolveRealBinary("codex");
  } catch (err) {
    return { ...base, windows: [], status: "unavailable", error: errorMessage(err) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);

  try {
    const proc = Bun.spawn([binaryPath, "app-server", "--stdio"], {
      env: { ...process.env, CODEX_HOME: identity.configDir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });

    try {
      const reader = new NdjsonReader(proc.stdout);
      const encoder = new TextEncoder();
      const send = (msg: Record<string, unknown>) => {
        proc.stdin.write(encoder.encode(`${JSON.stringify(msg)}\n`));
        proc.stdin.flush();
      };

      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "ais-limits", title: "ais limits", version: "0.1.0" } },
      });
      const initResponse = await waitForResponse(reader, 1);
      if (initResponse.error) {
        throw new Error(initResponse.error.message ?? "codex app-server rejected initialize.");
      }

      send({ id: 2, method: "account/rateLimits/read", params: {} });
      const rateLimitsResponse = await waitForResponse(reader, 2);
      if (rateLimitsResponse.error) {
        const message = rateLimitsResponse.error.message ?? "codex app-server rejected account/rateLimits/read.";
        if (isAuthGateError(message)) {
          return {
            ...base,
            windows: [],
            status: "unavailable",
            error: "ChatGPT-plan login required (API-key auth doesn't expose rate limits)",
          };
        }
        throw new Error(message);
      }

      const payload = rateLimitsResponse.result as
        | { rateLimits?: RateLimitSnapshotWire; rateLimitResetCredits?: RateLimitResetCreditsWire }
        | undefined;
      const snapshot = payload?.rateLimits;
      if (!snapshot) {
        return { ...base, windows: [], status: "unavailable", error: "codex app-server returned no rate-limit data." };
      }

      const windows = buildWindows(snapshot);
      if (windows.length === 0) {
        return {
          ...base,
          windows: [],
          status: "unavailable",
          error: "codex reported no active rate-limit windows (primary and secondary both empty).",
        };
      }

      const overage = overageFromSnapshot(snapshot);
      const manualReset = manualResetFromWire(payload?.rateLimitResetCredits);
      return {
        ...base,
        windows,
        status: "live",
        capturedAt: new Date().toISOString(),
        ...(overage ? { overage } : {}),
        ...(manualReset ? { manualReset } : {}),
      };
    } finally {
      try {
        proc.kill();
      } catch {
        // Best-effort cleanup — nothing to do if the process is already gone.
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ...base,
        windows: [],
        status: "unavailable",
        error: `codex app-server did not respond within ${HANDSHAKE_TIMEOUT_MS / 1000}s.`,
      };
    }
    return { ...base, windows: [], status: "unavailable", error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** The codex CLI does its own networking, and chatgpt.com reachability from
 * this machine blips under report load (observed live 2026-09-03: "error
 * sending request for url" on 3 of 4 identities in one run, all four fine
 * minutes later; observed again 2026-09-04, harder: hangs that exhausted
 * the handshake ceiling and app-server processes dying mid-handshake —
 * "closed its output before responding" — before recovering). When an
 * attempt ends in one of those TRANSIENT signatures, retry up to twice
 * with backoff (3s, 8s) before reporting — the backoff rides out the load
 * spike an immediate retry would hit. Deliberately NOT retried: the auth
 * gate and codex's semantic "no rate-limit data" answers, which mean
 * exactly what they say no matter how the network is doing. */
const TRANSIENT_ERROR_PATTERN =
  /error sending request|did not respond within \d+s|closed its output before responding/;
const CODEX_RETRY_DELAYS_MS = [3_000, 8_000];

/** Pure predicate behind fetchCodexLimits' retry decision — exported so the
 * transient-signature classification has direct unit coverage without
 * spawning a real codex process (see codex-limits.test.ts). */
export function isTransientCodexLimitsError(error: string | undefined): boolean {
  return error !== undefined && TRANSIENT_ERROR_PATTERN.test(error);
}

export async function fetchCodexLimits(identity: Identity): Promise<FetchedLimitResult> {
  let last: FetchedLimitResult | undefined;
  let attempts = 0;
  for (let attempt = 0; attempt <= CODEX_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await Bun.sleep(CODEX_RETRY_DELAYS_MS[attempt - 1]!);
    attempts++;
    last = await fetchCodexLimitsOnce(identity);
    if (!isTransientCodexLimitsError(last.error) || last.status !== "unavailable") return last;
  }
  return {
    ...last!,
    error: `${last!.error} (still failing after ${attempts} attempts)`,
  };
}
