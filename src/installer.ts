import { homedir, platform, arch } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, rm } from "node:fs/promises";
import * as clack from "@clack/prompts";
import { runBackup } from "../scripts/backup.ts";

// This installer prompts + pulls the right pre-built asset from the GH
// Release matching the current platform/arch, no `gh` CLI required.
// Exported (along with platformKey/downloadAsset below) so `ais update`
// (src/cli/update.ts) reuses the exact same release-fetching logic instead
// of duplicating it.
export const REPO = "DynacomSolutions/AiSwitcher";

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

export function platformKey(): string {
  const os = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : null;
  const cpu = arch() === "arm64" ? "arm64" : arch() === "x64" ? "x64" : null;
  if (!os || !cpu) {
    throw new Error(`installer: unsupported platform ${platform()}/${arch()} — no release asset for this target`);
  }
  return `${os}-${cpu}`;
}

/**
 * GitHub serves a stable redirect from .../releases/latest/download/<asset>
 * straight to the current release's asset — no API call, no rate limit,
 * no auth needed. But that redirect 404s for anyone without repo read
 * access when the repo is PRIVATE — a plain fetch fails on every asset
 * well before ever reaching "ais" itself, and the whole update silently
 * fails at the first binary. GitHub returns 404, not 401/403, for an
 * unauthenticated request against a private release, so this looks
 * identical to "no such release" rather than "no access" unless you
 * already know to suspect auth.
 *
 * `GH_TOKEN`/`GITHUB_TOKEN` (same env var names `gh`/GitHub Actions use) are
 * read opportunistically: if set, the download goes through the
 * authenticated API asset flow instead (look up the latest release, find
 * the matching asset by name, fetch its API `url` with
 * `Accept: application/octet-stream`). No token is ever generated, stored,
 * or embedded here — this only consumes one already present in the calling
 * environment. Without a token, behavior is byte-for-byte what it was
 * before: the same plain public redirect fetch.
 */
async function fetchAssetResponse(assetName: string): Promise<Response> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    const url = `https://github.com/${REPO}/releases/latest/download/${assetName}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`installer: download failed for ${assetName}: HTTP ${response.status} (${url})`);
    }
    return response;
  }

  const authHeaders = { Authorization: `Bearer ${token}` };
  const releaseUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
  const releaseRes = await fetch(releaseUrl, {
    headers: { ...authHeaders, Accept: "application/vnd.github+json" },
  });
  if (!releaseRes.ok) {
    throw new Error(`installer: could not look up the latest release: HTTP ${releaseRes.status} (${releaseUrl})`);
  }
  const release = (await releaseRes.json()) as { assets?: Array<{ name: string; url: string }> };
  const asset = release.assets?.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`installer: latest release has no asset named ${assetName}`);
  }
  const assetRes = await fetch(asset.url, {
    headers: { ...authHeaders, Accept: "application/octet-stream" },
  });
  if (!assetRes.ok) {
    throw new Error(`installer: download failed for ${assetName}: HTTP ${assetRes.status} (${asset.url})`);
  }
  return assetRes;
}

export async function downloadAsset(assetName: string, dest: string): Promise<void> {
  const response = await fetchAssetResponse(assetName);
  // Unlink first: Bun.write follows a destination symlink and overwrites
  // whatever it points at, rather than replacing the symlink itself. This
  // matters when the REAL tool's own installer already left a symlink at
  // this exact shim path — confirmed for grok, whose installer symlinks
  // ~/.local/bin/grok -> ~/.grok/bin/grok. Without this, a first-time
  // install would silently overwrite the real grok binary instead of
  // shadowing it.
  await rm(dest, { force: true });
  await Bun.write(dest, response);
}

/**
 * Same download as downloadAsset, but writes to a temp file in dest's own
 * directory and rename()s over dest rather than writing dest directly. Needed
 * by `ais update` (src/cli/update.ts), which can be overwriting the very
 * `ais` binary currently executing it — POSIX rename() doesn't touch an
 * already-open/running inode, so this is safe where a direct write wouldn't
 * be. downloadAsset itself is unaffected: nothing it's ever used for today
 * is the process currently running.
 */
export async function downloadAssetAtomic(assetName: string, dest: string): Promise<void> {
  const tmpDest = `${dest}.download-tmp`;
  await downloadAsset(assetName, tmpDest);
  const { rename } = await import("node:fs/promises");
  await rename(tmpDest, dest);
}

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

  // "open" and "ais" are always installed alongside whichever tools were
  // picked — neither is a proxy for a specific AI CLI, so neither is part of
  // the tool multiselect above. "open" shadows /usr/bin/open so auto-opened
  // links use the active identity's Chrome profile, and is a macOS-only
  // concept (no bare `open` command on Linux to shadow/fall back to), so
  // it's skipped entirely elsewhere. "ais" is the management CLI and ships
  // on every platform.
  const toInstall: string[] = [...(selected as ToolName[]), ...(platform() === "darwin" ? ["open"] : []), "ais"];

  for (const name of toInstall) {
    const assetName = `${name}-${platformSuffix}`;
    const spinner = clack.spinner();
    spinner.start(`Downloading ${assetName}`);
    const dest = join(shimDir, name);
    await downloadAsset(assetName, dest);
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
