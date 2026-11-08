import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUsageCollectorService, USAGE_COLLECTOR_SERVICE_NAME } from "../../../src/cli/usage/collector-service.ts";
import {
  ensureNativeTokscale,
  expectedTokscaleBuildManifest,
  installedTokscaleBuild,
  runTokscaleBuildHelper,
  tokscaleToolchainId,
  TOKSCALE_TOOLCHAIN_PROBE_TIMEOUT_MS,
  TOKSCALE_FAILED_BUILD_BACKOFF_MS,
  nativeTokscaleSupportsCheckpoints,
  TOKSCALE_CHECKPOINT_PATCH,
  tokscaleBuildStampPath,
  tokscaleFailedBuildPath,
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
  const thrown = await ensureNativeTokscale({ repoRoot, binaryPath, force: true, runBuild: async () => { throw new Error("cargo is required"); } });
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
  expect(helper).toContain('done 3< "$inputs/vendor/tokscale/patches/series"');
  expect(helper).toContain('apply_snapshot_patches "$inputs" "$source_dir"');
  expect(helper).toContain('install_built_binary "$target_dir/release/tokscale" "$output" "$inputs"');
  expect(helper).toContain('sweep_stale_build_dirs "$build_base"');
  expect(helper).toContain('check_toolchain_pin "$repo_root" "$source_dir"');
});

// ---- Review follow-ups: R1 (stale manifest), R2 (concurrent builds), R3 (failed builds retried) ----

const REAL_HELPER = join(import.meta.dir, "..", "..", "..", "scripts", "build-tokscale-ais.sh");
const BUN_DIR = join(process.execPath, "..");

/** A checkout carrying the real build helper, so its functions run against this fixture. */
async function helperFixture(series: string[]) {
  const f = await fixture(series);
  await copyFile(REAL_HELPER, join(f.repoRoot, "scripts", "build-tokscale-ais.sh"));
  return f;
}

/** Source the real helper (defines its functions, builds nothing) and run `body`. */
async function helperShell(body: string, env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(["bash", "-c", `set -euo pipefail; source "$HELPER"; ${body}`], {
    env: { ...process.env, PATH: `${BUN_DIR}:${process.env.PATH ?? ""}`, HELPER: REAL_HELPER, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("R1: a commit that lands during a build is never recorded against the binary it did not build", async () => {
  const { root, repoRoot, binaryPath } = await helperFixture(OLD_SERIES);
  await writeFile(binaryPath, "tokscale from before stamps", { mode: 0o755 });
  const built = join(root, "built-from-old-series");
  await writeFile(built, "tokscale built without checkpoints");

  // The build snapshots its inputs, the checkpoint patch is merged while cargo
  // runs, then the build installs what it compiled from the old series.
  const midBuildCommit = async (checkout: string, output: string) => {
    const inputs = join(root, `inputs-${Math.random().toString(16).slice(2)}`);
    const run = await helperShell(
      `snapshot_build_inputs "$CHECKOUT" "$INPUTS"; "$COMMIT"; install_built_binary "$BUILT" "$OUTPUT" "$INPUTS"`,
      { CHECKOUT: checkout, INPUTS: inputs, BUILT: built, OUTPUT: output, COMMIT: join(root, "commit.sh") },
    );
    expect(run.stderr).toBe("");
    return run.code;
  };
  // The "commit": the series gains the checkpoint patch.
  await writeFile(join(root, "commit.sh"), `#!/bin/sh\nprintf 'patch body of ${TOKSCALE_CHECKPOINT_PATCH}\\n' > "${repoRoot}/vendor/tokscale/patches/${TOKSCALE_CHECKPOINT_PATCH}"\nprintf '%s\\n' ${NEW_SERIES.join(" ")} > "${repoRoot}/vendor/tokscale/patches/series"\n`, { mode: 0o755 });

  // This install read the old series before building, and that is what got built.
  const result = await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: midBuildCommit });
  expect(result).toEqual({ status: "rebuilt", reason: "missing" });
  expect(await readFile(binaryPath, "utf8")).toBe("tokscale built without checkpoints");
  // The stamp tells the truth: built from the old series, so no checkpoints and no 5M.
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(false);
  const stamp = await readFile(tokscaleBuildStampPath(binaryPath), "utf8");
  expect(stamp).not.toContain(TOKSCALE_CHECKPOINT_PATCH);
  expect(await collectorCap(root, binaryPath)).toBe("20M");
  // And the next install does not take it for current: it rebuilds for the new series.
  const calls: string[] = [];
  expect(await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: fakeHelper(calls) })).toEqual({ status: "rebuilt", reason: "outdated" });
  expect(calls).toHaveLength(1);
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(true);
}, 30_000);

