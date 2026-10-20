import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ais-persist-script-tests-"));
const persistLib = resolve("image/archiso/airootfs/usr/local/lib/ais-live");
const hook = resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist");
const pkglistHook = resolve("image/archiso/airootfs/etc/pacman.d/hooks/ais-live-pkglist.hook");
const expectBin = process.env.AIS_EXPECT_BIN ?? "expect";

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runScript(script: string, env: Record<string, string>) {
  return Bun.spawnSync(["bash", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function testHookAt(fixture: string) {
  mkdirSync(fixture, { recursive: true });
  const runRoot = join(fixture, "run");
  const path = join(fixture, "hook");
  const contents = readFileSync(hook, "utf8")
    .replaceAll("/run/ais-persist", join(runRoot, "ais-persist"))
    .replace("/run/archiso/airootfs/etc/ais-live/base-id", join(runRoot, "archiso/airootfs/etc/ais-live/base-id"));
  writeFileSync(path, contents);
  return { path, runRoot };
}

function packageListCommand(root: string, baseFile: string) {
  const fixture = join(root, "..", "ais-live-pkglist");
  writeFileSync(fixture, readFileSync(join(persistLib, "ais-live-pkglist"), "utf8").replace("/etc/ais-live/base-packages", baseFile));
  chmodSync(fixture, 0o755);
  return fixture;
}

describe("persistent image scripts", () => {
  test("pruning enforces ordinary and low-space retention caps", () => {
    const fixture = join(scratch, "prune-caps");
    const root = join(fixture, "persist");
    const bin = join(fixture, "bin");
    mkdirSync(join(root, "@snapshots", "boot"), { recursive: true });
    mkdirSync(join(root, "@snapshots", "pre-pacman"), { recursive: true });
    mkdirSync(join(root, "@snapshots"), { recursive: true });
    mkdirSync(join(root, "@pkglist", "snapshot-meta"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    for (let i = 1; i <= 7; i++) mkdirSync(join(root, "@snapshots", "boot", `boot-${String(i).padStart(2, "0")}`));
    for (let i = 1; i <= 12; i++) mkdirSync(join(root, "@snapshots", "pre-pacman", `pre-pacman-${String(i).padStart(2, "0")}`));
    for (let i = 1; i <= 5; i++) mkdirSync(join(root, "@snapshots", `pick-displaced-${String(i).padStart(2, "0")}`));
    const log = join(fixture, "deleted");
    executable(join(bin, "btrfs"), `#!/bin/sh\nprintf '%s\\n' "$3" >> '${log}'\nrmdir "$3"\n`);
    executable(join(bin, "df"), "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity\\nsynthetic 100 10 90 10%%\\n'\n");
    let result = Bun.spawnSync([join(persistLib, "ais-live-prune"), "all"], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(6);
    expect(readFileSync(log, "utf8")).toContain("pick-displaced-01");
    executable(join(bin, "df"), "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity\\nsynthetic 100 90 10 90%%\\n'\n");
    writeFileSync(log, "");
    result = Bun.spawnSync([join(persistLib, "ais-live-prune"), "all"], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(9);
    for (let i = 6; i <= 10; i++) mkdirSync(join(root, "@snapshots", `pick-displaced-${String(i).padStart(2, "0")}`));
    writeFileSync(log, "");
    result = Bun.spawnSync([join(persistLib, "ais-live-prune"), "boot"], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(5);
    expect(readdirSync(join(root, "@snapshots")).filter((name) => name.startsWith("pick-displaced-")).length).toBe(1);
  }, 15000);

  test("failed base migration preserves the old id, retry list, and pending marker", () => {
    const fixture = join(scratch, "migration-failure");
    const root = join(fixture, "persist");
    const state = join(root, "@pkglist");
    const bin = join(fixture, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(state, "reinstall-pending"), "");
    writeFileSync(join(state, "next-base-id"), "new-base\n");
    writeFileSync(join(state, "base-id"), "old-base\n");
    writeFileSync(join(state, "migration-explicit"), "synthetic-package\n");
    executable(join(bin, "pacman"), "#!/bin/sh\nexit 1\n");
    executable(join(bin, "nm-online"), "#!/bin/sh\nexit 0\n");
    const result = Bun.spawnSync([join(persistLib, "ais-live-persist")], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(state, "base-id"), "utf8")).toBe("old-base\n");
    expect(readFileSync(join(state, "migration-explicit"), "utf8")).toBe("synthetic-package\n");
    expect(existsSync(join(state, "reinstall-pending"))).toBe(true);
  });

  test("failed installed-package query cannot commit the new base id", () => {
    const fixture = join(scratch, "migration-query-failure");
    const root = join(fixture, "persist");
    const state = join(root, "@pkglist");
    const bin = join(fixture, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const basePackages = join(fixture, "base-packages");
    writeFileSync(basePackages, "base-package\n");
    const persistScript = join(fixture, "ais-live-persist");
    writeFileSync(persistScript, readFileSync(join(persistLib, "ais-live-persist"), "utf8").replace("/etc/ais-live/base-packages", basePackages));
    chmodSync(persistScript, 0o755);
    writeFileSync(join(state, "reinstall-pending"), "");
    writeFileSync(join(state, "next-base-id"), "new-base\n");
    writeFileSync(join(state, "base-id"), "old-base\n");
    writeFileSync(join(state, "migration-explicit"), "synthetic-package\n");
    executable(join(bin, "pacman"), "#!/bin/sh\n[ \"$1\" != -Qqe ]\n");
    executable(join(bin, "nm-online"), "#!/bin/sh\nexit 0\n");
    const result = Bun.spawnSync([persistScript], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, AIS_LIVE_REPLAY_MARKER: join(fixture, "replay"), PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(state, "base-id"), "utf8")).toBe("old-base\n");
    expect(existsSync(join(state, "reinstall-pending"))).toBe(true);
    expect(existsSync(join(state, "migration-explicit"))).toBe(true);
  });

  test("successful base migration commits the target id and clears migration state", () => {
    const fixture = join(scratch, "migration-success");
    const root = join(fixture, "persist");
    const state = join(root, "@pkglist");
    const bin = join(fixture, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const basePackages = join(fixture, "base-packages");
    writeFileSync(basePackages, "base-package\n");
    const persistScript = join(fixture, "ais-live-persist");
    writeFileSync(persistScript, readFileSync(join(persistLib, "ais-live-persist"), "utf8").replace("/etc/ais-live/base-packages", basePackages));
    chmodSync(persistScript, 0o755);
    const replayMarker = join(fixture, "replay-marker");
    writeFileSync(join(state, "reinstall-pending"), "");
    writeFileSync(join(state, "next-base-id"), "new-base\n");
    writeFileSync(join(state, "base-id"), "old-base\n");
    writeFileSync(join(state, "migration-explicit"), "synthetic-package\n");
    writeFileSync(join(state, "migration-user-removals"), "old-user-package\n");
    writeFileSync(join(state, "migration-user-additions"), "new-user-package\n");
    const pacmanLog = join(fixture, "pacman.log");
    executable(join(bin, "pacman"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${pacmanLog}'\nif [ "$1" = -Qqe ]; then printf 'base-package\\nnew-user-package\\n'; exit 0; fi\nif [ "$1" = -Q ] && [ "$2" = old-user-package ]; then exit 0; fi\nif [ "$1" = -Q ]; then exit 1; fi\nexit 0\n`);
    executable(join(bin, "nm-online"), "#!/bin/sh\nexit 0\n");
    const result = Bun.spawnSync([persistScript], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, AIS_LIVE_REPLAY_MARKER: replayMarker, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(state, "base-id"), "utf8")).toBe("new-base\n");
    expect(existsSync(join(state, "reinstall-pending"))).toBe(false);
    expect(readFileSync(join(state, "explicit"), "utf8")).toBe("new-user-package\n");
    expect(readFileSync(pacmanLog, "utf8")).toContain("-R --noconfirm -- old-user-package");
    expect(readFileSync(pacmanLog, "utf8")).toContain("-S --noconfirm -- new-user-package");
    expect(existsSync(join(state, "migration-user-additions"))).toBe(false);
    expect(existsSync(join(state, "migration-user-removals"))).toBe(false);
  });

  test("partial replay retries safely and reconciles offline additions and removals", () => {
    const fixture = join(scratch, "migration-delta-retry");
    const root = join(fixture, "persist");
    const state = join(root, "@pkglist");
    const bin = join(fixture, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const basePackages = join(fixture, "base-packages");
    writeFileSync(basePackages, "base-package\n");
    const persistScript = join(fixture, "ais-live-persist");
    writeFileSync(persistScript, readFileSync(join(persistLib, "ais-live-persist"), "utf8").replace("/etc/ais-live/base-packages", basePackages));
    chmodSync(persistScript, 0o755);
    writeFileSync(join(state, "reinstall-pending"), "");
    writeFileSync(join(state, "next-base-id"), "SYNTHETIC_FIXTURE_next_base\n");
    writeFileSync(join(state, "base-id"), "SYNTHETIC_FIXTURE_old_base\n");
    writeFileSync(join(state, "migration-explicit"), "SYNTHETIC_FIXTURE_old_user_package\nSYNTHETIC_FIXTURE_retry_package\n");
    writeFileSync(join(state, "migration-user-removals"), "SYNTHETIC_FIXTURE_old_user_package\n");
    writeFileSync(join(state, "migration-user-additions"), "SYNTHETIC_FIXTURE_offline_addition\n");
    const installed = join(fixture, "installed");
    mkdirSync(installed);
    writeFileSync(join(installed, "base-package"), "");
    writeFileSync(join(installed, "SYNTHETIC_FIXTURE_old_user_package"), "");
    const failOnce = join(fixture, "failed-once");
    const pacman = `#!/bin/sh
case "$1" in
  -S)
    pkg=$4
    if [ "$pkg" = SYNTHETIC_FIXTURE_retry_package ] && [ ! -e '${failOnce}' ]; then touch '${failOnce}'; exit 1; fi
    touch '${installed}/'$pkg
    ;;
  -Q)
    [ -e '${installed}/'$2 ]
    ;;
  -R)
    rm -f '${installed}/'$4
    ;;
  -Qqe)
    for path in '${installed}'/*; do [ -e "$path" ] && basename "$path"; done
    ;;
esac
`;
    executable(join(bin, "pacman"), pacman);
    executable(join(bin, "nm-online"), "#!/bin/sh\nexit 0\n");
    const env = { ...process.env, AIS_LIVE_PERSIST_ROOT: root, AIS_LIVE_REPLAY_MARKER: join(fixture, "replay"), PATH: `${bin}:${process.env.PATH}` };
    const first = Bun.spawnSync([persistScript, "--retry"], { env, stdout: "pipe", stderr: "pipe" });
    expect(first.exitCode).toBe(10);
    expect(existsSync(join(state, "reinstall-pending"))).toBe(true);
    const second = Bun.spawnSync([persistScript, "--retry"], { env, stdout: "pipe", stderr: "pipe" });
    expect(second.exitCode).toBe(0);
    expect(existsSync(join(installed, "SYNTHETIC_FIXTURE_old_user_package"))).toBe(false);
    expect(existsSync(join(installed, "SYNTHETIC_FIXTURE_retry_package"))).toBe(true);
    expect(existsSync(join(installed, "SYNTHETIC_FIXTURE_offline_addition"))).toBe(true);
    expect(readFileSync(join(state, "explicit"), "utf8")).toBe("SYNTHETIC_FIXTURE_offline_addition\nSYNTHETIC_FIXTURE_retry_package\n");
    expect(existsSync(join(state, "reinstall-pending"))).toBe(false);
  });

  test("migration retry keeps the key until the dedicated shutdown lifetime service stops", () => {
    const ready = readFileSync(resolve("image/archiso/airootfs/etc/systemd/system/ais-live-persist-ready.service"), "utf8");
    const retry = readFileSync(resolve("image/archiso/airootfs/etc/systemd/system/ais-live-persist-retry.service"), "utf8");
    expect(ready).not.toContain("ExecStop=");
    const lifetime = readFileSync(resolve("image/archiso/airootfs/etc/systemd/system/ais-live-key-lifetime.service"), "utf8");
    expect(lifetime).toContain("keyctl revoke");
    expect(lifetime).toContain("Before=ais-live-outbox-shutdown.service");
    expect(retry).toContain("ExecStart=/usr/local/lib/ais-live/ais-live-persist --retry");
    expect(retry).not.toContain("ExecStop=");
    expect(retry).not.toContain("keyctl");
    expect(retry).not.toContain("RemainAfterExit=yes");
    expect(retry).toContain("SuccessExitStatus=10");
  });

  test("snapshot helper records package metadata beside the read-only upper snapshot", () => {
    const snapshot = readFileSync(join(persistLib, "ais-live-snapshot"), "utf8");
    expect(snapshot).toContain('btrfs subvolume snapshot -r "$root/@upper" "$target"');
    expect(snapshot).toContain('cp "$root/@pkglist/explicit" "$metadata_explicit"');
    expect(snapshot).toContain('/usr/local/lib/ais-live/ais-live-prune');
  });

  test("pending-migration snapshot records installed packages before publishing its metadata", () => {
    const fixture = join(scratch, "pending-snapshot");
    const root = join(fixture, "persist");
    const state = join(root, "@pkglist");
    const bin = join(fixture, "bin");
    mkdirSync(join(root, "@upper"), { recursive: true });
    mkdirSync(join(root, "@snapshots", "boot"), { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(state, "reinstall-pending"), "");
    writeFileSync(join(state, "next-base-id"), "SYNTHETIC_FIXTURE_next_base\n");
    writeFileSync(join(state, "explicit"), "SYNTHETIC_FIXTURE_unreplayed_package\n");
    writeFileSync(join(fixture, "base-packages"), "SYNTHETIC_FIXTURE_base_package\n");
    executable(join(bin, "pacman"), "#!/bin/sh\nprintf 'SYNTHETIC_FIXTURE_base_package\\nSYNTHETIC_FIXTURE_offline_addition\\n'");
    executable(join(bin, "btrfs"), "#!/bin/sh\nmkdir -p \"$5\"\n");
    executable(join(bin, "date"), "#!/bin/sh\nprintf '20261019T00000000000000000\\n'");
    executable(join(bin, "ais-live-prune"), "#!/bin/sh\nexit 0\n");
    const script = join(fixture, "ais-live-snapshot");
    writeFileSync(script, readFileSync(join(persistLib, "ais-live-snapshot"), "utf8").replace("/etc/ais-live/base-packages", join(fixture, "base-packages")).replace("/usr/local/lib/ais-live/ais-live-prune", join(bin, "ais-live-prune")));
    chmodSync(script, 0o755);
    const result = Bun.spawnSync([script, "boot"], { env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const metas = readdirSync(join(state, "snapshot-meta"));
    expect(metas).toHaveLength(1);
    expect(readFileSync(join(state, "snapshot-meta", metas[0], "explicit"), "utf8")).toBe("SYNTHETIC_FIXTURE_offline_addition\n");
  });

  test("interrupted snapshot pick recovery keeps selected package state and cancels migration", () => {
    const fixture = join(scratch, "pick-recovery");
    const { path: testHook, runRoot } = testHookAt(fixture);
    const persist = join(runRoot, "ais-persist");
    const state = join(persist, "@pkglist");
    const selected = "boot-20261019T000000-1";
    mkdirSync(join(persist, "@snapshots", "boot", selected), { recursive: true });
    mkdirSync(join(persist, "@upper"), { recursive: true });
    mkdirSync(join(state, "snapshot-meta", selected), { recursive: true });
    writeFileSync(join(state, "snapshot-meta", selected, "base-id"), "SYNTHETIC_FIXTURE_current_base\n");
    writeFileSync(join(state, "snapshot-meta", selected, "explicit"), "SYNTHETIC_FIXTURE_offline_addition\n");
    writeFileSync(join(state, "base-id"), "SYNTHETIC_FIXTURE_current_base\n");
    writeFileSync(join(state, "next-base-id"), "SYNTHETIC_FIXTURE_current_base\n");
    writeFileSync(join(state, "reinstall-pending"), "");
    for (const journal of ["migration-explicit", "migration-user-additions", "migration-user-removals", "user-changes"]) {
      writeFileSync(join(state, journal), "SYNTHETIC_FIXTURE_stale_value\n");
    }
    const baseDir = join(runRoot, "archiso", "airootfs", "etc", "ais-live");
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, "base-id"), "SYNTHETIC_FIXTURE_current_base\n");
    const bin = join(fixture, "bin");
    mkdirSync(bin, { recursive: true });
    const interrupted = join(fixture, "interrupted-move");
    executable(join(bin, "btrfs"), `#!/bin/sh
if [ "$1" = subvolume ] && [ "$2" = show ]; then [ -d "$3" ]; exit; fi
if [ "$1" = subvolume ] && [ "$2" = delete ]; then rmdir "$3"; exit; fi
if [ "$1" = subvolume ] && [ "$2" = create ]; then mkdir -p "$3"; exit; fi
if [ "$1" = subvolume ] && [ "$2" = snapshot ]; then
  if [ "$3" = -r ]; then mkdir -p "$5"; else mkdir -p "$4"; fi
  exit 0
fi
exit 1
`);
    executable(join(bin, "mv"), `#!/bin/sh\ncase "$1:$2" in *@upper-picked-*:*/@upper) if [ ! -e '${interrupted}' ]; then touch '${interrupted}'; exit 1; fi;; esac\nexec /usr/bin/mv "$@"\n`);
    const pick = Bun.spawnSync(["bash", "-c", `source '${testHook}'; PERSIST_BASE_ID=SYNTHETIC_FIXTURE_current_base; PERSIST_CONSOLE='${join(fixture, "console")}'; _persist_pick_snapshot`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(pick.exitCode).not.toBe(0);
    expect(existsSync(join(state, "pick-promotion", "upper"))).toBe(true);
    const recover = Bun.spawnSync(["bash", "-c", `source '${testHook}'; PERSIST_CONSOLE='${join(fixture, "console")}'; _persist_recover_pick && _persist_prepare_base`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(recover.exitCode).toBe(0);
    expect(existsSync(join(persist, "@upper"))).toBe(true);
    expect(readFileSync(join(state, "explicit"), "utf8")).toBe("SYNTHETIC_FIXTURE_offline_addition\n");
    expect(readFileSync(join(state, "base-id"), "utf8")).toBe("SYNTHETIC_FIXTURE_current_base\n");
    for (const journal of ["reinstall-pending", "next-base-id", "migration-explicit", "migration-user-additions", "migration-user-removals", "user-changes", "pick-promotion"]) {
      expect(existsSync(join(state, journal))).toBe(false);
    }
    const migration = Bun.spawnSync([join(persistLib, "ais-live-persist")], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: persist, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(migration.exitCode).toBe(0);
    expect(existsSync(join(state, "reinstall-pending"))).toBe(false);
    writeFileSync(join(baseDir, "base-id"), "SYNTHETIC_FIXTURE_next_base\n");
    const nextUpgrade = Bun.spawnSync(["bash", "-c", `source '${testHook}'; _persist_prepare_base`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(nextUpgrade.exitCode).toBe(0);
    expect(readFileSync(join(state, "migration-explicit"), "utf8")).toBe("SYNTHETIC_FIXTURE_offline_addition\n");
    expect(existsSync(join(state, "reinstall-pending"))).toBe(true);
  });

  test("PostTransaction package tracking subtracts base packages and records changes during pending migration", () => {
    const fixture = join(scratch, "pkglist-hook");
    const root = join(fixture, "persist");
    const base = join(fixture, "base-packages");
    const bin = join(fixture, "bin");
    mkdirSync(join(root, "@pkglist"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(base, "base-package\n");
    executable(join(bin, "pacman"), "#!/bin/sh\nprintf 'base-package\\nuser-package\\nanother-package\\n'");
    const command = packageListCommand(root, base);
    let result = Bun.spawnSync([command], { env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "@pkglist", "explicit"), "utf8")).toBe("another-package\nuser-package\n");
    writeFileSync(join(root, "@pkglist", "explicit"), "SYNTHETIC_FIXTURE_previous_list\n");
    writeFileSync(join(root, "@pkglist", "reinstall-pending"), "");
    result = Bun.spawnSync(["bash", "-c", `printf 'user-package\\nanother-package\\nremoved-package\\n' | '${command}'`], { env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "@pkglist", "explicit"), "utf8")).toBe("SYNTHETIC_FIXTURE_previous_list\n");
    expect(readFileSync(join(root, "@pkglist", "migration-user-additions"), "utf8")).toBe("another-package\nuser-package\n");
    expect(readFileSync(join(root, "@pkglist", "migration-user-removals"), "utf8")).toBe("removed-package\n");
    const cleanRoot = join(fixture, "clean-persist");
    result = Bun.spawnSync(["bash", "-c", packageListCommand(cleanRoot, base)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(existsSync(cleanRoot)).toBe(false);
    expect(readFileSync(pkglistHook, "utf8")).toContain("NeedsTargets");
  });

  test("base mismatch archives before replacing upper and failed reinstall retains its snapshot", () => {
    const fixture = join(scratch, "base-mismatch");
    const { path: testHook, runRoot } = testHookAt(fixture);
    const persist = join(runRoot, "ais-persist");
    const state = join(persist, "@pkglist");
    const upper = join(persist, "@upper");
    const snapshots = join(persist, "@snapshots");
    const baseFile = join(runRoot, "archiso", "airootfs", "etc", "ais-live", "base-id");
    const bin = join(fixture, "bin");
    const log = join(fixture, "btrfs.log");
    mkdirSync(state, { recursive: true });
    mkdirSync(upper, { recursive: true });
    mkdirSync(snapshots, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(runRoot, "archiso", "airootfs", "etc", "ais-live"), { recursive: true });
    writeFileSync(join(state, "base-id"), "SYNTHETIC_FIXTURE_old_base\n");
    writeFileSync(join(state, "explicit"), "SYNTHETIC_FIXTURE_migration_package\n");
    writeFileSync(join(upper, "old-state"), "SYNTHETIC_FIXTURE_old_state\n");
    writeFileSync(baseFile, "SYNTHETIC_FIXTURE_new_base\n");
    executable(join(bin, "btrfs"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$2" in snapshot) mkdir -p "$5" ;; delete) rm -rf -- "$3" ;; create) mkdir -p "$3" ;; esac\n`);
    executable(join(bin, "nm-online"), "#!/bin/sh\nexit 0\n");
    const result = Bun.spawnSync(["bash", "-c", `source '${testHook}'; _persist_prepare_base`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.exitCode).toBe(0);
    const operations = readFileSync(log, "utf8").trim().split("\n");
    expect(operations[0]).toContain("snapshot -r");
    expect(operations[1]).toBe(`subvolume delete ${upper}`);
    expect(operations[2]).toBe(`subvolume create ${upper}`);
    const archive = operations[0].split(" ").at(-1)!;
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(join(state, "migration-explicit"), "utf8")).toBe("SYNTHETIC_FIXTURE_migration_package\n");
    executable(join(bin, "pacman"), "#!/bin/sh\nexit 1\n");
    const basePackages = join(fixture, "base-packages");
    writeFileSync(basePackages, "SYNTHETIC_FIXTURE_new_base_package\n");
    const persistScript = join(fixture, "ais-live-persist");
    writeFileSync(persistScript, readFileSync(join(persistLib, "ais-live-persist"), "utf8").replace("/etc/ais-live/base-packages", basePackages));
    chmodSync(persistScript, 0o755);
    const reinstall = Bun.spawnSync([persistScript], { env: { ...process.env, AIS_LIVE_PERSIST_ROOT: persist, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(reinstall.exitCode).not.toBe(0);
    expect(existsSync(archive)).toBe(true);
    expect(existsSync(join(state, "reinstall-pending"))).toBe(true);
    expect(readFileSync(join(persistLib, "ais-live-persist"), "utf8")).toContain("ais-live-persist-retry.service");
  });

  test("existing encrypted persistence is opened without formatting", () => {
    const fixture = join(scratch, "existing-luks");
    const bin = join(fixture, "bin");
    mkdirSync(bin, { recursive: true });
    const commands = join(fixture, "commands");
    executable(join(bin, "keyctl"), "#!/bin/sh\ncase $1 in search) printf '123\\n';; pipe) printf 'SYNTHETIC_FIXTURE_passphrase';; esac\n");
    executable(join(bin, "cryptsetup"), `#!/bin/sh\nprintf 'cryptsetup %s\\n' "$*" >> '${commands}'\n[ "$1" = open ] || [ "$1" = isLuks ]\n`);
    const result = Bun.spawnSync(["bash", "-c", `source '${hook}'; _persist_resolve() { return 0; }; _persist_mapper() { return 0; }; PERSIST_PART=/dev/synthetic-disk5; _persist_open`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    const log = readFileSync(commands, "utf8");
    expect(result.exitCode).toBe(0);
    expect(log).toContain("cryptsetup open --key-file=- /dev/synthetic-disk5 ais-persist");
    expect(log).not.toContain("luksFormat");
    expect(log).not.toContain("mkfs");
  });

  test.skipIf(!Bun.which(expectBin))("rejects short and mismatched passphrases over a tty without echoing them", () => {
    const fixture = join(scratch, "prompt-pty");
    const bin = join(fixture, "bin");
    mkdirSync(bin, { recursive: true });
    const keylog = join(fixture, "keylog");
    executable(join(bin, "keyctl"), `#!/bin/sh\nif [ "$1" = padd ]; then cat > '${keylog}'; printf 123; fi\n`);
    const tcl = join(fixture, "prompt.exp");
    writeFileSync(tcl, `
set timeout 10
spawn env AIS_INITCPIO_CONSOLE=/dev/tty PATH=${bin}:$env(PATH) bash -c {source ${hook}; _persist_prompt}
expect {
  -re {Enter a passphrase} {}
  timeout { exit 2 }
}
send -- "\r"
expect {
  -re {Confirm passphrase} {}
  timeout { exit 4 }
}
send -- "\r"
expect {
  -re {Passphrase must contain at least 12 characters} {}
  timeout { exit 5 }
}
expect {
  -re {Enter a passphrase} {}
  timeout { exit 6 }
}
send -- "SYNTHETIC_FIXTURE_first_long_value\r"
expect {
  -re {Confirm passphrase} {}
  timeout { exit 7 }
}
send -- "SYNTHETIC_FIXTURE_second_long_value\r"
expect {
  -re {do not match} {}
  timeout { exit 8 }
}
expect {
  -re {Enter a passphrase} {}
  timeout { exit 9 }
}
send -- "SYNTHETIC_FIXTURE_valid_passphrase\r"
expect {
  -re {Confirm passphrase} {}
  timeout { exit 10 }
}
send -- "SYNTHETIC_FIXTURE_valid_passphrase\r"
expect {
  eof {}
  timeout { exit 11 }
}
catch wait result
if {[lindex $result 3] != 0} { exit 12 }
`);
    const result = Bun.spawnSync([expectBin, tcl], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("do not match");
    expect(output).not.toContain("SYNTHETIC_FIXTURE_valid_passphrase");
    expect(readFileSync(keylog, "utf8")).toBe("SYNTHETIC_FIXTURE_valid_passphrase");
  }, 15000);
});
