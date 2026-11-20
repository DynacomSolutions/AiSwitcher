// Decides whether a change set can affect the live image. The image holds the
// `ais` binary and `aistui`, so it depends on everything those are built from.
//
// CLI: changed files on stdin (one per line), metafile path as argv[2]
// (dist/ais.meta.json from `bun run build`). Prints `true` or `false`; any
// doubt (missing or unreadable metafile) prints `true`. A version-only bump
// of the root package.json is not an image input: the version string changes
// no behaviour. BASE_SHA and HEAD_SHA enable that check.
import { readFileSync } from "node:fs";
import { filterVersionOnlyBump, showFile } from "../../scripts/ci/affected.ts";

// Shared inputs: a change to any of these runs everything.
const SHARED = new Set([
  "bun.lock",
  "package.json",
  "tsconfig.json",
  "bunfig.toml",
  "scripts/build.ts",
  "scripts/source-hash.ts",
  "image/pins.env",
]);

const SHARED_PREFIXES = ["image/", ".github/workflows/", "apps/tui/"];

export function imageAffected(changed: string[], inputs: string[]): boolean {
  const known = new Set(inputs);
  return changed.some(
    (file) => SHARED.has(file) || SHARED_PREFIXES.some((p) => file.startsWith(p)) || known.has(file),
  );
}

if (import.meta.main) {
  try {
    const metafile = process.argv[2];
    if (!metafile) throw new Error("metafile path missing");
    const meta = JSON.parse(readFileSync(metafile, "utf8")) as { inputs: Record<string, unknown> };
    const changed = readFileSync(0, "utf8").split("\n").filter(Boolean);
    const base = process.env.BASE_SHA ?? "";
    const head = process.env.HEAD_SHA ?? "";
    const filtered = filterVersionOnlyBump(changed, showFile(base, "package.json", process.cwd()), showFile(head, "package.json", process.cwd()));
    console.log(String(imageAffected(filtered, Object.keys(meta.inputs))));
  } catch (error) {
    console.error(`affected: ${error instanceof Error ? error.message : "failed"}; failing open`);
    console.log("true");
  }
}
