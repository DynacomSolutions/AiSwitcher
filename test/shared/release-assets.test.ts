import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAssetAtomic, platformKeyFrom } from "../../src/shared/release-assets.ts";

const SAVE_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/** The unauthenticated redirect path is the one under test; a stray CI
 * token in the environment would silently switch to the API flow. */
function withoutTokenEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = SAVE_TOKEN_VARS.map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];
  return run().finally(() => {
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  });
}

describe("platformKeyFrom", () => {
  test("maps the four shipped release platforms", () => {
    expect(platformKeyFrom("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformKeyFrom("darwin", "x64")).toBe("darwin-x64");
    expect(platformKeyFrom("linux", "arm64")).toBe("linux-arm64");
    expect(platformKeyFrom("linux", "x64")).toBe("linux-x64");
  });

  test("refuses platforms with no release asset, honestly", () => {
    expect(() => platformKeyFrom("win32", "x64")).toThrow(/win32\/x64/);
    expect(() => platformKeyFrom("sunos", "arm64")).toThrow(/sunos\/arm64/);
  });
});

describe("downloadAssetAtomic", () => {
  test("downloads the tagged asset URL, chmods, renames atomically, cleans the temp file", async () => {
    await withoutTokenEnv(async () => {
      const dir = await mkdtemp(join(tmpdir(), "ais-release-assets-"));
      try {
        const urls: string[] = [];
        const fetchImpl = (async (url: string | URL | Request) => {
          urls.push(String(url));
          return new Response("fake-binary-bytes", { status: 200 });
        }) as typeof fetch;
        const dest = join(dir, "tool");
        await downloadAssetAtomic("tool-linux-x64", dest, { tag: "v1.2.3", mode: 0o755, fetchImpl });
        expect(urls).toEqual([
          "https://github.com/DynacomSolutions/AiSwitcher/releases/download/v1.2.3/tool-linux-x64",
        ]);
        const file = Bun.file(dest);
        expect(await file.text()).toBe("fake-binary-bytes");
        const mode = (await lstat(dest)).mode & 0o777;
        expect(mode).toBe(0o755);
        expect(await Array.fromAsync(new Bun.Glob("*.download-tmp").scan({ cwd: dir }))).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test("without a tag it targets the latest release redirect", async () => {
    await withoutTokenEnv(async () => {
      const dir = await mkdtemp(join(tmpdir(), "ais-release-assets-"));
      try {
        const urls: string[] = [];
        const fetchImpl = (async (url: string | URL | Request) => {
          urls.push(String(url));
          return new Response("x", { status: 200 });
        }) as typeof fetch;
        await downloadAssetAtomic("tool-linux-x64", join(dir, "tool"), { fetchImpl });
        expect(urls).toEqual([
          "https://github.com/DynacomSolutions/AiSwitcher/releases/latest/download/tool-linux-x64",
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test("a missing asset fails honestly and writes nothing", async () => {
    await withoutTokenEnv(async () => {
      const dir = await mkdtemp(join(tmpdir(), "ais-release-assets-"));
      try {
        const fetchImpl = (async (_url: string | URL | Request) => new Response("Not Found", { status: 404 })) as typeof fetch;
        const dest = join(dir, "aistui");
        expect(
          downloadAssetAtomic("aistui-linux-x64", dest, { tag: "v0.3.0", fetchImpl }),
        ).rejects.toThrow(/aistui-linux-x64.*HTTP 404/s);
        expect(await Bun.file(dest).exists()).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test("a destination symlink is replaced, never followed", async () => {
    await withoutTokenEnv(async () => {
      const dir = await mkdtemp(join(tmpdir(), "ais-release-assets-"));
      try {
        const sentinel = join(dir, "sentinel");
        await writeFile(sentinel, "precious-target");
        const dest = join(dir, "aistui");
        await symlink(sentinel, dest);
        const fetchImpl = (async (_url: string | URL | Request) => new Response("installed-bytes", { status: 200 })) as typeof fetch;
        await downloadAssetAtomic("aistui-darwin-arm64", dest, { mode: 0o755, fetchImpl });
        // The symlink's TARGET must be untouched...
        expect(await Bun.file(sentinel).text()).toBe("precious-target");
        // ...and the destination is now a regular file with the download.
        expect((await lstat(dest)).isSymbolicLink()).toBe(false);
        expect(await Bun.file(dest).text()).toBe("installed-bytes");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test("an existing regular file is overwritten in place via rename", async () => {
    await withoutTokenEnv(async () => {
      const dir = await mkdtemp(join(tmpdir(), "ais-release-assets-"));
      try {
        const dest = join(dir, "ais");
        await writeFile(dest, "old-ais");
        const fetchImpl = (async (_url: string | URL | Request) => new Response("new-ais", { status: 200 })) as typeof fetch;
        await downloadAssetAtomic("ais-linux-x64", dest, { mode: 0o755, fetchImpl });
        expect(await Bun.file(dest).text()).toBe("new-ais");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
