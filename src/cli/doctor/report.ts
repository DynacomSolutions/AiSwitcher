import { bold, dim, green, red, yellow } from "../colors.ts";
import type { DoctorResult, DoctorStatus } from "./types.ts";

const BRANCH = "├── ";
const BRANCH_LAST = "└── ";

function identityCount(n: number): string {
  return n === 1 ? "1 identity" : `${n} identities`;
}

function statusLabel(status: DoctorStatus): string {
  if (status === "responsive") return green("✔ responsive");
  if (status === "hung") return red("✖ hung");
  return yellow("○ unavailable");
}

function formatElapsed(ms: number | undefined): string {
  return ms === undefined ? "" : `  ${dim(`(${(ms / 1000).toFixed(1)}s)`)}`;
}

function buildDetailRow(result: DoctorResult): string {
  const parts = [statusLabel(result.status), formatElapsed(result.elapsedMs)];
  if (result.detail) parts.push(`  ${dim(result.detail)}`);
  return parts.join("");
}

/** Renders one section per tool, one branch per probed identity underneath —
 * no bars (unlike limits/report.ts), since a doctor result is pass/fail/
 * unavailable, not a percentage. A trailing summary line calls out any
 * "hung" identity by name, since that's the one status this command exists
 * to surface quickly rather than make the reader scan for it. */
export function formatDoctorReport(results: DoctorResult[]): string {
  if (results.length === 0) return dim("No matching identities found.");

  const groups = new Map<DoctorResult["toolName"], DoctorResult[]>();
  for (const r of results) {
    const list = groups.get(r.toolName) ?? [];
    list.push(r);
    groups.set(r.toolName, list);
  }

  const lines: string[] = [];
  let firstSection = true;
  for (const [toolName, group] of groups) {
    if (!firstSection) lines.push("");
    firstSection = false;
    lines.push(`${bold(toolName)} ${dim(`(${identityCount(group.length)})`)}`);
    group.forEach((result, i) => {
      const connector = i === group.length - 1 ? BRANCH_LAST : BRANCH;
      const label = `${bold(result.identity.name)}  ${dim(`(${result.identity.label})`)}`;
      lines.push(`${connector}${label}  ${buildDetailRow(result)}`);
    });
  }

  const hung = results.filter((r) => r.status === "hung");
  if (hung.length > 0) {
    lines.push("");
    const names = hung.map((r) => `${r.toolName}/${r.identity.name}`).join(", ");
    lines.push(
      dim(
        `Hung: ${names} — check for orphaned/still-running agents under ` +
          `${hung.length === 1 ? "that identity" : "those identities"} before assuming a billing or provider-side issue.`,
      ),
    );
  }

  return lines.join("\n");
}
