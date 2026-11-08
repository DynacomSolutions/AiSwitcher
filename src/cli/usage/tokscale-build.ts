import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { aisCacheDir } from "../../shared/ais-home.ts";

/**
 * Which AIS-patched Tokscale is installed, and whether it is the one this
 * checkout builds.
 *
 * `scripts/build-tokscale-ais.sh` writes a stamp next to the binary it
 * installs (`<binary>.ais-build`): the pinned release, the SHA-256 of every
 * vendored patch in `vendor/tokscale/patches/series` order, the build helper's
 * own SHA-256, and the SHA-256 of the installed binary. A full install compares
 * the stamp with this checkout and rebuilds when it differs or is missing. The
 * collector's 5 MB/s disk cap is applied only when the stamp says the installed
 * binary checkpoints its message cache.
 */

export const TOKSCALE_BUILD_STAMP_SUFFIX = ".ais-build";
const STAMP_HEADER = "ais-tokscale-build v1";
/** The patch that makes a timed-out cold export continue on the next cycle. */
export const TOKSCALE_CHECKPOINT_PATCH = "v4.20.0-ais-checkpoint.patch";

export function defaultNativeTokscaleBinary(env: Record<string, string | undefined> = process.env): string {
  return env.AIS_TOKSCALE_SHARED_BIN || join(aisCacheDir(), "usage", "native-tokscale", "tokscale");
}

export function tokscaleBuildStampPath(binaryPath: string): string {
  return `${binaryPath}${TOKSCALE_BUILD_STAMP_SUFFIX}`;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The stamp lines (without the binary line) this checkout's build produces. */
export async function expectedTokscaleBuildManifest(repoRoot: string): Promise<string[]> {
  const script = await readFile(join(repoRoot, "scripts", "build-tokscale-ais.sh"));
  const scriptText = script.toString("utf8");
  const version = /archive\/refs\/tags\/(v[0-9.]+)\.tar\.gz/.exec(scriptText)?.[1];
  const sourceSha = /source_sha256="([0-9a-f]{64})"/.exec(scriptText)?.[1];
  if (!version || !sourceSha) throw new Error("build-tokscale-ais.sh does not pin a Tokscale release");
  const patchesDir = join(repoRoot, "vendor", "tokscale", "patches");
  const series = (await readFile(join(patchesDir, "series"), "utf8"))
    .split("\n").map((line) => line.trim()).filter(Boolean);
  if (series.length === 0) throw new Error("vendor/tokscale/patches/series lists no patches");
  const lines = [STAMP_HEADER, `source ${version} ${sourceSha}`];
  for (const name of series) {
    if (basename(name) !== name) throw new Error(`invalid patch name in series: ${name}`);
    lines.push(`patch ${name} ${sha256(await readFile(join(patchesDir, name)))}`);
  }
  lines.push(`build-script ${sha256(script)}`);
  return lines;
}

/** The stamp's build lines when the stamp exists and still describes the
 * installed binary byte for byte; undefined otherwise. */
export async function installedTokscaleBuild(binaryPath: string): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await readFile(tokscaleBuildStampPath(binaryPath), "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n").filter(Boolean);
  const binaryLine = lines.at(-1);
  const recorded = /^binary ([0-9a-f]{64})$/.exec(binaryLine ?? "")?.[1];
  if (lines[0] !== STAMP_HEADER || !recorded) return undefined;
  try {
    if ((await sha256File(binaryPath)) !== recorded) return undefined;
  } catch {
    return undefined;
  }
  return lines.slice(0, -1);
}

/** True when the installed binary is a stamped build that includes the
 * message-cache checkpoint patch. Needs no checkout, so `ais usage service
 * install` can use it too. */
export async function nativeTokscaleSupportsCheckpoints(binaryPath = defaultNativeTokscaleBinary()): Promise<boolean> {
  const build = await installedTokscaleBuild(binaryPath);
  return build?.some((line) => line.startsWith(`patch ${TOKSCALE_CHECKPOINT_PATCH} `)) ?? false;
}

/** Write the stamp for a binary the build helper just installed. `inputsRoot`
 * is the helper's snapshot of itself and the patch series, taken before the
 * build; `binarySha256` is the hash of the file it staged. Neither is read from
 * the live checkout or output, so neither can describe something else. The
 * helper removes the old stamp before replacing the binary. */
