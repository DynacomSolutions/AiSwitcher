import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aisStateDir } from "../shared/ais-home.ts";

/**
 * Hook-side continuation fallback. The ais-usage mod continues a session after a swap, but plugin code loads once
 * per session, so sessions started before the mod learned to do that never continue. After a successful swap the
 * StopFailure hook therefore starts a detached `ais claude-swap continue` that, after a grace period, types the same
 * prompt into the herdr pane unless the transcript shows the mod or the user already continued.
 */

export const CONTINUE_TEXT = "Continue the interrupted request now that an allowed pool member is available.";
export const CONTINUE_DELAY_MS = 90_000;
/** One continuation per session and window: a re-run hook for the same failure lands in the same bucket. */
const MARKER_WINDOW_MS = 10 * 60_000;

export interface HookInput {
  sessionId?: string;
  transcriptPath?: string;
}

/** Hook stdin JSON; undefined fields on absent or invalid input. */
export function parseHookInput(raw: string): HookInput {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof o.session_id === "string" && o.session_id ? { sessionId: o.session_id } : {}),
      ...(typeof o.transcript_path === "string" && o.transcript_path ? { transcriptPath: o.transcript_path } : {}),
    };
  } catch {
    return {};
  }
}

/** True when the transcript holds a real user prompt or a non-error assistant turn stamped after the failure. */
export function continuedSince(transcript: string, failureAtMs: number): boolean {
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; timestamp?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } };
      if (!(Date.parse(e.timestamp ?? "") > failureAtMs)) continue;
      if (e.type === "assistant" && !e.isApiErrorMessage) return true;
      if (e.type === "user") {
        const c = e.message?.content;
        const toolResultOnly = Array.isArray(c) && c.length > 0 && c.every((p) => (p as { type?: string })?.type === "tool_result");
        if (!toolResultOnly) return true;
      }
    } catch {
      // torn or foreign line: ignore
    }
  }
  return false;
}

export interface ContinueDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readTranscript?: (path: string) => Promise<string>;
  /** Runs herdr with these args; returns the exit code. */
  herdr?: (args: string[]) => Promise<number>;
  stateDir?: string;
  delayMs?: number;
}

export interface ContinueRequest {
  paneId: string;
  transcriptPath: string;
  sessionId: string;
  failureAtMs: number;
}

/** Waits, re-checks the transcript, and types the prompt at most once per failure. Returns what happened. */
export async function runContinuation(req: ContinueRequest, deps: ContinueDeps): Promise<"sent" | "already-continued" | "already-sent" | "failed"> {
  await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(deps.delayMs ?? CONTINUE_DELAY_MS);
  const transcript = await (deps.readTranscript ?? ((p) => readFile(p, "utf8")))(req.transcriptPath).catch(() => undefined);
  if (transcript === undefined) return "failed";
  if (continuedSince(transcript, req.failureAtMs)) return "already-continued";
  const dir = join(deps.stateDir ?? aisStateDir(), "continue");
  await mkdir(dir, { recursive: true });
  const marker = join(dir, `${req.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}-${Math.floor(req.failureAtMs / MARKER_WINDOW_MS)}`);
  try {
    await writeFile(marker, String((deps.now ?? Date.now)()), { flag: "wx" });
  } catch {
    return "already-sent";
  }
  const herdr = deps.herdr ?? (async () => 1);
  if ((await herdr(["pane", "send-text", req.paneId, CONTINUE_TEXT])) !== 0) return "failed";
  return (await herdr(["pane", "send-keys", req.paneId, "Enter"])) === 0 ? "sent" : "failed";
}
