import { homedir, platform } from "node:os";
import { join } from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import * as clack from "@clack/prompts";
import { runBackup } from "../scripts/backup.ts";
import { downloadAsset, platformKey, REPO } from "./shared/release-assets.ts";

// The actual download mechanics (fetchAssetResponse/downloadAsset and the
// platform mapping) live in shared/release-assets.ts so `ais update`,
// the installer, and the aistui self-heal all pull release assets through
// one code path. Re-exported here so the historical import sites
// (src/cli/update.ts) keep working.
export { downloadAsset, downloadAssetAtomic, platformKey, platformKeyFrom, REPO } from "./shared/release-assets.ts";

// This installer prompts + pulls the right pre-built asset from the GH
// Release matching the current platform/arch, no `gh` CLI required.
// platformKey/downloadAsset (re-exported above) are what `ais update`
// (src/cli/update.ts) reuses for the exact same release-fetching logic.

const TOOLS = [
  { value: "claude", label: "Claude Code", hint: "proxies the real `claude` CLI" },
  { value: "codex", label: "Codex", hint: "proxies the real `codex` CLI" },
  { value: "grok", label: "Grok", hint: "proxies the real `grok` CLI" },
  { value: "kimi", label: "Kimi Code", hint: "proxies the real `kimi` CLI" },
  { value: "zai", label: "ZAI", hint: "proxies the real `crush` CLI (github.com/charmbracelet/crush), pointed at the ZAI/Z.ai provider" },
  { value: "ali", label: "Alibaba", hint: "proxies the real `crush` CLI (github.com/charmbracelet/crush), pointed at Alibaba Cloud Model Studio's Token plan" },
  { value: "pi", label: "Pi", hint: "proxies the multi-provider `pi` coding-agent CLI" },
  { value: "opencode", label: "OpenCode", hint: "proxies the multi-provider `opencode` coding-agent CLI" },
] as const;

type ToolName = (typeof TOOLS)[number]["value"];

async function runInstaller(): Promise<void> {
  clack.intro("AiProfileSwitcher installer");

  const selected = await clack.multiselect({
    message: "Which tools do you want to install/proxy?",
    options: TOOLS.map(({ value, label, hint }) => ({ value, label, hint })),
    required: true,
  });

  if (clack.isCancel(selected)) {
    clack.cancel("Installation cancelled.");
    process.exit(1);
  }

  const platformSuffix = platformKey();

  const backupDir = await runBackup();
  clack.log.info(`Backup complete: ${backupDir}`);

  const shimDir = join(homedir(), ".local", "bin");
  await mkdir(shimDir, { recursive: true });

  // "open", "ais", and "aistui" are always installed alongside whichever
  // tools were picked - none is a proxy for a specific AI CLI, so none is
  // part of the tool multiselect above. "open" shadows /usr/bin/open so
  // auto-opened links use the active identity's Chrome profile, and is a
  // macOS-only concept (no bare `open` command on Linux to shadow/fall back
  // to), so it's skipped entirely elsewhere. "ais" is the management CLI
  // and "aistui" is the console TUI's Rust binary; both ship on every
  // platform. aistui is the newest of the three: releases older than it
  // have no aistui asset at all, so its download is the one tolerated
  // failure (a warning, not an install error - the `ais tui`/`ais herdr`
  // launchers self-heal the same download on first run).
  const toInstall: string[] = [
    ...(selected as ToolName[]),
    ...(platform() === "darwin" ? ["open"] : []),
    "ais",
    "aistui",
  ];

  for (const name of toInstall) {
    const assetName = `${name}-${platformSuffix}`;
    const spinner = clack.spinner();
    spinner.start(`Downloading ${assetName}`);
    const dest = join(shimDir, name);
    try {
      await downloadAsset(assetName, dest);
    } catch (err) {
      if (name === "aistui") {
        const reason = err instanceof Error ? err.message : String(err);
        spinner.stop(`skipped aistui (${reason}); ais tui/herdr will download it on first run`);
        continue;
      }
      throw err;
    }
    await chmod(dest, 0o755);
    spinner.stop(`installed ${name} -> ${dest}`);
  }

  clack.outro(
    "Done. Open a NEW terminal (or run `hash -r`) so PATH resolution picks up the shims.",
  );
}

if (import.meta.main) {
  await runInstaller();
}
