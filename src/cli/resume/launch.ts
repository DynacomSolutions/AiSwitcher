import { join } from "node:path";
import { IDENTITY_SESSION_MARKER, spawnReal } from "../../shared/exec.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import { TOOL_CONFIGS } from "../identities/resolve-tool.ts";
import type { ResumableSession } from "./types.ts";
import { recoverOrphanedCodexBackfill } from "../../shared/codex-backfill.ts";
import { startProfileSyncWatcher } from "../../sync/watch.ts";
import { launchThenStartBackgroundSync } from "../../sync/background.ts";

/** Per-tool resume invocation, confirmed against each real CLI's own --help:
 * claude/grok take the session id as an optional value on their --resume
 * flag; codex's is a positional after its "resume" subcommand; kimi's is the
 * value of its `-S, --session [id]` flag; zai's AND ali's real binary,
 * crush, takes it as the value of its own `-s, --session [id]` flag. All six
 * are the INTERACTIVE form (not claude's non-interactive `-p`/codex's `exec`
 * variant) since execReal hands the child the real TTY. zai's/ali's relaunch
 * also depends on the current process's OWN cwd already matching the
 * session's recorded cwd (true by construction:
 * collectResumeTargets/readZaiSessions/readAliSessions only ever surface
 * sessions whose project path equals `process.cwd()`), since Crush resolves
 * its project-local `.crush/crush.db` relative to wherever it's actually run
 * from, not from an env var. */
const RESUME_ARGS: Partial<Record<ResumableSession["toolName"], (sessionId: string) => string[]>> = {
  claude: (id) => ["--resume", id],
  codex: (id) => ["resume", id],
  grok: (id) => ["--resume", id],
  kimi: (id) => ["--session", id],
  zai: (id) => ["--session", id],
  ali: (id) => ["--session", id],
};

/** Launches the real tool, resuming one specific session: mirrors
 * run-wrapper.ts's own exec shape (same env var injection, same
 * IDENTITY_SESSION_MARKER, same execReal) rather than going through our own
 * installed claude/codex/grok shim, since the identity is already fully
 * resolved here and re-resolving it through the shim would be redundant
 * indirection. Never returns: replaces this process the same way every
 * other proxy entrypoint does.
 *
 * Resolves the REAL binary via `cfg.realBinaryName`, not `session.toolName`
 * — identical for claude/codex/grok/kimi (a no-op fix for them) but load-
 * bearing for zai/ali, whose real binary is `crush`; resolving "zai"/"ali"
 * directly would fail since no binary by either name exists. Also mirrors
 * `cfg.extraEnvVarNames` the same way run-wrapper.ts does (join `subdir`
 * onto the identity's configDir when present); claude/codex/grok/kimi have
 * none, so this is a no-op for them, but zai/ali need `CRUSH_GLOBAL_DATA`
 * (and, for ali, `CRUSH_GLOBAL_CONFIG` too) set correctly or crush would
 * fall back to its own unscoped defaults instead of this identity's. */
export async function launchResume(session: ResumableSession): Promise<never> {
  const cfg = TOOL_CONFIGS[session.toolName];
  const resumeArgs = RESUME_ARGS[session.toolName];
  if (!resumeArgs) throw new Error(`no resume launcher implemented for "${session.toolName}" yet`);
  if (session.toolName === "codex") {
    await recoverOrphanedCodexBackfill(session.identity.configDir);
  }
  const binaryPath = resolveRealBinary(cfg.realBinaryName);
  const extraEnv = Object.fromEntries(
    (cfg.extraEnvVarNames ?? []).map(({ name, subdir }) => [
      name,
      subdir ? join(session.identity.configDir, subdir) : session.identity.configDir,
    ]),
  );
  const watcher = startProfileSyncWatcher(
    cfg,
    session.identity.name,
    session.identity.configDir,
    process.cwd(),
  );
  const exitCode = await launchThenStartBackgroundSync(() =>
    spawnReal(binaryPath, resumeArgs(session.sessionId), {
      [cfg.envVarName]: session.identity.configDir,
      ...extraEnv,
      [IDENTITY_SESSION_MARKER]: session.identity.name,
    }),
  );
  await watcher.stop();
  process.exit(exitCode);
}