test("R2: a stamp records the hash of the binary its build staged, not whatever is installed later", async () => {
  const { root, repoRoot, binaryPath } = await fixture(NEW_SERIES);
  // Build B (with checkpoints) staged these bytes, but a concurrent build A
  // without checkpoints replaced the output before B wrote its stamp.
  await writeFile(binaryPath, "binary from build A, no checkpoints");
  await writeTokscaleBuildStamp(repoRoot, binaryPath, sha256Hex("binary from build B, with checkpoints"));
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(false);
  expect(await collectorCap(root, binaryPath)).toBe("20M");
});

test("R2: the helper stamps the staged hash and holds the output lock across replace and stamp", async () => {
  const { root, repoRoot, binaryPath } = await helperFixture(NEW_SERIES);
  const inputs = join(root, "inputs");
  const built = join(root, "built");
  await writeFile(binaryPath, "previous tokscale", { mode: 0o755 });
  await writeFile(built, "new tokscale with checkpoints");
  expect((await helperShell(`snapshot_build_inputs "$CHECKOUT" "$INPUTS"`, { CHECKOUT: repoRoot, INPUTS: inputs })).code).toBe(0);

  // Another build holds the lock: this one must not replace the binary until it is released.
  const holder = Bun.spawn(["flock", `${binaryPath}.lock`, "sleep", "1.5"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(200);
  const install = helperShell(`install_built_binary "$BUILT" "$OUTPUT" "$INPUTS"`, { BUILT: built, OUTPUT: binaryPath, INPUTS: inputs });
  await Bun.sleep(700);
  expect(await readFile(binaryPath, "utf8")).toBe("previous tokscale");
  await holder.exited;
  expect((await install).code).toBe(0);
  expect(await readFile(binaryPath, "utf8")).toBe("new tokscale with checkpoints");
  expect(await readFile(tokscaleBuildStampPath(binaryPath), "utf8")).toContain(`binary ${sha256Hex("new tokscale with checkpoints")}`);
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(true);
}, 30_000);

test("R2: concurrent builds of different patch sets never leave a stamp that claims the other's checkpoints", async () => {
  const { root, repoRoot, binaryPath } = await helperFixture(OLD_SERIES);
  const oldInputs = join(root, "inputs-old");
  const newInputs = join(root, "inputs-new");
  expect((await helperShell(`snapshot_build_inputs "$CHECKOUT" "$INPUTS"`, { CHECKOUT: repoRoot, INPUTS: oldInputs })).code).toBe(0);
  await setSeries(repoRoot, NEW_SERIES);
  expect((await helperShell(`snapshot_build_inputs "$CHECKOUT" "$INPUTS"`, { CHECKOUT: repoRoot, INPUTS: newInputs })).code).toBe(0);
  await writeFile(join(root, "built-old"), "tokscale without checkpoints");
  await writeFile(join(root, "built-new"), "tokscale with checkpoints");

  for (let round = 0; round < 6; round++) {
    const runs = await Promise.all([
      helperShell(`install_built_binary "$BUILT" "$OUTPUT" "$INPUTS"`, { BUILT: join(root, "built-old"), OUTPUT: binaryPath, INPUTS: oldInputs }),
      helperShell(`install_built_binary "$BUILT" "$OUTPUT" "$INPUTS"`, { BUILT: join(root, "built-new"), OUTPUT: binaryPath, INPUTS: newInputs }),
    ]);
    expect(runs.map((run) => run.code)).toEqual([0, 0]);
    const installed = await readFile(binaryPath, "utf8");
    // Serialised: the stamp always describes the binary that won, whichever it was.
    expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(installed === "tokscale with checkpoints");
    expect(await installedTokscaleBuild(binaryPath)).toBeDefined();
  }
}, 30_000);

test("R3: a patch set whose build failed is not rebuilt on every install, until it changes or is forced", async () => {
  const { repoRoot, binaryPath } = await fixture(OLD_SERIES);
  await fakeHelper([], "tokscale without checkpoints")(repoRoot, binaryPath);
  await setSeries(repoRoot, NEW_SERIES);

  let builds = 0;
  const failing = async () => { builds++; return 1; };
  expect((await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: failing })).status).toBe("failed");
  expect(builds).toBe(1);
  expect(await readFile(tokscaleFailedBuildPath(binaryPath), "utf8")).toContain(TOKSCALE_CHECKPOINT_PATCH);

  // Same patch set: skipped, the build is not started again.
  expect(await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: failing })).toEqual({ status: "skipped", reason: "outdated" });
  expect(builds).toBe(1);

  // Forced (or AIS_TOKSCALE_FORCE_REBUILD=1): retried.
  expect((await ensureNativeTokscale({ repoRoot, binaryPath, force: true, runBuild: failing })).status).toBe("failed");
  expect(builds).toBe(2);
  const previous = process.env.AIS_TOKSCALE_FORCE_REBUILD;
  process.env.AIS_TOKSCALE_FORCE_REBUILD = "1";
  try {
    expect((await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: failing })).status).toBe("failed");
  } finally {
    if (previous === undefined) delete process.env.AIS_TOKSCALE_FORCE_REBUILD;
    else process.env.AIS_TOKSCALE_FORCE_REBUILD = previous;
  }
  expect(builds).toBe(3);

  // A changed patch set is a new attempt; a success clears the failure record.
  await writeFile(join(repoRoot, "vendor", "tokscale", "patches", TOKSCALE_CHECKPOINT_PATCH), "fixed patch body\n");
  const calls: string[] = [];
  expect((await ensureNativeTokscale({ repoRoot, binaryPath, runBuild: fakeHelper(calls) })).status).toBe("rebuilt");
  expect(calls).toHaveLength(1);
  expect(await Bun.file(tokscaleFailedBuildPath(binaryPath)).exists()).toBe(false);
});

