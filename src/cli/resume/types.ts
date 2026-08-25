import type { Identity, ToolConfig } from "../../identities/types.ts";

export interface ResumableSession {
  toolName: ToolConfig["toolName"];
  identity: Identity;
  sessionId: string;
  /** The session's own recorded cwd, always equal to the cwd it was matched against. */
  cwd: string;
  label: string;
  /** ISO timestamp of the session's last recorded activity. */
  lastActiveAt: string;
}

export interface ToolResumeResult {
  toolName: ToolConfig["toolName"];
  identity: Identity;
  sessions: ResumableSession[];
  /** Set on a genuine read failure (bad permissions, corrupt registry, one
   * unreadable session-storage subdirectory, ...). Never set for "this
   * identity has just never used this tool from this cwd", which is the
   * overwhelmingly common case and simply yields an empty `sessions` array.
   * Can coexist with a non-empty `sessions` array (a partial failure, e.g.
   * one bad subdirectory alongside others that read fine) as well as an
   * empty one. */
  error?: string;
}
