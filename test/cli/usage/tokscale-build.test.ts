import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUsageCollectorService, USAGE_COLLECTOR_SERVICE_NAME } from "../../../src/cli/usage/collector-service.ts";
import {
  ensureNativeTokscale,
  expectedTokscaleBuildManifest,
  nativeTokscaleSupportsCheckpoints,
  TOKSCALE_CHECKPOINT_PATCH,
  tokscaleBuildStampPath,
  writeTokscaleBuildStamp,
} from "../../../src/cli/usage/tokscale-build.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const OLD_SERIES = ["v4.20.0-ais.patch"];
const NEW_SERIES = ["v4.20.0-ais.patch", TOKSCALE_CHECKPOINT_PATCH];

/** A checkout with the build helper's pins and a patch series, and an
 * installed binary next to where the collector expects it. */
async function fixture(series = NEW_SERIES) {
  const root = await mkdtemp(join(tmpdir(), "ais-tokscale-build-test-"));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await mkdir(join(repoRoot, "vendor", "tokscale", "patches"), { recursive: true });
  await writeFile(join(repoRoot, "scripts", "build-tokscale-ais.sh"), [
    'source_url="https://github.com/junhoyeo/tokscale/archive/refs/tags/v4.20.0.tar.gz"',
    `source_sha256="${"7".repeat(64)}"`,
    "",
  ].join("\n"));
  await setSeries(repoRoot, series);
  const binaryPath = join(root, "native-tokscale", "tokscale");
  await mkdir(join(root, "native-tokscale"), { recursive: true });
  return { root, repoRoot, binaryPath };
}

async function setSeries(repoRoot: string, series: string[]) {
  const dir = join(repoRoot, "vendor", "tokscale", "patches");
  for (const name of series) await writeFile(join(dir, name), `patch body of ${name}\n`);
  await writeFile(join(dir, "series"), `${series.join("\n")}\n`);
}

/** Stands in for build-tokscale-ais.sh: replace the binary, then stamp it. */
function fakeHelper(calls: string[], binaryBytes = "new tokscale") {
  return async (repoRoot: string, binaryPath: string) => {
    calls.push(binaryPath);
    await rm(tokscaleBuildStampPath(binaryPath), { force: true });
    await writeFile(binaryPath, binaryBytes, { mode: 0o755 });
    await writeTokscaleBuildStamp(repoRoot, binaryPath);
    return 0;
  };
}

async function collectorCap(root: string, binaryPath: string): Promise<string> {
  const unitDirectory = join(root, "systemd", "user");
  const result = await installUsageCollectorService({
    unitDirectory,
    platform: "linux",
    checkpointSupport: () => nativeTokscaleSupportsCheckpoints(binaryPath),
    checkEntrypoint: async () => true,
    reloadAndVerify: async () => {},
    enableStartAndVerify: async () => {},
  });
  const unit = await readFile(join(unitDirectory, USAGE_COLLECTOR_SERVICE_NAME), "utf8");
  expect(unit).toContain(`IOReadBandwidthMax=%h ${result.ioCap}`);
  return result.ioCap;
}

test("a binary without a build stamp is rebuilt, and the collector then gets the 5M cap", async () => {
  const { root, repoRoot, binaryPath } = await fixture();
  await writeFile(binaryPath, "tokscale from before stamps", { mode: 0o755 });
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(false);
  expect(await collectorCap(root, binaryPath)).toBe("20M");

  const calls: string[] = [];
  expect(await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: fakeHelper(calls) }))
    .toEqual({ status: "rebuilt", reason: "missing" });
  expect(calls).toEqual([binaryPath]);
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(true);
  expect(await collectorCap(root, binaryPath)).toBe("5M");
});

test("a binary whose stamp matches the checkout is not rebuilt", async () => {
  const { repoRoot, binaryPath } = await fixture();
  const calls: string[] = [];
  await fakeHelper(calls)(repoRoot, binaryPath);
  calls.length = 0;
  expect(await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: fakeHelper(calls) })).toEqual({ status: "current" });
  expect(calls).toEqual([]);
});

test("a changed patch set, or a binary replaced behind its stamp, triggers a rebuild", async () => {
  const { repoRoot, binaryPath } = await fixture(OLD_SERIES);
  const calls: string[] = [];
  await fakeHelper(calls)(repoRoot, binaryPath);
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(false);

  await setSeries(repoRoot, NEW_SERIES);
  calls.length = 0;
  expect(await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: fakeHelper(calls) }))
    .toEqual({ status: "rebuilt", reason: "outdated" });
  expect(calls).toHaveLength(1);

  // Someone copies another binary over the stamped one: the stamp no longer describes it.
  await writeFile(binaryPath, "hand-copied tokscale");
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(false);
  calls.length = 0;
  expect(await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: fakeHelper(calls) }))
    .toEqual({ status: "rebuilt", reason: "missing" });
  expect(calls).toHaveLength(1);
});

test("a failed build keeps the previous binary and the 20M cap", async () => {
  const { root, repoRoot, binaryPath } = await fixture(OLD_SERIES);
  await fakeHelper([], "working tokscale without checkpoints")(repoRoot, binaryPath);
  const previousStamp = await readFile(tokscaleBuildStampPath(binaryPath), "utf8");
  await setSeries(repoRoot, NEW_SERIES);

  // Like the helper when a test step or cargo fails: exit non-zero before touching the output.
  const result = await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: async () => 101 });
  expect(result).toEqual({ status: "failed", reason: "outdated", error: "build-tokscale-ais.sh exited with 101" });
  expect(await readFile(binaryPath, "utf8")).toBe("working tokscale without checkpoints");
  expect(await readFile(tokscaleBuildStampPath(binaryPath), "utf8")).toBe(previousStamp);
  expect(await collectorCap(root, binaryPath)).toBe("20M");

  // A helper that cannot even start is reported the same way.
  const thrown = await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: async () => { throw new Error("cargo is required"); } });
  expect(thrown).toEqual({ status: "failed", reason: "outdated", error: "cargo is required" });
  expect(await collectorCap(root, binaryPath)).toBe("20M");
});

test("a build that exits 0 without a matching stamp is a failure, not a 5M host", async () => {
  const { root, repoRoot, binaryPath } = await fixture();
  await writeFile(binaryPath, "old", { mode: 0o755 });
  const result = await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: async () => 0 });
  expect(result.status).toBe("failed");
  expect(await collectorCap(root, binaryPath)).toBe("20M");
});

test("this checkout's build stamp lists every series patch, including the checkpoint patch", async () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const manifest = await expectedTokscaleBuildManifest(repoRoot);
  const series = (await readFile(join(repoRoot, "vendor", "tokscale", "patches", "series"), "utf8")).split("\n").filter(Boolean);
  expect(manifest.filter((line) => line.startsWith("patch ")).map((line) => line.split(" ")[1])).toEqual(series);
  expect(series).toContain(TOKSCALE_CHECKPOINT_PATCH);
  expect(manifest[1]).toMatch(/^source v4\.20\.0 [0-9a-f]{64}$/);
  const helper = await readFile(join(repoRoot, "scripts", "build-tokscale-ais.sh"), "utf8");
  expect(helper).toContain('done 3< "$repo_root/vendor/tokscale/patches/series"');
  expect(helper).toContain('bun "$repo_root/scripts/tokscale-stamp.ts" "$repo_root" "$output"');
});
