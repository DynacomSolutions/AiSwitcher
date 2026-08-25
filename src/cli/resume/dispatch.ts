import { normalizePath } from "../../identities/match.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { runResumeQuery } from "./collect.ts";
import { launchResume } from "./launch.ts";
import { pickSessionInteractively } from "./pick.ts";
import { flattenSessions, formatResumeTree, toJsonReport } from "./report.ts";
import type { ResumableSession } from "./types.ts";

/** Exported standalone so selector resolution is unit-testable without
 * touching the filesystem or execReal's process.exit (mirrors
 * limits/dispatch.ts's parseIntervalSeconds convention). An exact session id
 * only: unlike an earlier flat-table version of this command, the tree view
 * shows no numbers to select by, so there's nothing for a numeric index to
 * refer to any more. --json's own "index" field is for scripted consumers
 * only. */
export function resolveSelector(selector: string, sessions: ResumableSession[]): ResumableSession {
  const found = sessions.find((s) => s.sessionId === selector);
  if (!found) {
    throw new CliUsageError(`No session matching id "${selector}". Run "ais resume" to browse and pick one interactively.`);
  }
  return found;
}

/**
 * `ais resume [<session-id>] [--identity=] [--tool=] [--json]`
 *
 * No session id, run from a real terminal: shows the same tool -> identity
 * -> session tree `ais limits` uses, as an interactive picker (arrow keys to
 * navigate, landing only on actual sessions; Enter resumes the highlighted
 * one; Ctrl+C cancels without resuming anything). No session id, piped/
 * redirected (or nothing to pick from at all): prints that same tree once
 * as plain text instead, matching limits/watch.ts's own "degrades to a
 * single plain run if stdout isn't a TTY" convention. An exact session id
 * always launches that one session directly, skipping the tree/picker
 * entirely: mutually exclusive with --json, since launching an interactive
 * session and printing machine-readable output don't compose.
 *
 * The cwd is run through the same normalizePath() (tilde-expand, realpath,
 * strip trailing separator) every other cwd comparison in this codebase
 * uses (see identities/match.ts's matchDirectory), rather than a bare
 * process.cwd(), so a symlinked path component or trailing separator can't
 * cause a real, currently-resumable session to silently disappear from the
 * list.
 */
export async function runResumeCommand(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const selector = positionals[0];
  const json = boolFlag(flags, "json");
  if (selector && json) {
    throw new CliUsageError("--json only applies to the list/picker view, omit it when passing a session id.");
  }

  const cwd = normalizePath(process.cwd());
  const results = await runResumeQuery(flags, cwd);

  if (selector) {
    const session = resolveSelector(selector, flattenSessions(results));
    await launchResume(session);
    return;
  }

  if (json) {
    console.log(JSON.stringify(toJsonReport(results), null, 2));
    return;
  }

  if (flattenSessions(results).length === 0 || !process.stdout.isTTY) {
    console.log(formatResumeTree(results, cwd));
    return;
  }

  const session = await pickSessionInteractively(results);
  if (session) await launchResume(session);
}
