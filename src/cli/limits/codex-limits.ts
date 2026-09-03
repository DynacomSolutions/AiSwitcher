import type { Identity } from "../../identities/types.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import { categorizeByMinutes } from "./bucket.ts";
import type { LimitCategory, LimitWindow, OverageInfo, FetchedLimitResult } from "./types.ts";

/** Whole handshake budget (spawn + initialize + rateLimits/read). Live reads
 * against all three real identities on this machine came back in ~1-2s each,
 * so 9s leaves generous headroom without letting one unresponsive identity
 * stall a batched `ais limits` run for too long. */
const HANDSHAKE_TIMEOUT_MS = 9000;

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
export async function fetchCodexLimits(identity: Identity): Promise<FetchedLimitResult> {
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

      const snapshot = (rateLimitsResponse.result as { rateLimits?: RateLimitSnapshotWire } | undefined)
        ?.rateLimits;
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
      return { ...base, windows, status: "live", capturedAt: new Date().toISOString(), ...(overage ? { overage } : {}) };
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
