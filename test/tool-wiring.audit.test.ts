import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_CONFIGS } from "../src/cli/identities/resolve-tool.ts";

/**
 * Mechanical half of AGENTS.md's "Adding another wrapped tool later"
 * contract: registering a tool in TOOL_CONFIGS is a commitment to wire it
 * EVERYWHERE, and this audit fails the suite the moment a registered tool
 * is missing from a file that must name every tool. It exists because the
 * compiler alone could not catch the 2026-09-03 `ais usage` crash: opencode
 * joined the toolName union and TOOL_CONFIGS without matching cases in the
 * usage pipeline, and nothing errored until a user ran the command.
 *
 * Two kinds of check live here:
 *   1. Structural — each registered tool has a wrapper entrypoint at
 *      src/<tool>.ts.
 *   2. Presence — each file in FILES below mentions every registered tool
 *      (as a word, or via its `<TOOL>_CONFIG` const name for files wired by
 *      config references rather than string literals).
 *
 * Deliberately NOT audited (partial-by-design touchpoints — a new tool must
 * still make a conscious decision for each, see AGENTS.md step 7):
 * doctor/collect.ts PROBES, usage/run.ts fetchExtraCost, cli/limits/*,
 * cli/resume/*, cli/auth/*, identities/model-pricing.ts. Presence checks
 * are tripwires, not proofs — a comment naming a tool satisfies the file
 * check; only the checklist and review prove real wiring.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const TOOL_NAMES = Object.keys(TOOL_CONFIGS);

/** Files that must mention EVERY registered tool, and why. When a new
 * integration point is added to the codebase, add it here too; when a new
 * tool is registered, these are the files that must learn about it (or the
 * checklist in AGENTS.md was not followed). */
const FILES: Array<{ path: string; why: string }> = [
  { path: "src/identities/types.ts", why: "the toolName union every other module switches over" },
  { path: "src/identities/tool-configs.ts", why: "the per-tool ToolConfig consts" },
  { path: "src/cli/identities/resolve-tool.ts", why: "the TOOL_CONFIGS registry" },
  { path: "src/open.ts", why: "its own TOOL_CONFIGS array (chrome-profile support)" },
  { path: "src/shared/cli-args.ts", why: "argv parsing and non-interactive hints per tool" },
  { path: "src/cli/update.ts", why: "MANAGED_BINARIES" },
  { path: "src/cli/upgrade.ts", why: "UPGRADE_SPECS" },
  { path: "src/installer.ts", why: "the interactive install menu" },
  { path: "src/cli/usage/providers.ts", why: "providerForTool and the provider alias/label tables" },
  { path: "src/cli/usage/tokscale.ts", why: "tokscaleInvocationFor and the merged-env rules" },
  { path: "src/cli/usage/run.ts", why: "the runOne dispatch and daily-usage client unions" },
  { path: "scripts/build.ts", why: "ENTRYPOINTS release binaries" },
  { path: "scripts/install.ts", why: "shim BINARIES and backupGroups" },
  { path: "scripts/backup.ts", why: "the backup groups" },
  { path: ".github/workflows/release.yml", why: "the build/upload steps" },
  { path: "AGENTS.md", why: "the contributor/agent docs" },
  { path: "README.md", why: "the user-facing docs" },
];

function mentionsTool(text: string, tool: string): boolean {
  if (new RegExp(`\\b${tool}\\b`).test(text)) return true;
  return text.includes(`${tool.toUpperCase()}_CONFIG`);
}

describe("tool wiring audit", () => {
  test("every registered tool has a wrapper entrypoint at src/<tool>.ts", async () => {
    for (const tool of TOOL_NAMES) {
      const entrypoint = join(REPO_ROOT, "src", `${tool}.ts`);
      const stats = await stat(entrypoint).catch(() => undefined);
      expect({ tool, exists: stats?.isFile() ?? false }).toEqual({ tool, exists: true });
    }
  });

  test("every registered tool is named by every file that must know it", async () => {
    for (const { path, why } of FILES) {
      const text = await Bun.file(join(REPO_ROOT, path)).text();
      for (const tool of TOOL_NAMES) {
        expect(
          { file: path, tool, mentioned: mentionsTool(text, tool) },
          `${path} does not mention registered tool "${tool}" (${why}). A tool must be wired everywhere in one change — see AGENTS.md "Adding another wrapped tool later" and this audit's header.`,
        ).toEqual({ file: path, tool, mentioned: true });
      }
    }
  });
});
