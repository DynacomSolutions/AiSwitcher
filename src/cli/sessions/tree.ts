import type { Identity } from "../../identities/types.ts";
import { readClaudeTree } from "./claude.ts";
import { readCodexTree } from "./codex.ts";
import { readCrushTree } from "./crush.ts";
import { readGrokTree } from "./grok.ts";
import { readKimiTree } from "./kimi.ts";
import { readPiTree } from "./pi.ts";
import type { SessionTool, ToolTreeDto, TreeNodeDto } from "./types.ts";
import type { WindowOpts } from "./shared.ts";

/**
 * Dispatcher behind GET /api/sessions/tree (and `readSessionTrees`, the
 * documented programmatic surface). One call reads ONE tool+identity slice;
 * the server fans this over every (tool, identity) pair the flags select,
 * exactly like the resume readers' collect.ts.
 *
 * Tools with no reader answer with an honest `unavailable` note and empty
 * nodes (opencode today); a reader that THROWS becomes a per-slice `error`
 * with the other slices untouched.
 */

interface NormalisedTree {
  nodes: TreeNodeDto[];
  error?: string;
}

type TreeReader = (identity: Identity, opts: WindowOpts) => Promise<NormalisedTree>;

function asResult(nodes: TreeNodeDto[]): NormalisedTree {
  return { nodes };
}

/** Partial, not a full Record: a tool added to the registry before its tree
 * reader exists must degrade to `unavailable`, not fail to compile (same
 * convention as resume/collect.ts's READERS). zai/ali both read Crush's
 * project-local dbs through readCrushTree (see crush.ts). */
const READERS: Partial<Record<SessionTool, TreeReader>> = {
  claude: (identity, opts) => readClaudeTree(identity, opts).then(asResult),
  codex: (identity, opts) => readCodexTree(identity, opts).then(asResult),
  pi: (identity, opts) => readPiTree(identity, opts).then(asResult),
  grok: (identity, opts) => readGrokTree(identity, opts),
  kimi: (identity, opts) => readKimiTree(identity, opts).then(asResult),
  zai: (identity, opts) => readCrushTree("zai", identity, "data", "zai", opts),
  ali: (identity, opts) => readCrushTree("ali", identity, "data", "alibaba", opts),
};

export function hasTreeReader(tool: SessionTool): boolean {
  return tool in READERS;
}

/** Assigns depth within the returned set: children of present parents get
 * parent.depth + 1; orphans (parentId pointing outside the window or at a
 * vanished record) render as roots at depth 0 but KEEP their parentId so a
 * UI can show a stub. Input order is preserved; cycles (corrupt data)
 * terminate at depth 0 rather than looping. */
function computeDepths(nodes: TreeNodeDto[]): TreeNodeDto[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depths = new Map<string, number>();
  const inProgress = new Set<string>();
  const depthOf = (node: TreeNodeDto): number => {
    const cached = depths.get(node.id);
    if (cached !== undefined) return cached;
    if (inProgress.has(node.id)) return 0; // cycle guard
    const parent = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
    if (!parent) {
      depths.set(node.id, 0);
      return 0;
    }
    inProgress.add(node.id);
    const depth = depthOf(parent) + 1;
    inProgress.delete(node.id);
    depths.set(node.id, depth);
    return depth;
  };
  for (const node of nodes) node.depth = depthOf(node);
  return nodes;
}

export async function readSessionTrees(
  tool: SessionTool,
  identity: Identity,
  opts: WindowOpts = {},
): Promise<ToolTreeDto> {
  const reader = READERS[tool];
  if (!reader) {
    return {
      tool,
      identity: identity.name,
      nodes: [],
      unavailable: `no session tree reader implemented for "${tool}" yet`,
    };
  }
  try {
    const { nodes, error } = await reader(identity, opts);
    return {
      tool,
      identity: identity.name,
      nodes: computeDepths(nodes),
      ...(error !== undefined ? { error } : {}),
    };
  } catch (err) {
    return {
      tool,
      identity: identity.name,
      nodes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
