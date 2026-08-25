import type { Identity } from "../../identities/types.ts";
import { fetchCodexLimits } from "../limits/codex-limits.ts";
import type { DoctorResult } from "./types.ts";

/**
 * Reuses limits/codex-limits.ts's existing live handshake (`codex app-server
 * --stdio`'s `initialize` + `account/rateLimits/read`) rather than
 * re-implementing its JSON-RPC/NDJSON framing here — that framing was
 * hard-won (see codex-limits.ts's own doc comment) and this probe needs
 * nothing beyond "did the process answer in time," which that call already
 * tells us via its own `controller.signal.aborted`-based timeout detection.
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
  // Any other "unavailable" (auth gate, no rate-limit windows, ...) still
  // means the process answered within budget — just with nothing usable.
  return { ...base, status: "responsive", elapsedMs, detail: error || undefined };
}
