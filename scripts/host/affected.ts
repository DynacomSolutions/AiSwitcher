// Host app change selection, on the shared dependency graph engine
// (scripts/ci/affected.ts). The host package consumes the adapter sidecar
// sources, the test/host import graph, apps/host, scripts/host, image/contract
// and the packaged trust key and licence. Anything else skips the host jobs.
// Shared inputs and unknown paths fail open to a full run.
import { appendFileSync } from "node:fs";
import { diffChanges, filterVersionOnlyBump, selectChanges, showFile } from "../ci/affected.ts";

export type HostCheckSelection = "host" | "all";

export function affectedHostChecks(paths: readonly string[], options: { hasDeletions?: boolean } = {}): HostCheckSelection[] {
  if (paths.length === 0) return [];
  const selection = selectChanges(paths, options);
  if (selection.full) return ["all"];
  if (selection.host) return ["host"];
  return [];
}

if (import.meta.main) {
  let paths = Bun.argv.slice(2);
  let forceAll = false;
  let hasDeletions = false;
  if (paths.includes("--github")) {
    forceAll = process.env.GITHUB_EVENT_NAME !== "pull_request" || process.env.HOST_PRODUCTION === "true";
    const base = process.env.BASE_SHA ?? "";
    const head = process.env.HEAD_SHA ?? "";
    if (!forceAll) {
      const diff = diffChanges(base, head);
      if (diff) {
        // A version-only bump of the root package.json changes no build input.
        paths = filterVersionOnlyBump(diff.paths, showFile(base, "package.json"), showFile(head, "package.json"));
        hasDeletions = diff.hasDeletions;
      } else forceAll = true;
    }
  }
  const selection = forceAll ? ["all"] : affectedHostChecks(paths, { hasDeletions });
  const value = selection.length ? selection.join(" ") : "skip";
  if (Bun.argv.includes("--github")) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
    appendFileSync(process.env.GITHUB_OUTPUT, `selection=${value}\n`);
  }
  console.log(value);
}
