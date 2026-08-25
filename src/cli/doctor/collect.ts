import type { Identity, ToolConfig } from "../../identities/types.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { loadAll, TOOL_CONFIGS, toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { probeClaudeDoctor } from "./claude-doctor.ts";
import { probeCodexDoctor } from "./codex-doctor.ts";
import { probeGrokDoctor } from "./grok-doctor.ts";
import type { DoctorResult } from "./types.ts";

export interface DoctorTarget {
  toolName: ToolConfig["toolName"];
  identity: Identity;
}

// Partial, not a full Record: ToolConfig["toolName"]'s union can grow (e.g. a
// tool added to the identities registry before its own doctor probe exists
// yet) without this failing to compile — runDoctorQuery below reports
// "unavailable" for any tool with no entry here instead of assuming
// exhaustive coverage.
const PROBES: Partial<Record<ToolConfig["toolName"], (identity: Identity) => Promise<DoctorResult>>> = {
  claude: probeClaudeDoctor,
  codex: probeCodexDoctor,
  grok: probeGrokDoctor,
};

/** Same shape/rules as usage/run.ts's collectTargets — --identity matching
 * more than one registry returns every match, not an ambiguity error, since
 * seeing that identity's claude AND codex responsiveness side by side is the
 * point. `configs` defaults to the real TOOL_CONFIGS, only overridden by
 * tests. */
export async function collectDoctorTargets(
  flags: ParsedArgs["flags"],
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
): Promise<DoctorTarget[]> {
  const toolFilter = toolConfigFromFlag(flags);
  const identityFilter = stringFlag(flags, "identity");
  const targetConfigs = toolFilter ? [toolFilter] : configs;
  const loaded = await loadAll(targetConfigs);

  const targets: DoctorTarget[] = [];
  for (const { cfg, file } of loaded) {
    for (const identity of file.identities) {
      if (identityFilter && identity.name !== identityFilter && !(identity.aliases ?? []).includes(identityFilter)) {
        continue;
      }
      targets.push({ toolName: cfg.toolName, identity });
    }
  }

  if (identityFilter && targets.length === 0) {
    throw new CliUsageError(
      `No identity named "${identityFilter}" found${toolFilter ? ` in ${toolFilter.toolName}'s registry` : ""}.`,
    );
  }
  return targets;
}

/** Each probe is a real, live subprocess spawn with its own bounded timeout
 * (20s for claude/grok, ~9s for codex). Batch with a modest concurrency cap
 * rather than firing every identity at once — a check against several
 * identities that are ALL genuinely hung would otherwise mean that many
 * concurrent long-lived timeout waits competing for local resources, working
 * against the very thing this command exists to rule out. Mirrors
 * limits/collect.ts's own runBatched. */
const MAX_CONCURRENT = 4;

async function runBatched<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function probeTarget(target: DoctorTarget): Promise<DoctorResult> {
  const probe = PROBES[target.toolName];
  if (!probe) {
    return Promise.resolve({
      toolName: target.toolName,
      identity: target.identity,
      status: "unavailable",
      detail: `no doctor probe implemented for "${target.toolName}" yet`,
    });
  }
  return probe(target.identity);
}

export async function runDoctorQuery(flags: ParsedArgs["flags"]): Promise<DoctorResult[]> {
  const targets = await collectDoctorTargets(flags);
  return runBatched(targets, MAX_CONCURRENT, probeTarget);
}
