import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { downloadReleaseAsset, withRetries } from "./github-release-asset";

/**
 * Pre-fetches the tools `cargo tauri build` would download from github.com release URLs (tauri-bundler 2.10)
 * through the GitHub API instead, so the bundler finds them in its cache and makes no network call.
 * Linux only: AppImage tools for the native build, the NSIS pieces for the cross-built Windows installer.
 */
export const appImageTools = [
  { repo: "tauri-apps/binary-releases", tag: "apprun-old", asset: "AppRun-x86_64", file: "AppRun-x86_64", sha256: "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f", required: true },
  { repo: "tauri-apps/binary-releases", tag: "linuxdeploy-07333c6", asset: "linuxdeploy-x86_64.AppImage", file: "linuxdeploy-07333c6-x86_64.AppImage", sha256: "36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62", required: true },
  // A moving "continuous" release, so it is checked against the digest the API reports. The bundler treats it as optional.
  { repo: "linuxdeploy/linuxdeploy-plugin-appimage", tag: "continuous", asset: "linuxdeploy-plugin-appimage-x86_64.AppImage", file: "linuxdeploy-plugin-appimage.AppImage", sha256: undefined, required: false },
] as const;

export const nsisTools = {
  utils: { repo: "tauri-apps/nsis-tauri-utils", tag: "nsis_tauri_utils-v0.5.3", asset: "nsis_tauri_utils.dll", sha256: "5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709", sha1: "75197fee3c6a814fe035788d1c34ead39349b860" },
  // The bundler also checks NSIS/NSIS.exe from this archive, even when it uses the system makensis.
  archive: { repo: "tauri-apps/binary-releases", tag: "nsis-3.13", asset: "nsis-3.13.zip", sha256: "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8" },
  exeSha1: "6d45d4e8ccf18fe1fdac9164058f356102a2ecf2",
} as const;

const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

export function toolsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "tauri");
}

function store(path: string, bytes: Uint8Array, executable: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  if (executable) chmodSync(path, 0o755);
}

export async function prefetch(directory: string, wantAppImage: boolean, wantNsis: boolean, token: string | undefined): Promise<void> {
  if (wantAppImage) {
    for (const tool of appImageTools) {
      const path = join(directory, tool.file);
      if (existsSync(path)) continue; // restored from the cache; the bundler patches linuxdeploy in place
      try {
        store(path, await withRetries(() => downloadReleaseAsset(tool.repo, tool.tag, tool.asset, token, tool.sha256)), true);
        console.log(`prefetched ${tool.file}`);
      } catch (error) {
        if (tool.required) throw error;
        console.warn(`optional ${tool.file} not prefetched: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  if (wantNsis) {
    const nsis = join(directory, "NSIS");
    const dll = join(nsis, "Plugins/x86-unicode/additional/nsis_tauri_utils.dll");
    const exe = join(nsis, "NSIS.exe");
    if (!existsSync(dll) || sha1(readFileSync(dll)) !== nsisTools.utils.sha1) {
      const { repo, tag, asset, sha256 } = nsisTools.utils;
      const bytes = await withRetries(() => downloadReleaseAsset(repo, tag, asset, token, sha256));
      if (sha1(bytes) !== nsisTools.utils.sha1) throw new Error("nsis_tauri_utils.dll SHA-1 mismatch");
      store(dll, bytes, false);
    }
    if (!existsSync(exe) || sha1(readFileSync(exe)) !== nsisTools.exeSha1) {
      const { repo, tag, asset, sha256 } = nsisTools.archive;
      const archive = join(directory, ".nsis-3.13.zip");
      store(archive, await withRetries(() => downloadReleaseAsset(repo, tag, asset, token, sha256)), false);
      const extracted = Bun.spawnSync(["unzip", "-p", archive, "nsis-3.13/NSIS.exe"], { stdout: "pipe", stderr: "pipe" });
      if (extracted.exitCode !== 0) throw new Error(`unzip failed: ${extracted.stderr.toString().slice(-500)}`);
      const bytes = new Uint8Array(extracted.stdout);
      if (sha1(bytes) !== nsisTools.exeSha1) throw new Error("NSIS.exe SHA-1 mismatch");
      store(exe, bytes, false);
    }
    console.log("prefetched the NSIS pieces");
  }
}

if (import.meta.main) {
  if (process.platform !== "linux") throw new Error("Bundler tool prefetch is for Linux runners.");
  const wantAppImage = Bun.argv.includes("--appimage");
  const wantNsis = Bun.argv.includes("--nsis");
  if (!wantAppImage && !wantNsis) throw new Error("usage: prefetch-bundler-tools.ts [--appimage] [--nsis]");
  await prefetch(toolsDirectory(), wantAppImage, wantNsis, process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
}
