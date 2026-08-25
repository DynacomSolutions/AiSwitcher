import type { Identity } from "../../identities/types.ts";
import type { ToolResumeResult } from "./types.ts";
import { readCrushSessions } from "./crush-resume.ts";

/**
 * ali's own thin wrapper around the shared crush-resume.ts reader (see
 * zai-resume.ts, the original implementation, before being extracted for
 * reuse here) for the full "how". ali's own CRUSH_GLOBAL_DATA subdir is also
 * "data" (see identities/tool-configs.ts's ALI_CONFIG).
 */
export async function readAliSessions(identity: Identity, targetCwd: string): Promise<ToolResumeResult> {
  return readCrushSessions("ali", identity, targetCwd, "data", "alibaba");
}
