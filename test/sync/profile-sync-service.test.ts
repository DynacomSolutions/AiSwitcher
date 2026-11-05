import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeProfileSyncServiceResult,
  installProfileSyncService,
  PROFILE_SYNC_SERVICE_NAME,
  PROFILE_SYNC_UNIT,
  type Systemctl,
} from "../../src/sync/profile-sync-service.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function unitDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-psd-unit-"));
  dirs.push(dir);
  return dir;
}

/** Fake `systemctl --user`: records calls, reports the given ActiveState. */
function fakeCtl(state: { active: boolean; manager?: boolean; failOn?: string }) {
  const calls: string[] = [];
  const ctl: Systemctl = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "show-environment") return { code: state.manager === false ? 1 : 0, out: "", err: "" };
    if (state.failOn && args[0] === state.failOn) return { code: 1, out: "", err: "boom" };
    if (args[0] === "show") return { code: 0, out: state.active ? "active" : "inactive", err: "" };
    if (args[0] === "start" || args[0] === "restart") state.active = true;
    return { code: 0, out: "", err: "" };
  };
  return { ctl, calls };
}

const base = { platform: "linux" as const, checkEntrypoint: async () => true };

test("the embedded unit is the reviewed file and runs the daemon entrypoint", async () => {
  const file = await readFile(join(import.meta.dir, "..", "..", "scripts", "systemd", PROFILE_SYNC_SERVICE_NAME), "utf8");
  expect(PROFILE_SYNC_UNIT).toBe(file);
  expect(PROFILE_SYNC_UNIT).toContain("ExecStart=%h/.local/bin/ais __profile_sync_daemon");
  expect(PROFILE_SYNC_UNIT).not.toContain("/home/");
});

test("first install writes the unit, reloads, enables and starts it", async () => {
  const unitDirectory = await unitDir();
  const { ctl, calls } = fakeCtl({ active: false });
  const result = await installProfileSyncService({ ...base, unitDirectory, ctl });
  expect(result).toMatchObject({ status: "installed", changed: true, action: "started" });
  expect(await readFile(join(unitDirectory, PROFILE_SYNC_SERVICE_NAME), "utf8")).toBe(PROFILE_SYNC_UNIT);
  expect(calls).toEqual([
    "show-environment",
    "daemon-reload",
    `enable ${PROFILE_SYNC_SERVICE_NAME}`,
    `show --property=ActiveState --value ${PROFILE_SYNC_SERVICE_NAME}`,
    `start ${PROFILE_SYNC_SERVICE_NAME}`,
  ]);
});

test("a second run is idempotent: no rewrite and no restart of a running daemon", async () => {
  const unitDirectory = await unitDir();
  const state = { active: false };
  await installProfileSyncService({ ...base, unitDirectory, ctl: fakeCtl(state).ctl });
  const { ctl, calls } = fakeCtl(state);
  const result = await installProfileSyncService({ ...base, unitDirectory, ctl });
  expect(result).toMatchObject({ status: "verified", changed: false, action: "running" });
  expect(calls.some((c) => c.startsWith("restart") || c.startsWith("start"))).toBe(false);
});

test("a changed ais binary or unit restarts a running daemon", async () => {
  const unitDirectory = await unitDir();
  await installProfileSyncService({ ...base, unitDirectory, ctl: fakeCtl({ active: false }).ctl });
  expect(await installProfileSyncService({ ...base, unitDirectory, ctl: fakeCtl({ active: true }).ctl, restartIfActive: true }))
    .toMatchObject({ action: "restarted", changed: false });

  const path = join(unitDirectory, PROFILE_SYNC_SERVICE_NAME);
  await writeFile(path, "old unit");
  await chmod(path, 0o644);
  expect(await installProfileSyncService({ ...base, unitDirectory, ctl: fakeCtl({ active: true }).ctl }))
    .toMatchObject({ status: "installed", action: "restarted" });
  expect(await readFile(path, "utf8")).toBe(PROFILE_SYNC_UNIT);
});

test("no user manager, an old ais, a failing systemctl or another OS never throw", async () => {
  const unitDirectory = await unitDir();
  expect(await installProfileSyncService({ ...base, unitDirectory, ctl: fakeCtl({ active: false, manager: false }).ctl }))
    .toEqual({ status: "no-user-manager" });
  expect(await installProfileSyncService({ ...base, unitDirectory, ctl: async () => { throw new Error("ENOENT systemctl"); } }))
    .toEqual({ status: "no-user-manager" });
  expect(await installProfileSyncService({ ...base, unitDirectory, ctl: fakeCtl({ active: false }).ctl, checkEntrypoint: async () => false }))
    .toEqual({ status: "unsupported-entrypoint" });
  const failed = await installProfileSyncService({ ...base, unitDirectory, ctl: fakeCtl({ active: false, failOn: "enable" }).ctl });
  expect(failed).toMatchObject({ status: "failed" });
  expect(describeProfileSyncServiceResult(failed)?.warn).toBe(true);
  expect(await installProfileSyncService({ ...base, platform: "darwin", unitDirectory })).toEqual({ status: "not-linux" });
});
