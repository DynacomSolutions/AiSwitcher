import type { Identity } from "../../identities/types.ts";
import { spawnCapturedBounded } from "../../shared/exec.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import type { DoctorResult } from "./types.ts";

const TIMEOUT_MS = 20_000;
const PROMPT = "Reply with just the word OK.";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * limits/grok-limits.ts has no live path at all (it's a pure log-scrape —
 * see its own doc comment), so this is the first live probe against the real
 * grok binary in this project. `-p`/`--single <PROMPT>` (confirmed via
 * `grok --help`) is grok's equivalent of claude's `-p`: prints one response
 * and exits. `--no-subagents` keeps the probe to a single turn, the same
 * intent as claude-doctor.ts's `--strict-mcp-config`: rule out anything
 * beyond "did the base binary answer."
 */
export async function probeGrokDoctor(identity: Identity): Promise<DoctorResult> {
  const base = { toolName: "grok" as const, identity };

  let binaryPath: string;
  try {
    binaryPath = resolveRealBinary("grok");
  } catch (err) {
    return { ...base, status: "unavailable", detail: errorMessage(err) };
  }

  const startedAt = Date.now();
  const { stdout, stderr, exitCode, timedOut } = await spawnCapturedBounded(
    binaryPath,
    ["-p", PROMPT, "--no-subagents", "--disable-web-search"],
    { GROK_HOME: identity.configDir },
    TIMEOUT_MS,
  );
  const elapsedMs = Date.now() - startedAt;

  if (timedOut) {
    return { ...base, status: "hung", elapsedMs, detail: `grok did not respond within ${TIMEOUT_MS / 1000}s` };
  }
  if (exitCode !== 0) {
    return {
      ...base,
      status: "responsive",
      elapsedMs,
      detail: (stderr || stdout).trim().slice(0, 200) || `exited with code ${exitCode}`,
    };
  }
  return { ...base, status: "responsive", elapsedMs };
}
