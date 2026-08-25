import type { Identity } from "../../identities/types.ts";
import type { ToolResumeResult } from "./types.ts";
import { readCrushSessions } from "./crush-resume.ts";

/**
 * zai's own thin wrapper around the shared crush-resume.ts reader (see
 * that module for the full "how"; originally implemented here before being
 * extracted for ali-resume.ts to reuse too). zai's own CRUSH_GLOBAL_DATA
 * subdir is "data" (see identities/tool-configs.ts's ZAI_CONFIG).
 */
export async function readZaiSessions(identity: Identity, targetCwd: string): Promise<ToolResumeResult> {
  return readCrushSessions("zai", identity, targetCwd, "data", "zai");
}
