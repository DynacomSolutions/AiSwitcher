import { bold, dim, yellow } from "../colors.ts";
import { formatElapsedMinutes } from "../limits/bar.ts";
import type { Identity } from "../../identities/types.ts";
import type { ResumableSession, ToolResumeResult } from "./types.ts";

export const BRANCH = "├── ";
export const BRANCH_LAST = "└── ";
export const DETAIL_INDENT = "│     ";
export const DETAIL_INDENT_LAST = "      ";
const GAP = 2;

/** Flattens every tool/identity's sessions into one list, most recently
 * active first. Used by --json (a flat, globally-sorted shape is more useful
 * to a scripted consumer than the human tree's grouping) and by exact-id
 * selector resolution. */
export function flattenSessions(results: ToolResumeResult[]): ResumableSession[] {
  return results
    .flatMap((r) => r.sessions)
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}

export function relativeTime(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  return formatElapsedMinutes(minutes);
}

export interface IdentityGroup {
  identity: Identity;
  /** Most-recently-active first. */
  sessions: ResumableSession[];
}

export interface ToolGroup {
  toolName: ToolResumeResult["toolName"];
  identityGroups: IdentityGroup[];
}

/** Groups into the same tool -> identity -> sessions shape `ais limits`
 * renders (see limits/report.ts's own buildIdentityBlock), preserving each
 * result's original order for both tools and identities within a tool
 * (collectResumeTargets' own registry-order iteration) rather than sorting
 * groups themselves — only the sessions inside a group are sorted, by
 * recency. An identity with zero sessions for this cwd contributes no group
 * at all: unlike limits (always showing every configured identity, even an
 * "unavailable" one), a resume listing's entire point is "what can I
 * actually resume," so nothing to resume means nothing to show. Shared by
 * both the static tree (formatResumeTree) and the interactive picker
 * (pick.ts) so the two never drift apart. */
export function groupByToolAndIdentity(results: ToolResumeResult[]): ToolGroup[] {
  const order: ToolGroup["toolName"][] = [];
  const byTool = new Map<ToolGroup["toolName"], IdentityGroup[]>();

  for (const r of results) {
    if (r.sessions.length === 0) continue;
    if (!byTool.has(r.toolName)) {
      byTool.set(r.toolName, []);
      order.push(r.toolName);
    }
    byTool.get(r.toolName)!.push({
      identity: r.identity,
      sessions: [...r.sessions].sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()),
    });
  }

  return order.map((toolName) => ({ toolName, identityGroups: byTool.get(toolName)! }));
}

export function identityCount(n: number): string {
  return n === 1 ? "1 identity" : `${n} identities`;
}

function errorLines(errors: ToolResumeResult[]): string[] {
  if (errors.length === 0) return [];
  return ["", bold("Errors:"), ...errors.map((r) => `  ${yellow(`${r.toolName}/${r.identity.name}`)}: ${r.error}`)];
}

/** The one column-width computation shared by the static tree and the
 * interactive picker's option labels, so a session's "last active" time
 * lines up at the same column everywhere a label of that length appears. */
export function labelColumnWidth(groups: ToolGroup[]): number {
  const labels = groups.flatMap((g) => g.identityGroups.flatMap((ig) => ig.sessions.map((s) => s.label)));
  return Math.max(0, ...labels.map((l) => l.length)) + GAP;
}

/** Same idea as labelColumnWidth, one column over: keeps the session-id
 * column (the one after "last active") aligned everywhere too. */
export function timeColumnWidth(groups: ToolGroup[], now: Date): number {
  const times = groups.flatMap((g) => g.identityGroups.flatMap((ig) => ig.sessions.map((s) => relativeTime(s.lastActiveAt, now))));
  return Math.max(0, ...times.map((t) => t.length)) + GAP;
}

/** Renders one session's "label  last-active  session-id" columns (no
 * leading indent — callers prepend their own, since the static tree and the
 * interactive picker indent differently). The session id is always the
 * final column and always dim: it's there for reference/copying (see
 * pick.ts's "c" shortcut), not something that needs to compete visually
 * with the label. Shared so the static tree and the interactive picker's
 * option labels can never drift apart on column layout. */
export function formatSessionColumns(s: ResumableSession, labelWidth: number, timeWidth: number, now: Date): string {
  const time = relativeTime(s.lastActiveAt, now);
  const labelPad = " ".repeat(Math.max(1, labelWidth - s.label.length));
  const timePad = " ".repeat(Math.max(1, timeWidth - time.length));
  return `${s.label}${labelPad}${dim(time)}${timePad}${dim(s.sessionId)}`;
}

/** Renders the same tool -> identity -> session tree `ais limits` uses
 * (provider header, identity branches, indented detail rows), just without
 * a bar/percentage (there's nothing to average here) — a trailing "Errors:"
 * section lists any (tool, identity) pair that failed to scan, mirroring
 * usage/report.ts's convention of never letting one bad identity silently
 * vanish from the report. This is what a non-interactive invocation
 * (`--json`'s non-JSON sibling when stdout isn't a TTY) prints; the
 * interactive default builds the same grouping into a clack picker instead
 * (see pick.ts). */
export function formatResumeTree(results: ToolResumeResult[], cwd: string, now: Date = new Date()): string {
  if (results.length === 0) return dim("No matching identities found.");

  const groups = groupByToolAndIdentity(results);
  const errors = results.filter((r) => r.error);

  if (groups.length === 0) {
    return [dim(`No resumable sessions found for ${cwd}.`), ...errorLines(errors)].join("\n");
  }

  const width = labelColumnWidth(groups);
  const timeWidth = timeColumnWidth(groups, now);
  const lines: string[] = [];

  groups.forEach((group, gi) => {
    if (gi > 0) lines.push("");
    lines.push(`${bold(group.toolName)} ${dim(`(${identityCount(group.identityGroups.length)})`)}`);

    group.identityGroups.forEach((ig, ii) => {
      const isLast = ii === group.identityGroups.length - 1;
      lines.push(`${isLast ? BRANCH_LAST : BRANCH}${bold(ig.identity.name)}  ${dim(`(${ig.identity.label})`)}`);

      const indent = isLast ? DETAIL_INDENT_LAST : DETAIL_INDENT;
      for (const s of ig.sessions) {
        lines.push(`${indent}${formatSessionColumns(s, width, timeWidth, now)}`);
      }
    });
  });

  lines.push("", dim("Resume one with: ais resume <session-id> (or omit it to pick interactively from a terminal)"));
  lines.push(...errorLines(errors));

  return lines.join("\n");
}

export interface ResumeJsonReport {
  sessions: Array<ResumableSession & { index: number }>;
  errors: Array<{ toolName: ToolResumeResult["toolName"]; identity: string; error: string }>;
}

/** `sessions` is the flat, globally-sorted shape (see flattenSessions), with
 * a 1-based "index" for a scripted consumer's own convenience: unrelated to
 * the tree's grouping, which only ever matters for the human-facing/
 * interactive views. `errors` surfaces any (tool, identity) pair that failed
 * to scan, since those would otherwise silently vanish from --json output
 * the way they don't from the tree's trailing "Errors:" section. */
export function toJsonReport(results: ToolResumeResult[]): ResumeJsonReport {
  return {
    sessions: flattenSessions(results).map((s, i) => ({ ...s, index: i + 1 })),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ toolName: r.toolName, identity: r.identity.name, error: r.error! })),
  };
}

