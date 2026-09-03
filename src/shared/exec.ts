import { realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { homedir } from "node:os";
import { chdir } from "node:process";

const FORWARD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP"] as const;

/**
 * A process whose current working directory has been DELETED (its checkout
 * was moved or pruned while it ran — seen live: the console daemon kept
 * serving for days after its worktree moved, and every spawn it attempted
 * failed with a POSIX EACCES/ENOENT naming the target binary, because the
 * kernel cannot resolve a dangling cwd during spawn) can never start a child
 * again on its own. Detection is a single realpath (note: process.cwd()
 * keeps returning the stale path and Bun's stat(".") does not fail —
 * verified live — so neither can be the detector); recovery is moving to
 * $HOME, which exists for the process's remaining lifetime.
 */
export function ensureUsableCwd(): void {
  try {
    realpathSync(".");
  } catch {
    try {
      chdir(homedir());
    } catch {
      // Even $HOME is unusable; children will keep failing to spawn, but
      // there is nowhere left to recover to.
    }
  }
}

/**
 * Runs `attempt`, and on spawn failure heals a dangling cwd and retries
 * exactly once, so a long-lived process self-repairs mid-flight instead of
 * failing every future child until restart. Any second failure propagates.
 */
export function withUsableCwd<T>(attempt: () => T): T {
  try {
    return attempt();
  } catch (err) {
    ensureUsableCwd();
    return attempt();
  }
}

// Session-marker env vars set by Claude Code / Codex itself when THIS
// wrapper happens to be invoked from inside an already-running session
// (e.g. a coding agent's own Bash tool, or any nested orchestration). If we
// pass these through unchanged, the real claude/codex binary sees itself
// being launched as a child of a process with the same name, decides it's a
// nested/recursive session, and hangs indefinitely waiting for a handshake
// that never comes — confirmed by direct reproduction: stripping exactly
// these vars before spawning is what fixes it. Our wrapper must always look
// like a fresh, top-level invocation to the child, never a nested one.
// GROK is included defensively by analogy (grok has its own leader/session
// machinery — see `--leader-socket`/`~/.grok/leader.sock` in `grok --help`
// — that plausibly has the same nested-invocation failure mode), not because
// the hang was independently reproduced for it.
// KIMI is deliberately NOT included: checked live from inside a running kimi
// session's own Bash tool (2026-07-17) — kimi injects NO KIMI_* env vars into
// its tool-spawned environment at all, so there is no nested-session marker
// to strip. A blanket KIMI_* strip would only eat a user's legitimately
// exported KIMI_API_KEY/KIMI_BASE_URL (documented kimi auth env vars) before
// the child ever sees them. If a future kimi version starts injecting session
// markers (symptom: nested kimi launches hang), add KIMI here first.
// CRUSH is included defensively by analogy (zai's and ali's real binary is
// `crush`, github.com/charmbracelet/crush; a newer addition than the others
// above, with no independent nested-invocation reproduction done for it
// yet), not because a hang was confirmed the way claude/codex's was. A
// blanket prefix is safe here even though this project itself sets
// CRUSH_GLOBAL_CONFIG/CRUSH_GLOBAL_DATA: both are re-applied via extraEnv
// after this strip anyway (same reasoning as the retired take-1
// OPENCODE_CONFIG_DIR/XDG_* case).
// ALI is included for the same defensive reasoning: ali's own primary env
// var, ALI_CONFIG_DIR, isn't one `crush` itself reads (see
// tool-configs.ts's ALI_CONFIG), so it wouldn't otherwise be caught by the
// CRUSH prefix above. Also re-applied via extraEnv after this strip, so this
// is mostly belt-and-suspenders rather than something a real hang was ever
// reproduced against.
const SESSION_MARKER_PATTERN = /^(CLAUDE|CODEX|GROK|AI_AGENT|CRUSH|ALI|OPENCODE_(?:SERVER_PASSWORD|SERVER_USERNAME|CLIENT))/i;

/**
 * Set (by run-wrapper.ts, via execReal's extraEnv) only on the child process
 * this wrapper actually spawns — never by a user exporting CLAUDE_CONFIG_DIR/
 * CODEX_HOME in a shell rc for unrelated reasons. src/open.ts checks this
 * (not CLAUDE_CONFIG_DIR/CODEX_HOME alone) to tell "I'm a descendant of our
 * own wrapper's spawn" apart from "this env var just happens to be set in my
 * environment" — the latter would otherwise redirect unrelated `open` calls
 * (gh, git, arbitrary scripts) in any shell where an identity is pinned via
 * env var, not just ones our wrapper actually launched.
 */
export const IDENTITY_SESSION_MARKER = "AI_PROFILE_SWITCHER_SESSION";

function buildChildEnv(extraEnv: Record<string, string>): Record<string, string | undefined> {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SESSION_MARKER_PATTERN.test(key)) cleaned[key] = value;
  }
  // Re-applied after stripping, so the one CLAUDE_CONFIG_DIR/CODEX_HOME we
  // actually want the child to see always survives regardless of the blanket
  // pattern above.
  return { ...cleaned, ...extraEnv };
}

