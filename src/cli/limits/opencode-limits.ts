import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { canonicalUsageProvider } from "../usage/providers.ts";
import { fetchZaiQuotaForKey } from "./zai-limits.ts";
import type { ToolLimitResult } from "./types.ts";

/** OpenCode keeps one credential per upstream provider in
 * `<configDir>/data/opencode/auth.json` (its XDG data root, redirected into
 * the identity's own `data/` subdirectory by OPENCODE_CONFIG's
 * extraEnvVarNames). Entries are static API credentials — the same key an
 * upstream-owning AIS tool would hold when the credential was provisioned
 * through it. */
export interface OpencodeAuthEntry {
  type?: string;
  key?: string;
}

export type OpencodeAuthFile = Record<string, OpencodeAuthEntry>;

/** `zai_coding_plan`/`alibaba_token_plan` are OpenCode's ids for the same
 * upstream plans the zai/ali tools serve — canonicalUsageProvider already
 * aliases them onto zai/alibaba. alibaba is additionally native-covered: the
 * Token plan has no API-key quota endpoint (see ali-limits.ts), so its
 * provider branch comes from the ali tool's console-cookie fetch or not at
 * all. */
const NATIVE_COVERED_OPENCODE_PROVIDERS = new Set(["alibaba"]);

async function readOpencodeAuth(configDir: string): Promise<OpencodeAuthFile | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(join(configDir, "data", "opencode", "auth.json")).text()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as OpencodeAuthFile;
  } catch {
    return undefined;
  }
}

function unavailable(identity: Identity, error: string): ToolLimitResult {
  return { toolName: "opencode", provider: "unattributed", identity, windows: [], status: "unavailable", error };
}

/** The auth.json entries this adapter will act on, in file order, with every
 * skip decision already applied: native-covered plans are dropped (their
 * branch comes from the tool that can actually answer), unknown provider ids
 * are dropped (never guessed at), and only entries with a usable API key
 * survive. Pure — exported for tests. */
export function fetchableOpencodeProviders(auth: OpencodeAuthFile): Array<{ provider: string; entry: OpencodeAuthEntry }> {
  const fetchable: Array<{ provider: string; entry: OpencodeAuthEntry }> = [];
  for (const [opencodeProvider, entry] of Object.entries(auth)) {
    const provider = canonicalUsageProvider(opencodeProvider);
    if (NATIVE_COVERED_OPENCODE_PROVIDERS.has(provider)) continue;
    if (provider !== "zai") continue;
    if (typeof entry.key !== "string" || entry.key.length === 0) continue;
    fetchable.push({ provider, entry });
  }
  return fetchable;
}

/**
 * Limits for one OpenCode identity, one result per upstream provider
 * OpenCode holds a fetchable credential for (today: only the Z.ai coding
 * plan — the same quota endpoint the zai tool's fetcher uses). Everything
 * else is skipped: native-covered plans (alibaba) get their branch from the
 * tool that can actually answer, and unknown provider ids are ignored rather
 * than guessed at. With no readable auth.json or no fetchable entries the
 * identity contributes nothing to an unscoped report; an explicit
 * `ais limits --tool=opencode` gets one honest "unavailable" row instead of
 * silence (same explicit-question rule as the usage pipeline).
 */
export async function fetchOpencodeLimits(identity: Identity, explicitTool = false): Promise<ToolLimitResult[]> {
  const auth = await readOpencodeAuth(identity.configDir);
  if (!auth) {
    return explicitTool
      ? [unavailable(identity, "no readable OpenCode auth.json — nothing to fetch limits from")]
      : [];
  }

  const results: ToolLimitResult[] = [];
  for (const { provider, entry } of fetchableOpencodeProviders(auth)) {
    const outcome = await fetchZaiQuotaForKey(entry.key!);
    results.push(
      outcome.error || !outcome.windows
        ? { toolName: "opencode", provider, identity, windows: [], status: "unavailable", error: outcome.error ?? "quota fetch failed" }
        : {
            toolName: "opencode",
            provider,
            identity,
            windows: outcome.windows,
            status: "live",
            capturedAt: new Date().toISOString(),
          },
    );
  }

  if (results.length === 0 && explicitTool) {
    return [unavailable(identity, "no fetchable OpenCode providers configured (native tools cover the rest)")];
  }
  return results;
}
