import { arch, platform } from "node:os";
import { chmod, lstat, rename, rm } from "node:fs/promises";

// The release-asset download layer shared by everything that pulls
// pre-built binaries off this repo's GitHub Releases: src/installer.ts
// (fresh installs), `ais update` (src/cli/update.ts) and the aistui
// self-heal (src/shared/aistui-bin.ts). No `gh` CLI, no auth required.

export const REPO = "DynacomSolutions/AiSwitcher";

/** Maps an os/arch pair onto the release asset platform suffix
 * ("<os>-<cpu>", e.g. "darwin-arm64"). Throwing here is honest: there is
 * genuinely no release asset for anything but these four targets. */
export function platformKeyFrom(os: string, cpu: string): string {
  const osKey = os === "darwin" ? "darwin" : os === "linux" ? "linux" : null;
  const cpuKey = cpu === "arm64" ? "arm64" : cpu === "x64" ? "x64" : null;
  if (!osKey || !cpuKey) {
    throw new Error(`unsupported platform ${os}/${cpu}: no release asset exists for this target`);
  }
  return `${osKey}-${cpuKey}`;
}

export function platformKey(): string {
  return platformKeyFrom(platform(), arch());
}

export interface DownloadAssetOptions {
  /** Release tag to download from ("v0.3.0"); omitted means the latest
   * release. */
  tag?: string;
  /** Injected fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** chmod applied to the file before it lands at its final name
   * (downloadAssetAtomic only; 0o755 for executables). */
  mode?: number;
}

/**
 * GitHub serves a stable redirect from .../releases/latest/download/<asset>
 * straight to the current release's asset - no API call, no rate limit,
 * no auth needed. With a tag, .../releases/download/<tag>/<asset> works the
 * same way. But both redirects 404 for anyone without repo read access when
 * the repo is PRIVATE - a plain fetch fails on every asset well before ever
 * reaching "ais" itself, and the whole update silently fails at the first
 * binary. GitHub returns 404, not 401/403, for an unauthenticated request
 * against a private release, so this looks identical to "no such release"
 * rather than "no access" unless you already know to suspect auth.
 *
 * `GH_TOKEN`/`GITHUB_TOKEN` (same env var names `gh`/GitHub Actions use) are
 * read opportunistically: if set, the download goes through the
 * authenticated API asset flow instead (look up the release, find the
 * matching asset by name, fetch its API `url` with
 * `Accept: application/octet-stream`). No token is ever generated, stored,
 * or embedded here - this only consumes one already present in the calling
 * environment. Without a token, behavior is byte-for-byte what it was
 * before: the same plain public redirect fetch.
 */
async function fetchAssetResponse(assetName: string, tag?: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    const url = tag
      ? `https://github.com/${REPO}/releases/download/${tag}/${assetName}`
      : `https://github.com/${REPO}/releases/latest/download/${assetName}`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`installer: download failed for ${assetName}: HTTP ${response.status} (${url})`);
    }
    return response;
  }

  const authHeaders = { Authorization: `Bearer ${token}` };
  const releaseUrl = tag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;
  const releaseRes = await fetchImpl(releaseUrl, {
    headers: { ...authHeaders, Accept: "application/vnd.github+json" },
  });
  if (!releaseRes.ok) {
    throw new Error(`installer: could not look up the ${tag ?? "latest"} release: HTTP ${releaseRes.status} (${releaseUrl})`);
  }
  const release = (await releaseRes.json()) as { assets?: Array<{ name: string; url: string }> };
  const asset = release.assets?.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`installer: ${tag ?? "latest"} release has no asset named ${assetName}`);
  }
  const assetRes = await fetchImpl(asset.url, {
    headers: { ...authHeaders, Accept: "application/octet-stream" },
  });
  if (!assetRes.ok) {
    throw new Error(`installer: download failed for ${assetName}: HTTP ${assetRes.status} (${asset.url})`);
  }
  return assetRes;
}

export async function downloadAsset(assetName: string, dest: string, options: DownloadAssetOptions = {}): Promise<void> {
  const response = await fetchAssetResponse(assetName, options.tag, options.fetchImpl);
  // Unlink first: Bun.write follows a destination symlink and overwrites
  // whatever it points at, rather than replacing the symlink itself. This
  // matters when the REAL tool's own installer already left a symlink at
  // this exact shim path - confirmed for grok, whose installer symlinks
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
 * `ais` binary currently executing it - POSIX rename() doesn't touch an
 * already-open/running inode, so this is safe where a direct write wouldn't
 * be. `mode` chmods the temp file BEFORE the rename, so the final path is
 * never a non-executable file even for an instant (the aistui self-heal
 * needs this; the installer chmods after the fact instead). A destination
 * symlink is unlinked before the rename: rename() itself would replace the
 * symlink without following it, but leaving an attacker- or leftover-owned
 * symlink in place across the download window is exactly what the
 * unlink-first rule above exists to avoid.
 */
export async function downloadAssetAtomic(assetName: string, dest: string, options: DownloadAssetOptions = {}): Promise<void> {
  const tmpDest = `${dest}.download-tmp`;
  await downloadAsset(assetName, tmpDest, options);
  if (options.mode !== undefined) await chmod(tmpDest, options.mode);
  const existing = await lstat(dest).catch(() => undefined);
  if (existing?.isSymbolicLink()) await rm(dest, { force: true });
  await rename(tmpDest, dest);
}