/**
 * Spawn the real binary with full fd inheritance (byte-identical TTY/color/
 * raw-mode behavior to calling it directly) and relay terminal signals to the
 * child, resolving to the child's exit code (signal exits mirrored as
 * 128+signum, same convention shells use) instead of exiting the current
 * process — so callers that need to run more than one real binary in
 * sequence (e.g. `ais upgrade` checking claude then codex) can do so without
 * this helper ending the process after the first one. `execReal` below is
 * the single-invocation, never-returns wrapper every proxy entrypoint
 * (claude.ts/codex.ts) actually uses.
 */
export async function spawnReal(
  cmdPath: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<number> {
  const child = Bun.spawn([cmdPath, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: buildChildEnv(extraEnv),
    cwd: process.cwd(),
    // detached intentionally omitted (defaults to false): keep the child in
    // our process group so terminal-generated signals hit it directly too.
  });

  const handlers = new Map<(typeof FORWARD_SIGNALS)[number], () => void>();
  for (const sig of FORWARD_SIGNALS) {
    const handler = () => {
      try {
        child.kill(sig);
      } catch {
        // Child may already be gone — nothing to do.
      }
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }

  const exitCode = await child.exited;

  for (const [sig, handler] of handlers) {
    process.removeListener(sig, handler);
  }

  if (child.signalCode) {
    const num = osConstants.signals[child.signalCode as keyof typeof osConstants.signals];
    return 128 + (num ?? 0);
  }

  return exitCode;
}

/**
 * No true `execve`-style process-image replacement exists in Bun without
 * experimental FFI, so this is `spawnReal` followed by `process.exit` —
 * the same model nvm/asdf/direnv-style shims use. Never returns.
 */
export async function execReal(
  cmdPath: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<never> {
  const exitCode = await spawnReal(cmdPath, args, extraEnv);
  process.exit(exitCode);
}

export interface BoundedSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Spawn a REAL binary (never this project's own shim — callers resolve that
 * via resolveRealBinary first) with the full inherited environment plus
 * `extraEnv`, capturing stdout/stderr and enforcing a hard timeout.
 * Bun.spawn's `signal` kills the child on abort rather than rejecting this
 * promise — it resolves with whatever partial output was captured and the
 * signal-kill exit code, indistinguishable from a fast clean exit by
 * exitCode/stdout alone. `timedOut` (derived from `controller.signal.aborted`
 * after the fact — the only reliable signal) is what actually tells "hung"
 * apart from "exited fast with nothing to say". Confirmed necessary against
 * a real incident (2026-07-17: two identities hanging indefinitely
 * on every claude prompt) where the failure mode was exactly that
 * distinction — see cli/limits/claude-limits.ts and cli/doctor/*.ts, both of
 * which depend on it.
 */
export async function spawnCapturedBounded(
  cmdPath: string,
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
): Promise<BoundedSpawnResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proc = Bun.spawn([cmdPath, ...args], {
      env: { ...process.env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}
