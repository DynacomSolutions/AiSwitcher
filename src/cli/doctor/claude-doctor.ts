import type { Identity } from "../../identities/types.ts";
import { spawnCapturedBounded } from "../../shared/exec.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import { readClaudeCredentialState } from "../limits/claude-limits.ts";
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
 * shortcutting on a cheap auth-file check: the incident this command exists
 * to catch (an identity with orphaned/stuck concurrent agent sessions
 * hanging on every single prompt) left `claude auth status` fast and
 * correctly authenticated throughout, so that check alone would have
 * reported "healthy" right through the whole outage.
 *
 * The ONE exception to "always spawn": the credential-wipe signature (see
 * limits/claude-limits.ts's incident note), detected up front via the same
 * read-only credential read the limits probe uses. Spawning a turn against
 * wiped credentials can only produce a login error, and the wipe has a
 * specific cause and remedy worth reporting verbatim: a second writer
 * raced Anthropic's rotating refresh token and lost, and Claude Code wiped
 * the token fields on the resulting `invalid_grant`. Reported as
 * "unavailable" (the live probe is never attempted) with the full diagnosis
 * in `detail`.
 */
export async function probeClaudeDoctor(identity: Identity): Promise<DoctorResult> {
  const base = { toolName: "claude" as const, identity };

  // Best-effort: an unreadable/corrupt credential file is exactly what the
  // live probe below surfaces well, so only the definitive wipe state
  // short-circuits here.
  const credentialState = await readClaudeCredentialState(identity.configDir).catch(() => undefined);
  if (credentialState?.kind === "wiped") {
    return {
      ...base,
      status: "unavailable",
      detail:
        "credentials invalidated by a failed token refresh (both token fields wiped, metadata kept): " +
        "a second process likely raced Anthropic's rotating refresh token; " +
        "re-authenticate with `claude auth login` under this identity, and never run a second AIS web server/pod against the same home",
    };
  }

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
