import type { Identity } from "../../identities/types.ts";
import type { DateSpan, TokscaleReport } from "./tokscale.ts";
import { fetchCrushUsage } from "./crush-usage.ts";

/**
 * ali's own thin wrapper around the shared crush-usage.ts reader (see
 * zai-usage.ts, the original implementation, before being extracted for
 * reuse here) for the full "how" this local-log aggregation works. ali's own
 * CRUSH_GLOBAL_DATA subdir is also "data" (see identities/tool-configs.ts's
 * ALI_CONFIG). Alibaba's Token plan API has no documented quota/usage
 * endpoint at all (see AGENTS.md's "ali case study"), so, unlike zai, whose
 * `ais limits` live quota IS covered separately by limits/zai-limits.ts,
 * this local-log reader is the ONLY usage data source ali has.
 */
export async function fetchAliUsage(identity: Identity): Promise<(TokscaleReport & { dateSpan?: DateSpan }) | undefined> {
  return fetchCrushUsage(identity, "data", "alibaba");
}