// ---- Third review: transient failures back off; stalled builds, downloads and locks give up ----

test("a failed build is retried after the 24 h backoff, or at once when the toolchain changes", async () => {
  const { repoRoot, binaryPath } = await fixture(OLD_SERIES);
  await fakeHelper([], "tokscale without checkpoints")(repoRoot, binaryPath);
  await setSeries(repoRoot, NEW_SERIES);
  let clock = Date.parse("2026-11-08T00:00:00Z");
  let toolchain = "cargo 1.99.0; rustc 1.99.0";
  const base = { repoRoot, binaryPath, now: () => clock, toolchainId: async () => toolchain };

  // A transient failure (a download error, an OOM kill, a full disk).
  expect((await ensureNativeTokscale({ ...base, runBuild: async () => 6 })).status).toBe("failed");
  const record = JSON.parse(await readFile(tokscaleFailedBuildPath(binaryPath), "utf8"));
  expect(record).toMatchObject({ toolchain, failedAt: clock });

  let attempts = 0;
  const working = async (root: string, path: string) => { attempts++; return fakeHelper([])(root, path); };
  clock += TOKSCALE_FAILED_BUILD_BACKOFF_MS - 60_000;
  expect((await ensureNativeTokscale({ ...base, runBuild: working })).status).toBe("skipped");
  expect(attempts).toBe(0);

  // Past the backoff the same patch set and toolchain are tried again, and the build now works.
  clock += 2 * 60_000;
  expect(await ensureNativeTokscale({ ...base, runBuild: working })).toEqual({ status: "rebuilt", reason: "outdated" });
  expect(attempts).toBe(1);
  expect(await nativeTokscaleSupportsCheckpoints(binaryPath)).toBe(true);

  // A new toolchain retries at once, inside the backoff.
  await setSeries(repoRoot, [...NEW_SERIES, "v4.20.0-ais-later.patch"]);
  expect((await ensureNativeTokscale({ ...base, runBuild: async () => 6 })).status).toBe("failed");
  expect((await ensureNativeTokscale({ ...base, runBuild: working })).status).toBe("skipped");
  toolchain = "cargo 1.100.0; rustc 1.100.0";
  expect((await ensureNativeTokscale({ ...base, runBuild: working })).status).toBe("rebuilt");
  expect(attempts).toBe(2);
});