export async function writeTokscaleBuildStamp(inputsRoot: string, binaryPath: string, binarySha256?: string): Promise<void> {
  const lines = await expectedTokscaleBuildManifest(inputsRoot);
  lines.push(`binary ${binarySha256 ?? await sha256File(binaryPath)}`);
  const directory = await mkdtemp(join(dirname(binaryPath), ".ais-build-stamp-"));
  try {
    const staged = join(directory, "stamp");
    await writeFile(staged, `${lines.join("\n")}\n`, { mode: 0o644 });
    await rename(staged, tokscaleBuildStampPath(binaryPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export type NativeTokscaleResult =
  | { status: "current" }
  | { status: "rebuilt"; reason: "missing" | "outdated" }
  | { status: "failed"; reason: "missing" | "outdated"; error: string }
  /** This exact patch set already failed to build; not retried until it changes or is forced. */
  | { status: "skipped"; reason: "missing" | "outdated" };

/** Set to 1 to retry a build of a patch set that already failed. */
export const TOKSCALE_FORCE_REBUILD_ENV = "AIS_TOKSCALE_FORCE_REBUILD";

/** The record of the last failed build attempt for this binary. */
export function tokscaleFailedBuildPath(binaryPath: string): string {
  return `${binaryPath}.ais-build-failed`;
}

/** A failed patch set is retried after this long, or at once when the toolchain changes. */
export const TOKSCALE_FAILED_BUILD_BACKOFF_MS = 24 * 60 * 60_000;
/** A build that runs longer than this is killed (with its whole process group) and counts as failed. */
export const TOKSCALE_BUILD_TIMEOUT_MS = 90 * 60_000;
/** Exit code the helper runner reports for a build it killed on timeout. */
export const TOKSCALE_BUILD_TIMEOUT_EXIT = 124;

interface FailedBuildRecord {
  manifest: string;
  toolchain: string;
  failedAt: number;
}

async function readFailedBuild(path: string): Promise<FailedBuildRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<FailedBuildRecord>;
    if (typeof value.manifest !== "string" || typeof value.toolchain !== "string" || typeof value.failedAt !== "number") {
      return undefined;
    }
    return { manifest: value.manifest, toolchain: value.toolchain, failedAt: value.failedAt };
  } catch {
    return undefined;
  }
}

async function commandLine(command: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return code === 0 ? out.trim() : `${command[0]}: exit ${code}`;
  } catch {
    return `${command[0]}: unavailable`;
  }
}

/** The Rust channel the pinned Tokscale release builds with: its
 * rust-toolchain.toml, vendored as `vendor/tokscale/rust-toolchain.toml`
 * (the build helper checks the copy against the archive). */
export async function pinnedTokscaleToolchain(repoRoot: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(repoRoot, "vendor", "tokscale", "rust-toolchain.toml"), "utf8");
    return /^\s*channel\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

/** What the build depends on outside the checkout: a new Rust toolchain may
 * fix a build that failed with the old one. Probes the toolchain the build
 * really uses (rustup honours the archive's pin), not the default one. */
export async function tokscaleToolchainId(repoRoot?: string): Promise<string> {
  const channel = repoRoot ? await pinnedTokscaleToolchain(repoRoot) : undefined;
  const env: Record<string, string> = channel ? { RUSTUP_TOOLCHAIN: channel } : {};
  return `${channel ? `pin ${channel}; ` : ""}${await commandLine(["cargo", "--version"], env)}; ${await commandLine(["rustc", "-V"], env)}`;
}

export interface EnsureNativeTokscaleOptions {
  repoRoot: string;
  binaryPath?: string;
  /** Retry even when this patch set already failed (default: AIS_TOKSCALE_FORCE_REBUILD=1). */
  force?: boolean;
  /** Runs the build helper; resolves to its exit code. Test seam. */
  runBuild?: (repoRoot: string, binaryPath: string) => Promise<number>;
  /** Toolchain identity recorded with a failure. Test seam. */
  toolchainId?: () => Promise<string>;
  /** Clock for the failure backoff. Test seam. */
  now?: () => number;
}

/** Low CPU and IO priority: a cold build compiles Tokscale and runs its tests
 * on a host that is serving other work. The helper runs in its own process
 * group; past `timeoutMs` the whole group (cargo, rustc, curl) is killed and
 * the build reports TOKSCALE_BUILD_TIMEOUT_EXIT. */
export async function runTokscaleBuildHelper(
  repoRoot: string,
  binaryPath: string,
  options: { timeoutMs?: number; killGraceMs?: number } = {},
): Promise<number> {
  const command = ["bash", join(repoRoot, "scripts", "build-tokscale-ais.sh"), binaryPath];
  const setsid = Bun.which("setsid");
  const ionice = Bun.which("ionice");
  const nice = Bun.which("nice");
  const child = Bun.spawn([
    ...(setsid ? [setsid] : []),
    ...(nice ? [nice, "-n", "19"] : []),
    ...(ionice ? [ionice, "-c", "3"] : []),
    ...command,
  ], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(setsid ? -child.pid : child.pid, signal);
    } catch { /* already gone */ }
  };
  const killGraceMs = options.killGraceMs ?? 10_000;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  /** TERM the whole build group, then KILL it after the grace period. */
  const terminate = () => {
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs ?? TOKSCALE_BUILD_TIMEOUT_MS);
  // The build has its own process group, so a Ctrl-C or hangup of the installer
  // no longer reaches it. Forward it: stop the build the same way, then exit.
  const exitCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    terminate();
  };
  const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of forwarded) process.on(signal, onSignal);
  try {
    const code = await child.exited;
    if (interrupted) {
      // The group got TERM (and KILL after the grace period, which is what
      // ended a leader that ignored TERM); make sure nothing survives, then exit.
      signalGroup("SIGKILL");
      process.exit(exitCodes[interrupted] ?? 1);
    }
    if (timedOut) {
      // The leader may exit on SIGTERM while a child ignores it.
      signalGroup("SIGKILL");
      return TOKSCALE_BUILD_TIMEOUT_EXIT;
    }
    return code;
  } finally {
    for (const signal of forwarded) process.off(signal, onSignal);
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
}

