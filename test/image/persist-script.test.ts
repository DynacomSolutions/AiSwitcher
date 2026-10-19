import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const contents = readFileSync(pkglistHook, "utf8");
  const match = contents.match(/^Exec = \/usr\/bin\/bash -c '(.*)'$/m);
  if (!match) throw new Error("Could not extract package-list pacman hook command");
  return match[1].replaceAll("/mnt/persist", root).replace("/etc/ais-live/base-packages", baseFile);
}

describe("persistent image scripts", () => {
  test("device mismatch refuses before any partitioning command", () => {
    const fixture = join(scratch, "create-refusal");
    mkdirSync(fixture, { recursive: true });
    const consolePath = join(fixture, "console");
    const log = join(fixture, "sfdisk.log");
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    writeFileSync(consolePath, "/dev/synthetic-other\n");
    executable(join(bin, "sfdisk"), `#!/bin/sh\nprintf called >> '${log}'\n`);
    const result = Bun.spawnSync([
      "bash", "-c",
      `source '${hook}'; _persist_prompt(){ return 0; }; _persist_die(){ printf '%s\\n' "$*"; }; read(){ reply=/dev/synthetic-other; }; PERSIST_DISK=/dev/synthetic-disk; _persist_create`,
    ], { env: { ...process.env, AIS_INITCPIO_CONSOLE: consolePath, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(consolePath, "utf8")).toContain("Type the full device path to confirm");
    expect(existsSync(log)).toBe(false);
    expect(result.stdout.toString()).toContain("Device confirmation did not match");
  }, 15000);

  test("pruning enforces ordinary and low-space retention caps", () => {
    const fixture = join(scratch, "prune-caps");
    const root = join(fixture, "persist");
    const bin = join(fixture, "bin");
    mkdirSync(join(root, "@snapshots", "boot"), { recursive: true });
    mkdirSync(join(root, "@snapshots", "pre-pacman"), { recursive: true });
    mkdirSync(join(root, "@pkglist", "snapshot-meta"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    for (let i = 1; i <= 7; i++) mkdirSync(join(root, "@snapshots", "boot", `boot-${String(i).padStart(2, "0")}`));
    for (let i = 1; i <= 12; i++) mkdirSync(join(root, "@snapshots", "pre-pacman", `pre-pacman-${String(i).padStart(2, "0")}`));
    const log = join(fixture, "deleted");
    executable(join(bin, "btrfs"), `#!/bin/sh\nprintf '%s\\n' "$3" >> '${log}'\nrmdir "$3"\n`);
    executable(join(bin, "df"), "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity\\nsynthetic 100 10 90 10%%\\n'\n");
    let result = Bun.spawnSync([join(persistLib, "ais-live-prune"), "all"], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(4);
    executable(join(bin, "df"), "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity\\nsynthetic 100 90 10 90%%\\n'\n");
    writeFileSync(log, "");
    result = Bun.spawnSync([join(persistLib, "ais-live-prune"), "all"], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(7);
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
    writeFileSync(join(state, "reinstall-pending"), "");
    writeFileSync(join(state, "next-base-id"), "new-base\n");
    writeFileSync(join(state, "base-id"), "old-base\n");
    writeFileSync(join(state, "migration-explicit"), "synthetic-package\n");
    executable(join(bin, "pacman"), "#!/bin/sh\nexit 0\n");
    executable(join(bin, "nm-online"), "#!/bin/sh\nexit 0\n");
    const result = Bun.spawnSync([persistScript], {
      env: { ...process.env, AIS_LIVE_PERSIST_ROOT: root, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(state, "base-id"), "utf8")).toBe("new-base\n");
    expect(existsSync(join(state, "reinstall-pending"))).toBe(false);
  });

  test("snapshot helper records package metadata beside the read-only upper snapshot", () => {
    const snapshot = readFileSync(join(persistLib, "ais-live-snapshot"), "utf8");
    expect(snapshot).toContain('btrfs subvolume snapshot -r "$root/@upper" "$target"');
    expect(snapshot).toContain('cp "$root/@pkglist/explicit" "$meta/explicit"');
    expect(snapshot).toContain('/usr/local/lib/ais-live/ais-live-prune');
  });

  test("PostTransaction package tracking subtracts base packages and skips pending or clean states", () => {
    const fixture = join(scratch, "pkglist-hook");
    const root = join(fixture, "persist");
    const base = join(fixture, "base-packages");
    const bin = join(fixture, "bin");
    mkdirSync(join(root, "@pkglist"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(base, "base-package\n");
    executable(join(bin, "pacman"), "#!/bin/sh\nprintf 'base-package\\nuser-package\\nanother-package\\n'");
    const command = packageListCommand(root, base);
    let result = Bun.spawnSync(["bash", "-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "@pkglist", "explicit"), "utf8")).toBe("another-package\nuser-package\n");
    writeFileSync(join(root, "@pkglist", "explicit"), "SYNTHETIC_FIXTURE_previous_list\n");
    writeFileSync(join(root, "@pkglist", "reinstall-pending"), "");
    result = Bun.spawnSync(["bash", "-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "@pkglist", "explicit"), "utf8")).toBe("SYNTHETIC_FIXTURE_previous_list\n");
    const cleanRoot = join(fixture, "clean-persist");
    result = Bun.spawnSync(["bash", "-c", packageListCommand(cleanRoot, base)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(existsSync(cleanRoot)).toBe(false);
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
  });

  test("clean mode reports success without probing or mounting persistence", () => {
    const fixture = join(scratch, "clean-mode");
    mkdirSync(fixture, { recursive: true });
    const consolePath = join(fixture, "console");
    const log = join(fixture, "commands");
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    executable(join(bin, "mount"), `#!/bin/sh\nprintf mount >> '${log}'\n`);
    const result = Bun.spawnSync(["bash", "-c", `source '${hook}'; getarg(){ printf clean; }; run_hook`], {
      env: { ...process.env, AIS_INITCPIO_CONSOLE: consolePath, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(consolePath, "utf8")).toContain("AIS-LIVE: stage=persist status=ok mode=clean");
    expect(existsSync(log)).toBe(false);
  });

  test("existing LUKS headers are never formatted and partition operations stay ordered", () => {
    const fixture = join(scratch, "existing-luks");
    const bin = join(fixture, "bin");
    mkdirSync(bin, { recursive: true });
    const consolePath = join(fixture, "console");
    const commands = join(fixture, "commands");
    const testHook = join(fixture, "hook");
    writeFileSync(testHook, readFileSync(hook, "utf8").replace('[ -b "$PERSIST_PART" ]', "true"));
    writeFileSync(consolePath, "/dev/synthetic-disk\n");
    for (const command of ["sfdisk", "partx", "udevadm", "cryptsetup", "keyctl", "mkfs.btrfs"]) {
      const body = command === "cryptsetup"
        ? `#!/bin/sh\nprintf 'cryptsetup %s\\n' "$*" >> '${commands}'\n[ "$1" = isLuks ]\n`
        : `#!/bin/sh\nprintf '${command} %s\\n' "$*" >> '${commands}'\n`;
      executable(join(bin, command), body);
    }
    const result = Bun.spawnSync(["bash", "-c", `source '${testHook}'; _persist_prompt(){ :; }; _persist_die(){ printf '%s\\n' "$*"; }; read(){ builtin read -r "$@" <<<'/dev/synthetic-disk'; }; PERSIST_CONSOLE=/dev/null; PERSIST_DISK=/dev/synthetic-disk; PERSIST_PART=/dev/synthetic-disk5; _persist_create`], {
      env: { ...process.env, AIS_INITCPIO_CONSOLE: consolePath, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    const log = readFileSync(commands, "utf8");
    const relocate = log.indexOf("sfdisk --relocate gpt-bak-std");
    const append = log.indexOf("sfdisk --append");
    const partx = log.indexOf("partx -a");
    expect(result.exitCode).not.toBe(0);
    expect(relocate).toBeGreaterThanOrEqual(0);
    expect(append).toBeGreaterThan(relocate);
    expect(partx).toBeGreaterThan(append);
    expect(log).toContain("cryptsetup isLuks /dev/synthetic-disk5");
    expect(log).not.toContain("luksFormat");
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
