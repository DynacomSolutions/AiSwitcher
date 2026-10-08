import { execFile } from "node:child_process";
import { access, constants, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";

/** A memory file served from a git-base "base" checkout must never be edited
 * in place: the base is only ever advanced by `git-base land`, which applies
 * the change in an ephemeral worktree, commits, pushes and fast-forwards. */
export interface GitBaseTarget {
  bin: string;
  toplevel: string;
  org: string;
  repo: string;
  /** Memory file path relative to the base toplevel. */
  relpath: string;
}

export interface LandResult {
  /** 40-char commit SHA, or the literal "unchanged". */
  result: string;
}

const BASE_TOPLEVEL = /(?:^|\/)\.worktrees\/([^/]+)\/\.base\/([^/]+)$/;

/** Match `<anything>/.worktrees/<org>/.base/<repo>` exactly. */
export function parseBaseToplevel(toplevel: string): { org: string; repo: string } | null {
  const match = BASE_TOPLEVEL.exec(toplevel.replace(/\/+$/, ""));
  if (!match) return null;
  const [, org, repo] = match;
  if (!org || !repo || org === ".base" || repo === ".base") return null;
  return { org, repo };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findGitBaseBin(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const override = env.AIS_GIT_BASE_BIN;
  if (override) return (await isExecutable(override)) ? override : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "git-base");
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env: env as NodeJS.ProcessEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = typeof (error as NodeJS.ErrnoException).code === "number" ? ((error as unknown as { code: number }).code) : 127;
      resolve({ code, stdout, stderr: stderr || error.message });
    });
  });
}

/** Detect whether `memoryPath` lives in a git-base base checkout. Returns
 * null (=> write in place, as before) when landing is disabled via
 * AIS_MEMORY_LAND=0, there is no git-base executable, the file is not in a git
 * checkout, or the checkout is not a base. */
export async function detectGitBase(
  memoryPath: string,
  env: Record<string, string | undefined> = process.env,
): Promise<GitBaseTarget | null> {
  if (env.AIS_MEMORY_LAND === "0") return null;
  const bin = await findGitBaseBin(env);
  if (!bin) return null;
  let realFile: string;
  try {
    realFile = await realpath(memoryPath);
  } catch {
    try {
      realFile = join(await realpath(dirname(memoryPath)), basename(memoryPath));
    } catch {
      return null;
    }
  }
  const top = await run("git", ["-C", dirname(realFile), "rev-parse", "--show-toplevel"], env);
  if (top.code !== 0) return null;
  const toplevel = top.stdout.trim();
  const parsed = parseBaseToplevel(toplevel);
  if (!parsed) return null;
  const relpath = relative(toplevel, realFile);
  if (!relpath || relpath.startsWith("..")) return null;
  return { bin, toplevel, ...parsed, relpath };
}

/** Land `content` via `git-base land`: the whole new file (`file`) or only a
 * block to append (`append`, race-safe under concurrent writers).
 * Throws with git-base's stderr on any failure; never writes in place. */
export async function landMemory(
  target: GitBaseTarget,
  content: string,
  message: string,
  env: Record<string, string | undefined> = process.env,
  mode: "file" | "append" = "file",
): Promise<LandResult> {
  const dir = await mkdtemp(join(tmpdir(), "ais-memory-land-"));
  try {
    const temp = join(dir, "content");
    await writeFile(temp, content, { mode: 0o600 });
    const { org, repo, relpath } = target;
    const res = await run(
      target.bin,
      ["land", `${org}/${repo}`, "-m", message, mode === "append" ? "--append" : "--file", `${relpath}=${temp}`],
      env,
    );
    if (res.code !== 0) {
      throw new Error(`git-base land failed (exit ${res.code}): ${res.stderr.trim() || "no output"}`);
    }
    const last = res.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (last !== "unchanged" && !/^[0-9a-f]{40}$/.test(last)) {
      throw new Error(`git-base land returned an unexpected result: ${JSON.stringify(last)}`);
    }
    return { result: last };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `docs(memory): <summary>` from the first heading or line of added text. */
export function addCommitMessage(entry: string): string {
  const line = entry.split("\n").map((l) => l.replace(/^\s*#+\s*/, "").trim()).find((l) => l.length > 0) ?? "add entry";
  const summary = line.slice(0, 60).trimEnd();
  return `docs(memory): ${summary}`;
}
