import type { Identity } from "../../identities/types.ts";
import type { DateSpan, TokscaleReport } from "./tokscale.ts";
import { fetchCrushUsage } from "./crush-usage.ts";

/**
 * zai's own thin wrapper around the shared crush-usage.ts reader (see that
 * module for the full "how" and the "Crush DOES track real local per-session
 * token/cost data" history; originally discovered and implemented here
 * before being extracted for ali-usage.ts to reuse too). zai's own
 * CRUSH_GLOBAL_DATA subdir is "data" (see identities/tool-configs.ts's
 * ZAI_CONFIG).
 */
export async function fetchZaiUsage(identity: Identity): Promise<(TokscaleReport & { dateSpan?: DateSpan }) | undefined> {
  return fetchCrushUsage(identity, "data", "zai");
}
