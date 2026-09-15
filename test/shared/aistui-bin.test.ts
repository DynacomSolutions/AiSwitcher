import { describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import {
  aistuiAssetName,
  ensureAistuiBinary,
  realEnsureAistuiDeps,
  tuiDest,
  type EnsureAistuiDeps,
} from "../../src/shared/aistui-bin.ts";
import { platformKeyFrom } from "../../src/shared/release-assets.ts";

function fakeDeps(overrides: Partial<EnsureAistuiDeps> = {}) {
  const downloads: Array<{ assetName: string; tag: string | undefined }> = [];
  const logs: string[] = [];
  const deps: EnsureAistuiDeps = {
    resolveTuiBinary: () => undefined,
    version: () => "0.3.0",
    platformSuffix: () => "darwin-arm64",
    downloadAndInstall: async (assetName, tag) => {
      downloads.push({ assetName, tag });
    },
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps, downloads, logs };
}

describe("aistuiAssetName", () => {
  test("follows the <tool>-<platform> release asset convention", () => {
    expect(aistuiAssetName("darwin-arm64")).toBe("aistui-darwin-arm64");
    expect(aistuiAssetName("darwin-x64")).toBe("aistui-darwin-x64");
    expect(aistuiAssetName("linux-arm64")).toBe("aistui-linux-arm64");
    expect(aistuiAssetName("linux-x64")).toBe("aistui-linux-x64");
  });
});

describe("realEnsureAistuiDeps", () => {
  test("pins the release tag to the RUNNING ais's own version", () => {
    const deps = realEnsureAistuiDeps();
    expect(deps.version()).toBe(pkg.version);
    expect(deps.platformSuffix()).toBe(platformKeyFrom(platform(), arch()));
  });

  test("installs into ~/.local/bin/aistui", () => {
    expect(tuiDest()).toBe(join(homedir(), ".local", "bin", "aistui"));
  });
});

describe("ensureAistuiBinary", () => {
  test("existing resolution wins: no download, no network", async () => {
    const { deps, downloads } = fakeDeps({ resolveTuiBinary: () => "/opt/tools/aistui" });
    await expect(ensureAistuiBinary(deps)).resolves.toBe("/opt/tools/aistui");
    expect(downloads).toEqual([]);
  });

  test("downloads aistui-<platform> from the v<version> release first", async () => {
    const { deps, downloads } = fakeDeps();
    await expect(ensureAistuiBinary(deps)).resolves.toBe(tuiDest());
    expect(downloads).toEqual([{ assetName: "aistui-darwin-arm64", tag: "v0.3.0" }]);
  });

  test("falls back to the latest release when the pinned tag has no asset", async () => {
    const { deps, downloads } = fakeDeps({
      downloadAndInstall: async (assetName, tag) => {
        downloads.push({ assetName, tag });
        if (tag !== undefined) throw new Error("installer: download failed for aistui-darwin-arm64: HTTP 404");
      },
    });
    await expect(ensureAistuiBinary(deps)).resolves.toBe(tuiDest());
    expect(downloads).toEqual([
      { assetName: "aistui-darwin-arm64", tag: "v0.3.0" },
      { assetName: "aistui-darwin-arm64", tag: undefined },
    ]);
  });

  test("two failures fail honestly with BOTH reasons, exactly two attempts", async () => {
    const attempts: string[] = [];
    const { deps } = fakeDeps({
      downloadAndInstall: async (_assetName, tag) => {
        attempts.push(tag ?? "latest");
        throw new Error(tag ? `v0.3.0: HTTP 404` : "latest: connection refused");
      },
    });
    await expect(ensureAistuiBinary(deps)).rejects.toThrow(
      /aistui auto-install failed: v0\.3\.0 has no usable aistui-darwin-arm64 \(v0\.3\.0: HTTP 404\), and the latest-release fallback failed too \(latest: connection refused\)/,
    );
    expect(attempts).toEqual(["v0.3.0", "latest"]);
  });

  test("unsupported platforms surface the platform error, not a download", async () => {
    const { deps, downloads } = fakeDeps({
      platformSuffix: () => {
        throw new Error("unsupported platform win32/x64: no release asset exists for this target");
      },
    });
    await expect(ensureAistuiBinary(deps)).rejects.toThrow(/win32\/x64/);
    expect(downloads).toEqual([]);
  });
});
