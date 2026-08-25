import { isAbsolute } from "node:path";
import { normalizePath } from "../../identities/match.ts";
import { aisResumeCwdOverridesPath } from "../../shared/ais-home.ts";
import type { ResumableSession } from "./types.ts";

type ResumeToolName = ResumableSession["toolName"];
export type SessionCwdOverrides = Readonly<Record<string, string>>;

interface ResumeCwdOverridesFile {
  version: 1;
  sessions: Partial<Record<ResumeToolName, Record<string, string>>>;
}

/** Load optional, user-managed corrections for session metadata written with
 * the wrong cwd. A missing or malformed file is ignored so a local repair can
 * never make every otherwise-valid resume entry disappear. */
export async function readSessionCwdOverrides(toolName: ResumeToolName): Promise<SessionCwdOverrides> {
  let parsed: ResumeCwdOverridesFile;
  try {
    parsed = JSON.parse(await Bun.file(aisResumeCwdOverridesPath()).text()) as ResumeCwdOverridesFile;
  } catch {
    return {};
  }
  if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") return {};

  const raw = parsed.sessions[toolName];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const valid: Record<string, string> = {};
  for (const [sessionId, cwd] of Object.entries(raw)) {
    if (!sessionId || typeof cwd !== "string" || !isAbsolute(cwd)) continue;
    valid[sessionId] = normalizePath(cwd);
  }
  return valid;
}
