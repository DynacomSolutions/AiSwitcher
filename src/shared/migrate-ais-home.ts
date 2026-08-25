import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { aisConfigDir, aisNpmDir, aisRemoteCacheDir } from "./ais-home.ts";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function lsofHasOpenOwner(dir: string): Promise<boolean | undefined> {
  const lsof =
    Bun.which("lsof") ?? (process.platform === "darwin" && existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
  if (!lsof) return undefined;
  const proc = Bun.spawn([lsof, "+D", dir], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (stdout.trim()) return true;
  if (exitCode === 0 || exitCode === 1) return false;
  return undefined;
}

async function procfsHasOpenOwner(dir: string): Promise<boolean | undefined> {
  if (process.platform !== "linux") return undefined;
  let processDirs: string[];
  try {
    processDirs = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  for (const pid of processDirs) {
    const fdDir = join("/proc", pid, "fd");
    let fds: string[];
    try {
      fds = await readdir(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = (await readlink(join(fdDir, fd))).replace(/ \(deleted\)$/, "");
        if (target === dir || target.startsWith(prefix)) return true;
      } catch {
        // Processes and file descriptors can disappear while /proc is read.
      }
    }
  }
  return false;
}

/**
 * Does ANY process currently have an open file handle somewhere under `dir`?
 * Same lsof-then-procfs shape as codex-backfill.ts's own liveness check, but
 * scanning a whole directory tree (`lsof +D`) rather than a fixed list of
 * known database paths — there's no equivalent lock-file convention for an
 * in-flight `npm install --prefix ...` the way sync.lock exists for SSH sync.
 *
 * Unlike codex-backfill.ts, "cannot verify" (neither lsof nor /proc
 * available) means PROCEED rather than defer: an interrupted npm install
 * self-heals on the next `ais upgrade` (npm's own --global install is
 * idempotent/resumable), whereas a wrongly-repaired Codex backfill lease
 * risks silent data loss — the stakes here don't justify blocking this
 * migration forever on a machine with neither tool available.
 */
async function hasLiveOpenOwner(dir: string): Promise<boolean> {
  const lsofResult = await lsofHasOpenOwner(dir);
  if (lsofResult !== undefined) return lsofResult;
  return (await procfsHasOpenOwner(dir)) ?? false;
}

async function migrateDir(legacy: string, target: string, label: string): Promise<void> {
  if (legacy === target) return;
  if (!(await pathExists(legacy)) || (await pathExists(target))) return;
  if (await hasLiveOpenOwner(legacy)) {
    console.error(`ais: deferring ${label} migration (${legacy} -> ${target}) — a process currently has an open file under ${legacy}`);
    return;
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await rename(legacy, target);
    console.error(`ais: migrated ${label} from ${legacy} to ${target}`);
  } catch (err) {
    // A concurrent invocation can win the race between this function's own
    // pathExists() checks above and its rename() call below — this project
    // spawns detached background sync workers on nearly every launch, so
    // two overlapping migration attempts are realistic, not hypothetical.
    // If the target now exists and the legacy source is now gone, some
    // OTHER process already completed this exact migration a moment ago —
    // that's success, not failure, and logging it as a failure would be
    // actively misleading (send someone on an unnecessary manual `mv`).
    if ((await pathExists(target)) && !(await pathExists(legacy))) return;
    const message = err instanceof Error ? err.message : String(err);
    // Loud, never silent (see AGENTS.md's open.ts precedent): code from here
    // on only ever reads the NEW location, so a failed migration otherwise
    // looks like "this data just vanished" with no clue why.
    console.error(
      `ais: failed to migrate ${label} from ${legacy} to ${target}: ${message} ` +
        `— left in place; you may need to move it manually (mv "${legacy}" "${target}").`,
    );
  }
}

async function isSyncLockLive(lockPath: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
    if (typeof raw.pid !== "number") return false;
    process.kill(raw.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time, idempotent, self-healing relocation of this project's own data
 * from its old scattered locations (~/.cache/ais, ~/.config/ais,
 * ~/.local/share/ais/npm) into the consolidated ~/.ais tree — see
 * ais-home.ts. Safe and cheap to call on every invocation: once a target
 * exists (migrated once, or created fresh there directly), every subsequent
 * call is a handful of no-op lstat calls, matching the same "runs before
 * every launch, no-ops once migrated" shape as codex-backfill.ts's own
 * self-heal; never throws — a failure here must never block an actual
 * claude/codex/grok/kimi/zai/ais invocation, just get logged loudly.
 *
 * An explicit env-var override (AIS_SYNC_CONFIG,
 * AI_PROFILE_SWITCHER_REAL_BIN_DIR) means the user already owns a custom
 * location for that piece — automatic migration is skipped for it entirely
 * rather than moving data out from under a deliberate override.
 *
 * Every target additionally defers (rather than migrates) while any process
 * has an open file handle somewhere underneath its legacy directory — see
 * hasLiveOpenOwner(). The remote-cache migration ALSO checks its own
 * sync.lock file first, as a cheap, precise, purpose-built fast path ahead
 * of that more general (and more expensive, on a large tree) scan — an
 * in-flight sync started by a pre-migration binary is still reading/writing
 * paths under the OLD location, and racing a directory rename against that
 * is exactly the case both checks exist to catch.
 */
export async function migrateLegacyAisHome(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await Promise.all([
    env.AI_PROFILE_SWITCHER_REAL_BIN_DIR
      ? Promise.resolve()
      : migrateDir(join(home, ".local", "share", "ais", "npm"), aisNpmDir(home), "managed real-CLI npm prefix"),
    env.AIS_SYNC_CONFIG
      ? Promise.resolve()
      : migrateDir(join(home, ".config", "ais"), aisConfigDir(home), "sync config"),
    (async () => {
      const legacy = join(home, ".cache", "ais");
      if (await isSyncLockLive(join(legacy, "sync.lock"))) {
        console.error(`ais: deferring ${legacy} migration — a sync is currently in progress`);
        return;
      }
      await migrateDir(legacy, aisRemoteCacheDir(home), "sync cache/staging");
    })(),
  ]);
}