test("a missing tool (exit 2) is not recorded, so the next install tries again", async () => {
  const { repoRoot, binaryPath } = await fixture();
  await writeFile(binaryPath, "old", { mode: 0o755 });
  const base = { repoRoot, binaryPath, toolchainId: async () => "cargo: unavailable; rustc: unavailable" };
  expect((await ensureNativeTokscale({ ...base, runBuild: async () => 2 })).status).toBe("failed");
  expect(await Bun.file(tokscaleFailedBuildPath(binaryPath)).exists()).toBe(false);
  const calls: string[] = [];
  expect((await ensureNativeTokscale({ ...base, runBuild: fakeHelper(calls) })).status).toBe("rebuilt");
  expect(calls).toHaveLength(1);
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a build that outlives its timeout is killed with its whole process group", async () => {
  const { root, repoRoot, binaryPath } = await fixture();
  const pidFile = join(root, "grandchild.pid");
  const wedgedRepo = join(root, "wedged");
  await mkdir(join(wedgedRepo, "scripts"), { recursive: true });
  // Stands in for a wedged cargo or curl: a child of the helper that never ends.
  await writeFile(join(wedgedRepo, "scripts", "build-tokscale-ais.sh"),
    `sleep 300 & echo $! > "${pidFile}"\nwait\n`);
  const started = Date.now();
  const code = await runTokscaleBuildHelper(wedgedRepo, binaryPath, { timeoutMs: 500, killGraceMs: 500 });
  expect(code).toBe(124);
  expect(Date.now() - started).toBeLessThan(10_000);
  const grandchild = Number(await readFile(pidFile, "utf8"));
  await Bun.sleep(200);
  expect(alive(grandchild)).toBe(false);

  // ensureNativeTokscale counts it as a failed (recorded) build.
  const result = await ensureNativeTokscale({ repoRoot, binaryPath, toolchainId: async () => "t", runBuild: async () => 124 });
  expect(result).toMatchObject({ status: "failed" });
  expect(result.status === "failed" && result.error).toContain("timed out");
}, 20_000);

