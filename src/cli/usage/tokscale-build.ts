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

/** Write the stamp for a binary the build helper just installed. The helper
 * removes the old stamp before replacing the binary, so a stamp never
 * outlives the binary it describes. */
export async function writeTokscaleBuildStamp(repoRoot: string, binaryPath: string): Promise<void> {
  const lines = await expectedTokscaleBuildManifest(repoRoot);
  lines.push(`binary ${await sha256File(binaryPath)}`);
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
  | { status: "failed"; reason: "missing" | "outdated"; error: string };

export interface EnsureNativeTokscaleOptions {
  repoRoot: string;
  binaryPath?: string;
  /** Runs the build helper; resolves to its exit code. Test seam. */
  runBuild?: (repoRoot: string, binaryPath: string) => Promise<number>;
}

/** Low CPU and IO priority: a cold build compiles Tokscale and runs its tests
 * on a host that is serving other work. */
export async function runTokscaleBuildHelper(repoRoot: string, binaryPath: string): Promise<number> {
  const command = ["bash", join(repoRoot, "scripts", "build-tokscale-ais.sh"), binaryPath];
  const ionice = Bun.which("ionice");
  const nice = Bun.which("nice");
  const child = Bun.spawn([...(nice ? [nice, "-n", "19"] : []), ...(ionice ? [ionice, "-c", "3"] : []), ...command], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
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
  let code: number;
  try {
    code = await (options.runBuild ?? runTokscaleBuildHelper)(options.repoRoot, binaryPath);
  } catch (error) {
    return { status: "failed", reason, error: error instanceof Error ? error.message : String(error) };
  }
  if (code !== 0) return { status: "failed", reason, error: `build-tokscale-ais.sh exited with ${code}` };
  const rebuilt = await installedTokscaleBuild(binaryPath);
  if (rebuilt?.join("\n") !== expected) {
    return { status: "failed", reason, error: "the rebuilt Tokscale has no matching build stamp" };
  }
  return { status: "rebuilt", reason };
}
