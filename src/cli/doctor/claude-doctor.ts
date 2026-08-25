import type { Identity } from "../../identities/types.ts";
import { spawnCapturedBounded } from "../../shared/exec.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import type { DoctorResult } from "./types.ts";

const TIMEOUT_MS = 20_000;
const PROMPT = "Reply with just the word OK.";
// --mcp-config accepts a literal JSON string, not just a file path (confirmed
// via `claude --help`) — no temp file needed. Disabling every MCP server
// rules it out as the cause of a hang before it can even be asked: the
// 2026-07-17 incident this command exists to catch reproduced
// identically with every MCP server disabled, so a slow/misconfigured MCP
// server should never produce a false "hung" verdict here.
const NO_MCP_ARGS = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Live responsiveness probe for one claude identity: a real, MCP-disabled,
 * non-session-persisting `-p` turn against the real binary, bounded by a
 * hard timeout. Deliberately always attempts a real turn rather than
 * shortcutting on `claude auth status` the way limits/claude-limits.ts does
 * — the incident this command exists to catch (an identity with orphaned/
 * stuck concurrent agent sessions hanging on every single prompt) left
 * `claude auth status` fast and correctly authenticated throughout, so that
 * check alone would have reported "healthy" right through the whole outage.
 */
export async function probeClaudeDoctor(identity: Identity): Promise<DoctorResult> {
  const base = { toolName: "claude" as const, identity };

  let binaryPath: string;
  try {
    binaryPath = resolveRealBinary("claude");
  } catch (err) {
    return { ...base, status: "unavailable", detail: errorMessage(err) };
  }

  const startedAt = Date.now();
  const { stdout, stderr, exitCode, timedOut } = await spawnCapturedBounded(
    binaryPath,
    ["-p", PROMPT, "--no-session-persistence", ...NO_MCP_ARGS],
    { CLAUDE_CONFIG_DIR: identity.configDir },
    TIMEOUT_MS,
  );
  const elapsedMs = Date.now() - startedAt;

  if (timedOut) {
    return {
      ...base,
      status: "hung",
      elapsedMs,
      detail: `claude did not respond within ${TIMEOUT_MS / 1000}s (MCP disabled, so this isn't an MCP-server issue)`,
    };
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