test("a stalled download fails after the transfer limit instead of hanging the install", async () => {
  // Accepts the connection and never answers.
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const { root } = await fixture();
    const started = Date.now();
    const run = await helperShell(
      `source_url="http://127.0.0.1:${server.port}/tokscale.tar.gz"; download_source "$ARCHIVE"`,
      { ARCHIVE: join(root, "archive.tgz"), AIS_TOKSCALE_DOWNLOAD_MAX_SECS: "2" },
    );
    expect(run.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("an install gives up on a lock a frozen build never releases", async () => {
  const { root, repoRoot, binaryPath } = await helperFixture(NEW_SERIES);
  const inputs = join(root, "inputs");
  const built = join(root, "built");
  await writeFile(binaryPath, "previous tokscale", { mode: 0o755 });
  await writeFile(built, "new tokscale");
  expect((await helperShell(`snapshot_build_inputs "$CHECKOUT" "$INPUTS"`, { CHECKOUT: repoRoot, INPUTS: inputs })).code).toBe(0);
  const holder = Bun.spawn(["flock", `${binaryPath}.lock`, "sleep", "8"], { stdout: "ignore", stderr: "ignore" });
  try {
    await Bun.sleep(200);
    const started = Date.now();
    const run = await helperShell(`install_built_binary "$BUILT" "$OUTPUT" "$INPUTS"`,
      { BUILT: built, OUTPUT: binaryPath, INPUTS: inputs, AIS_TOKSCALE_LOCK_WAIT_SECS: "1" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("timed out waiting for");
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(await readFile(binaryPath, "utf8")).toBe("previous tokscale");
    const leftovers = (await Array.fromAsync(new Bun.Glob("tokscale.ais-new-*").scan(join(binaryPath, "..")))).length;
    expect(leftovers).toBe(0);
  } finally {
    holder.kill();
    await holder.exited;
  }
}, 20_000);

// ---- Final review: Ctrl-C reaches the build, stale scratch trees, pinned toolchain ----

const BUILD_MODULE = join(import.meta.dir, "..", "..", "..", "src", "cli", "usage", "tokscale-build.ts");

test("Ctrl-C to the installer stops the whole build process group, then the installer exits", async () => {
  const { root, binaryPath } = await fixture();
  const pidFile = join(root, "grandchild.pid");
  const wedgedRepo = join(root, "wedged");
  await mkdir(join(wedgedRepo, "scripts"), { recursive: true });
  await writeFile(join(wedgedRepo, "scripts", "build-tokscale-ais.sh"),
    `sleep 300 & echo $! > "${pidFile}"\nwait\n`);
  const installer = join(root, "installer.ts");
  await writeFile(installer, `import { runTokscaleBuildHelper } from ${JSON.stringify(BUILD_MODULE)};
await runTokscaleBuildHelper(${JSON.stringify(wedgedRepo)}, ${JSON.stringify(binaryPath)}, { timeoutMs: 120_000, killGraceMs: 500 });
console.log("build returned");
`);
  const child = Bun.spawn([process.execPath, installer], { stdout: "pipe", stderr: "pipe" });
  try {
    for (let i = 0; i < 100 && !(await Bun.file(pidFile).exists()); i++) await Bun.sleep(50);
    const grandchild = Number(await readFile(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);

    child.kill("SIGINT");
    const started = Date.now();
    const code = await child.exited;
    expect(code).toBe(130);
    expect(Date.now() - started).toBeLessThan(5_000);
    await Bun.sleep(200);
    expect(alive(grandchild)).toBe(false);
    expect(await new Response(child.stdout).text()).not.toContain("build returned");
  } finally {
    child.kill("SIGKILL");
  }
}, 30_000);

test("a build removes scratch trees left by killed builds, and only theirs", async () => {
  const { root } = await fixture();
  const base = join(root, "build-base");
  const finished = Bun.spawn(["true"]);
  await finished.exited;
  const dead = join(base, `tokscale-v4.20.0-${finished.pid}`);
  const live = join(base, `tokscale-v4.20.0-${process.pid}`);
  const other = join(base, "tokscale-notes");
  const odd = join(base, "tokscale-v4.20.0-abc");
  for (const dir of [dead, live, other, odd]) await mkdir(join(dir, "source"), { recursive: true });

  const run = await helperShell(`sweep_stale_build_dirs "$BASE"`, { BASE: base });
  expect(run.code).toBe(0);
  const remaining = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: base, onlyFiles: false }))).sort();
  expect(remaining).toEqual([`tokscale-v4.20.0-${process.pid}`, "tokscale-notes", "tokscale-v4.20.0-abc"].sort());
}, 30_000);

test("the toolchain id probes the Rust channel the pinned release builds with", async () => {
  const { root } = await fixture();
  const bin = join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  for (const tool of ["cargo", "rustc"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\necho "${tool} \${RUSTUP_TOOLCHAIN:-default}"\n`, { mode: 0o755 });
  }
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try {
    const id = await tokscaleToolchainId(repoRoot);
    expect(id).toContain("cargo 1.98.0");
    expect(id).toContain("rustc 1.98.0");
    expect(id).not.toContain("default");
  } finally {
    process.env.PATH = previous;
  }

  // The helper refuses an archive whose pin differs from the vendored copy.
  const archiveDir = join(root, "archive");
  await mkdir(archiveDir, { recursive: true });
  await copyFile(join(repoRoot, "vendor", "tokscale", "rust-toolchain.toml"), join(archiveDir, "rust-toolchain.toml"));
  expect((await helperShell(`check_toolchain_pin "$CHECKOUT" "$SRC"`, { CHECKOUT: repoRoot, SRC: archiveDir })).code).toBe(0);
  await writeFile(join(archiveDir, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.99.0"\n');
  expect((await helperShell(`check_toolchain_pin "$CHECKOUT" "$SRC" >/dev/null`, { CHECKOUT: repoRoot, SRC: archiveDir })).code).not.toBe(0);
});

// ---- Final re-check: concurrent sweeps, cross-namespace builds, bounded toolchain probe ----

async function deadPid(): Promise<number> {
  const finished = Bun.spawn(["true"]);
  await finished.exited;
  return finished.pid;
}

async function listing(dir: string): Promise<string[]> {
  return (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false, dot: true }))).sort();
}

test("two builds sweeping the same dead tree both carry on", async () => {
  const { root } = await fixture();
  const base = join(root, "build-base");
  for (let round = 0; round < 5; round++) {
    const tree = join(base, `tokscale-v4.20.0-${await deadPid()}`);
    for (let i = 0; i < 50; i++) await mkdir(join(tree, "source", `d${i}`), { recursive: true });
    const runs = await Promise.all([1, 2, 3].map(() => helperShell(`sweep_stale_build_dirs "$BASE"`, { BASE: base })));
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0]);
    expect(await listing(base)).toEqual([]);
  }
}, 30_000);

test("a tree whose build holds its lock is kept even when its pid is not visible here", async () => {
  const { root } = await fixture();
  const base = join(root, "build-base");
  // A build in another pid namespace: its pid means nothing here, its lock does.
  const foreign = join(base, `tokscale-v4.20.0-${await deadPid()}`);
  await mkdir(join(foreign, "source"), { recursive: true });
  await writeFile(join(foreign, ".lock"), "");
  // A finished build whose pid happens to be a live process here: its lock is free.
  const finished = join(base, `tokscale-v4.20.0-${process.pid}`);
  await mkdir(join(finished, "source"), { recursive: true });
  await writeFile(join(finished, ".lock"), "");

  // (flock's child keeps the lock until it exits, so let it finish rather than kill flock.)
  const holder = Bun.spawn(["flock", join(foreign, ".lock"), "sleep", "1.5"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(200);
  expect((await helperShell(`sweep_stale_build_dirs "$BASE"`, { BASE: base })).code).toBe(0);
  expect(await listing(base)).toEqual([foreign.split("/").pop()!]);
  await holder.exited;
  expect((await helperShell(`sweep_stale_build_dirs "$BASE"`, { BASE: base })).code).toBe(0);
  expect(await listing(base)).toEqual([]);
}, 30_000);

test("a dead tree named after this build's own pid is swept, and the build's tree is created locked", async () => {
  const { root } = await fixture();
  const base = join(root, "build-base");
  await mkdir(base, { recursive: true });
  const run = await helperShell(`
    mkdir -p "$BASE/tokscale-v4.20.0-$$/source"
    sweep_stale_build_dirs "$BASE"
    create_build_root "$BASE"
    [[ "$build_root" == "$BASE/tokscale-v4.20.0-$$" && -d "$build_root" && ! -e "$build_root/source" ]]
    if flock -n "$build_root/.lock" true; then echo unlocked; else echo locked; fi
    ls -A "$BASE"
  `, { BASE: base });
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
});

test("create_build_root leaves its tree locked for the build's life and no pending tree behind", async () => {
  const { root } = await fixture();
  const base = join(root, "build-base");
  await mkdir(base, { recursive: true });
  const child = Bun.spawn(["bash", "-c", `set -euo pipefail; source "$HELPER"; create_build_root "$BASE"; echo "$build_root"; sleep 3`], {
    env: { ...process.env, PATH: `${BUN_DIR}:${process.env.PATH ?? ""}`, HELPER: REAL_HELPER, BASE: base },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    const tree = new TextDecoder().decode(value).trim();
    expect(await listing(base)).toEqual([tree.split("/").pop()!]);
    // While the build lives, a sweep (even one that cannot see its pid) leaves it alone.
    const probe = Bun.spawn(["flock", "-n", join(tree, ".lock"), "true"]);
    expect(await probe.exited).not.toBe(0);
    expect((await helperShell(`sweep_stale_build_dirs "$BASE"`, { BASE: base })).code).toBe(0);
    expect(await listing(base)).toEqual([tree.split("/").pop()!]);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}, 30_000);

test("the toolchain probe never auto-installs and gives up on a wedged rustup", async () => {
  expect(TOKSCALE_TOOLCHAIN_PROBE_TIMEOUT_MS).toBe(30_000);
  const { root } = await fixture();
  const bin = join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "cargo"), `#!/bin/sh\necho "cargo auto-install=\${RUSTUP_AUTO_INSTALL:-unset}"\n`, { mode: 0o755 });
  // A rustup proxy stuck downloading the pinned toolchain.
  await writeFile(join(bin, "rustc"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try {
    const started = Date.now();
    const id = await tokscaleToolchainId(repoRoot, { timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(id).toContain("cargo auto-install=0");
    expect(id).toContain("rustc: timed out");
  } finally {
    process.env.PATH = previous;
  }
}, 30_000);

test("a pin mismatch explains why the pins must match", async () => {
  const { root } = await fixture();
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const archiveDir = join(root, "archive");
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.99.0"\n');
  const run = await helperShell(`check_toolchain_pin "$CHECKOUT" "$SRC" >/dev/null`, { CHECKOUT: repoRoot, SRC: archiveDir });
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("must name the toolchain the build uses");
});
