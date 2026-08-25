import type { Identity, ToolConfig } from "../../identities/types.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { loadAll, TOOL_CONFIGS, toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { readClaudeSessions } from "./claude-resume.ts";
import { readCodexSessions } from "./codex-resume.ts";
import { readGrokSessions } from "./grok-resume.ts";
import { readKimiSessions } from "./kimi-resume.ts";
import { readZaiSessions } from "./zai-resume.ts";
import { readAliSessions } from "./ali-resume.ts";
import type { ToolResumeResult } from "./types.ts";

export interface ResumeTarget {
  toolName: ToolConfig["toolName"];
  identity: Identity;
}

// Partial, not a full Record: ToolConfig["toolName"]'s union can grow (e.g. a
// tool added to the identities registry before its own resume reader exists
// yet) without this failing to compile — readTarget below reports an error
// result for any tool with no entry here instead of assuming exhaustive
// coverage. Mirrors doctor/collect.ts's PROBES and limits/collect.ts's
// FETCHERS. zai-resume.ts reads Crush's own project-local `.crush/crush.db`
// (SQLite), found via that identity's `projects.json` — nothing under the
// identity's own configDir the way the other four store sessions.
const READERS: Partial<Record<ToolConfig["toolName"], (identity: Identity, cwd: string) => Promise<ToolResumeResult>>> = {
  claude: readClaudeSessions,
  codex: readCodexSessions,
  grok: readGrokSessions,
  kimi: readKimiSessions,
  zai: readZaiSessions,
  ali: readAliSessions,
};

/** Same shape/rules as usage/run.ts's collectTargets: identity comes from
 * `--identity=`, not a positional (resume's own positional is reserved for
 * the session selector). An identity configured for more than one tool (a
 * real case) is not an error here, since seeing that identity's claude AND
 * codex sessions side by side is the point. `configs` defaults to the real
 * TOOL_CONFIGS, only overridden by tests. */
export async function collectResumeTargets(
  flags: ParsedArgs["flags"],
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
): Promise<ResumeTarget[]> {
  const toolFilter = toolConfigFromFlag(flags);
  const identityFilter = stringFlag(flags, "identity");
  const targetConfigs = toolFilter ? [toolFilter] : configs;
  const loaded = await loadAll(targetConfigs);

  const targets: ResumeTarget[] = [];
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

function readTarget(target: ResumeTarget, cwd: string): Promise<ToolResumeResult> {
  const reader = READERS[target.toolName];
  if (!reader) {
    return Promise.resolve({
      toolName: target.toolName,
      identity: target.identity,
      sessions: [],
      error: `no resume reader implemented for "${target.toolName}" yet`,
    });
  }
  return reader(target.identity, cwd);
}

/** Reads are pure local filesystem I/O (no subprocess, no live API, no rate
 * limits to be a courteous neighbor to), unlike limits' fetchers, so every
 * target is safe to run fully in parallel. */
export async function runResumeQuery(flags: ParsedArgs["flags"], cwd: string): Promise<ToolResumeResult[]> {
  const targets = await collectResumeTargets(flags);
  return Promise.all(targets.map((t) => readTarget(t, cwd)));
}
