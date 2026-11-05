import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
// Embedded at build time, so the compiled `ais` installs the reviewed unit
// file verbatim (no second copy to drift).
import PROFILE_SYNC_UNIT from "../../scripts/systemd/ais-profile-sync.service" with { type: "text" };

export { PROFILE_SYNC_UNIT };
export const PROFILE_SYNC_SERVICE_NAME = "ais-profile-sync.service";

export interface Systemctl {
  (args: string[]): Promise<{ code: number; out: string; err: string }>;
}

export const systemctlUser: Systemctl = async (args) => {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: out.trim(), err: err.trim() };
};

async function defaultCheckEntrypoint(aisPath: string): Promise<boolean> {
  try {
    const child = Bun.spawn([aisPath, "__profile_sync_daemon", "--check"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const code = await child.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}

export interface ProfileSyncServiceOptions {
  platform?: NodeJS.Platform;
  unitDirectory?: string;
  aisPath?: string;
  ctl?: Systemctl;
  /** Proves the installed ais has the daemon entrypoint, so the unit cannot crash-loop. */
  checkEntrypoint?: (aisPath: string) => Promise<boolean>;
  /** The ais binary was replaced: restart a running daemon so it runs the new code. */
  restartIfActive?: boolean;
}

export type ProfileSyncServiceResult =
  | { status: "not-linux" | "unsupported-entrypoint" | "no-user-manager" }
  | { status: "failed"; reason: string }
  | { status: "installed" | "verified"; path: string; changed: boolean; action: "started" | "restarted" | "running" };

/**
 * Installs and starts the host-level profile-sync watcher as a user unit.
 * Idempotent: the unit file is rewritten only when its text or mode differs,
 * `daemon-reload` and `enable` are no-ops when already enabled, and a running daemon restarts only
 * when the unit or the ais binary changed. Never throws: an unavailable user
 * manager or a failing systemctl is reported in the result for the caller to
 * warn about, so an update never fails on it.
 */
export async function installProfileSyncService(options: ProfileSyncServiceOptions = {}): Promise<ProfileSyncServiceResult> {
  if ((options.platform ?? process.platform) !== "linux") return { status: "not-linux" };
  const ctl = options.ctl ?? systemctlUser;
  const aisPath = options.aisPath ?? join(homedir(), ".local", "bin", "ais");
  try {
    if ((await ctl(["show-environment"])).code !== 0) return { status: "no-user-manager" };
  } catch {
    return { status: "no-user-manager" };
  }
  if (!(await (options.checkEntrypoint ?? defaultCheckEntrypoint)(aisPath))) return { status: "unsupported-entrypoint" };

  try {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const unitDirectory = options.unitDirectory ?? join(configHome, "systemd", "user");
    await mkdir(unitDirectory, { recursive: true });
    const path = join(unitDirectory, PROFILE_SYNC_SERVICE_NAME);
    const current = await readFile(path, "utf8").catch(() => undefined);
    const currentMode = await stat(path).then((info) => info.mode & 0o777, () => undefined);
    const changed = current !== PROFILE_SYNC_UNIT || currentMode !== 0o644;
    if (changed) {
      const temporaryDirectory = await mkdtemp(join(unitDirectory, ".ais-profile-sync-"));
      const temporaryPath = join(temporaryDirectory, PROFILE_SYNC_SERVICE_NAME);
      try {
        await writeFile(temporaryPath, PROFILE_SYNC_UNIT, { encoding: "utf8", mode: 0o644 });
        await chmod(temporaryPath, 0o644);
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }

    const run = async (args: string[]) => {
      const result = await ctl(args);
      if (result.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${result.err || result.out || `exit ${result.code}`}`);
      return result.out;
    };
    await run(["daemon-reload"]);
    await run(["enable", PROFILE_SYNC_SERVICE_NAME]);
    const active = (await run(["show", "--property=ActiveState", "--value", PROFILE_SYNC_SERVICE_NAME])) === "active";
    let action: "started" | "restarted" | "running" = "running";
    if (!active) {
      await run(["start", PROFILE_SYNC_SERVICE_NAME]);
      action = "started";
    } else if (changed || options.restartIfActive) {
      await run(["restart", PROFILE_SYNC_SERVICE_NAME]);
      action = "restarted";
    }
    return { status: changed ? "installed" : "verified", path, changed, action };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** One human line for install/update output; `warn` is true when the service is not running because of it. */
export function describeProfileSyncServiceResult(result: ProfileSyncServiceResult): { line: string; warn: boolean } | undefined {
  switch (result.status) {
    case "not-linux":
      return undefined;
    case "no-user-manager":
      return { line: "profile sync service skipped: no reachable systemd user manager (sessions still sync after exit)", warn: true };
    case "unsupported-entrypoint":
      return { line: "profile sync service skipped: the installed ais has no __profile_sync_daemon; update ais first", warn: true };
    case "failed":
      return { line: `profile sync service not set up: ${result.reason}`, warn: true };
    default:
      return { line: `profile sync service ${result.status} (${result.action}): ${result.path}`, warn: false };
  }
}