/** Rebuild the installed AIS-patched Tokscale when its stamp is missing or
 * does not match this checkout. A failed build leaves the previous binary
 * (and its stamp) in place: the helper replaces the binary only after every
 * test step passed. */
export async function ensureNativeTokscale(options: EnsureNativeTokscaleOptions): Promise<NativeTokscaleResult> {
  const binaryPath = options.binaryPath ?? defaultNativeTokscaleBinary();
  const expected = (await expectedTokscaleBuildManifest(options.repoRoot)).join("\n");
  const installed = await installedTokscaleBuild(binaryPath);
  if (installed?.join("\n") === expected) return { status: "current" };
  const reason = installed ? "outdated" : "missing";
  const failedPath = tokscaleFailedBuildPath(binaryPath);
  const force = options.force ?? process.env[TOKSCALE_FORCE_REBUILD_ENV] === "1";
  const now = options.now ?? Date.now;
  const toolchain = await (options.toolchainId ?? (() => tokscaleToolchainId(options.repoRoot)))();
  // A cold build compiles Tokscale and runs its tests. One that failed for this
  // patch set and toolchain is not repeated on every install, only once a day:
  // a broken patch fails again, a full disk or a network outage may not.
  const previous = await readFailedBuild(failedPath);
  if (!force && previous && previous.manifest === expected && previous.toolchain === toolchain &&
    now() - previous.failedAt < TOKSCALE_FAILED_BUILD_BACKOFF_MS) {
    return { status: "skipped", reason };
  }
  const fail = async (error: string, record = true): Promise<NativeTokscaleResult> => {
    if (record) {
      const entry: FailedBuildRecord = { manifest: expected, toolchain, failedAt: now() };
      await writeFile(failedPath, `${JSON.stringify(entry)}\n`, { mode: 0o644 }).catch(() => {});
    }
    return { status: "failed", reason, error };
  };
  let code: number;
  try {
    code = await (options.runBuild ?? runTokscaleBuildHelper)(options.repoRoot, binaryPath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // Exit 2 is a missing tool or a bad argument, found before any build work:
  // retrying costs nothing, so it is not recorded.
  if (code === 2) return fail("build-tokscale-ais.sh exited with 2 (a required tool is missing)", false);
  if (code === TOKSCALE_BUILD_TIMEOUT_EXIT) {
    return fail(`build-tokscale-ais.sh timed out after ${TOKSCALE_BUILD_TIMEOUT_MS / 60_000} min and was killed`);
  }
  if (code !== 0) return fail(`build-tokscale-ais.sh exited with ${code}`);
  const rebuilt = await installedTokscaleBuild(binaryPath);
  if (rebuilt?.join("\n") !== expected) {
    return fail("the rebuilt Tokscale is not stamped with this checkout's patch set (did the checkout change during the build?)");
  }
  await rm(failedPath, { force: true });
  return { status: "rebuilt", reason };
}
