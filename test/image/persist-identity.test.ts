import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hookPath = resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist");
const uuid = "12345678-1234-4234-8234-123456789abc";
const otherUuid = "87654321-4321-4321-8321-cba987654321";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "persist-identity-SYNTHETIC_FIXTURE-"));
  const file = (path: string, content = "") => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };
  const link = (target: string, path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, target), join(root, path));
  };
  const executable = (name: string, body: string) => chmodSync(file(`bin/${name}`, `#!/usr/bin/env bash\n${body}\n`), 0o755);
  const remap = (text: string) => text.replace(/(?<![\w/])\/(?:sysroot|sys|run|mnt|proc\/cmdline|dev\/block|dev\/disk|dev\/mapper)\b/g, (path) => root + path);
  const partition = (disk: string, number: number, dev: string, id: string) => {
    file(`sys/devices/${disk}/diskseq`, disk === "disk" ? "41" : "42");
    file(`sys/devices/${disk}/p${number}/partition`, String(number));
    file(`sys/devices/${disk}/p${number}/dev`, dev);
    link(`sys/devices/${disk}/p${number}`, `sys/class/block/${disk}${number}`);
    link(`sys/devices/${disk}/p${number}`, `sys/dev/block/${dev}`);
    file(`dev/block/${dev}`);
    file(`dev/block/${dev}.uuid`, id);
  };
  partition("disk", 3, "8:3", otherUuid);
  partition("disk", 5, "8:5", uuid);
  truncateSync(join(root, "dev/block/8:5"), 16 * 1024 * 1024);
  link("dev/block/8:5", `dev/disk/by-partuuid/${uuid}`);
  file("sys/devices/mapper/dm/name", "ais-persist");
  link("sys/devices/mapper", "sys/dev/block/253:0");
  link("sys/devices/disk/p5", "sys/devices/mapper/slaves/p5");
  file("dev/block/253:0");
  mkdirSync(join(root, "dev/mapper"), { recursive: true });
  file("proc/cmdline", `ais.mode=latest ais.drive=${uuid}`);
  file("run/ais-persist-mode", "latest");
  file("console");
  file("writes");
  const hook = file("hook", remap(readFileSync(hookPath, "utf8"))
    // Regular sparse files stand in for block devices. All other checks run.
    .replace('[ -b "$1" ]', '[ -f "$1" ]'));
  executable("udevadm", "exit 0");
  executable("findmnt", "printf '8:3\\n'");
  executable("blkid", 'cat "${@: -1}.uuid"');
  executable("stat", `if [[ $* == *%t:%T* ]]; then
    target=$(readlink -f "\${@: -1}")
    dev=\${target##*/}
    printf '%x:%x\\n' "\${dev%:*}" "\${dev#*:}"
elif [[ $* == *%u:%a* ]]; then echo 0:600
else exec /usr/bin/stat "$@"; fi`);
  executable("keyctl", `case $1 in
    search) [[ -e "$FIXTURE/key" ]] && echo 123 ;;
    pipe) printf '%s' SYNTHETIC_FIXTURE_passphrase ;;
    *) exit 0 ;;
esac`);
  executable("cryptsetup", `case $1 in
    isLuks) [[ -e "$FIXTURE/luks" ]] ;;
    luksFormat)
        cat >/dev/null
        printf 'format %s\\n' "\${@: -1}" >>"$FIXTURE/writes"
        [[ \${NO_HEADER:-0} == 1 ]] || touch "$FIXTURE/luks"
        if [[ \${CHANGE_UUID:-0} == 1 ]]; then echo '${otherUuid}' >"$FIXTURE/dev/block/8:5.uuid"; fi
        ;;
    open)
        cat >/dev/null
        printf 'open %s\\n' "\${@: -2:1}" >>"$FIXTURE/writes"
        ln -s "$FIXTURE/dev/block/253:0" "$FIXTURE/dev/mapper/ais-persist"
        ;;
    luksDump) echo SYNTHETIC_FIXTURE_luks_dump ;;
    *) exit 9 ;;
esac`);
  executable("mkfs.btrfs", 'echo mkfs >>"$FIXTURE/writes"');
  executable("mount", 'printf "mount %s\\n" "$*" >>"$FIXTURE/writes"');
  const run = (body: string, env: Record<string, string> = {}) => Bun.spawnSync(["bash", "-c",
    `source "$1"
_persist_die() { echo "$*" >&2; exit 90; }
_persist_prompt() { touch "$FIXTURE/key"; }
${body}`, "fixture", hook], {
    env: { ...process.env, FIXTURE: root, AIS_INITCPIO_CONSOLE: join(root, "console"), PATH: `${root}/bin:${process.env.PATH}`, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const runtime = (mode: string) => {
    const resolver = file("resolver", remap(readFileSync("image/archiso/airootfs/usr/local/lib/ais-live/resolve-boot-partition", "utf8"))
      .replace("source /etc/initcpio/hooks/ais_persist", `source "${hook}"`));
    return Bun.spawnSync(["bash", resolver, mode], {
      env: { ...process.env, FIXTURE: root, PATH: `${root}/bin:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
  };
  return { root, file, partition, executable, link, run, runtime, writes: () => readFileSync(join(root, "writes"), "utf8") };
}

describe("host-assigned drive identity", () => {
  for (const drive of ["HOST_APP_REQUIRED", "", `${uuid} ais.drive=${uuid}`, "../../other", "00000000-0000-0000-0000-000000000000"]) {
    test(`invalid or placeholder identity uses only tmpfs: ${drive}`, () => {
      const f = fixture();
      f.file("proc/cmdline", drive ? `ais.drive=${drive}` : "ais.mode=latest");
      const result = f.run("run_latehook");
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(f.writes()).toBe(`mount -t tmpfs -o mode=0700,nosuid,nodev,noexec tmpfs ${f.root}/sysroot/mnt/persist\n`);
      expect(readFileSync(join(f.root, "console"), "utf8")).toContain("status=ephemeral");
      expect(readFileSync(join(f.root, "console"), "utf8")).toContain("Create this drive with the AIS host app");
      expect(existsSync(join(f.root, "run/ais-persist-ephemeral"))).toBe(true);
    });
  }

  for (const mode of ["latest", "clean"]) {
    test(`two nodes sharing a PARTUUID refuse without disk writes in ${mode}`, () => {
      const f = fixture();
      f.file("run/ais-persist-mode", mode);
      f.partition("clone", 5, "8:21", uuid);
      const result = f.run("run_latehook");
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(f.writes()).toMatch(/^mount -t tmpfs [^\n]+\n$/);
      expect(readFileSync(join(f.root, "console"), "utf8")).toContain(`reason=ambiguous-drive mode=${mode}`);
    });
  }

  test("missing PARTUUID never writes", () => {
    const f = fixture();
    f.file("dev/block/8:5.uuid", otherUuid);
    expect(f.run("run_latehook").exitCode).toBe(0);
    expect(f.writes()).toMatch(/^mount -t tmpfs [^\n]+\n$/);
  });

  test("a similarly named command-line argument cannot select a drive", () => {
    const f = fixture();
    f.file("proc/cmdline", `aisXdrive=${uuid}`);
    expect(f.run("run_latehook").exitCode).toBe(0);
    expect(f.writes()).toMatch(/^mount -t tmpfs [^\n]+\n$/);
  });

  test("a PARTUUID symlink targeting a different node cannot authorise writes", () => {
    const f = fixture();
    expect(f.run("_persist_read_drive && _persist_resolve").exitCode).toBe(0);
    unlinkSync(join(f.root, `dev/disk/by-partuuid/${uuid}`));
    f.link("dev/block/8:3", `dev/disk/by-partuuid/${uuid}`);
    expect(f.run("_persist_read_drive && _persist_create").exitCode).not.toBe(0);
    expect(f.writes()).toBe("");
  });

  for (const corrupt of ["wrong-number", "different-base", "nonzero", "short-read"]) {
    test(`refuses ${corrupt} without disk writes`, () => {
      const f = fixture();
      if (corrupt === "wrong-number") f.file("sys/devices/disk/p5/partition", "4");
      if (corrupt === "different-base") {
        f.partition("other", 3, "8:19", otherUuid);
        f.file("bin/findmnt", "#!/bin/sh\nprintf '8:19\\n'\n");
      }
      if (corrupt === "nonzero") {
        // Last byte proves that the check covers the entire first 16 MiB.
        const bytes = Buffer.alloc(16 * 1024 * 1024);
        bytes[bytes.length - 1] = 1;
        writeFileSync(join(f.root, "dev/block/8:5"), bytes);
      }
      if (corrupt === "short-read") truncateSync(join(f.root, "dev/block/8:5"), 1024);
      const result = f.run("run_latehook");
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(f.writes()).toMatch(/^mount -t tmpfs [^\n]+\n$/);
      expect(readFileSync(join(f.root, "console"), "utf8")).toContain(
        `reason=${["nonzero", "short-read"].includes(corrupt) ? "nonempty-drive" : "wrong-drive"}`,
      );
    });
  }

  test("happy path formats only the named partition once and opens existing LUKS", () => {
    const f = fixture();
    const result = f.run("_persist_read_drive && _persist_create && _persist_create");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(f.writes()).toBe(`format ${f.root}/dev/disk/by-partuuid/${uuid}\nopen ${f.root}/dev/disk/by-partuuid/${uuid}\nmkfs\n`);
    // A subsequent session unlocks the existing container without formatting.
    const next = fixture();
    next.file("dev/block/8:5", "SYNTHETIC_FIXTURE_existing_LUKS_content");
    next.file("luks");
    next.file("key");
    expect(next.run("_persist_read_drive && _persist_create && _persist_open").exitCode).toBe(0);
    expect(next.writes()).toBe(`open ${next.root}/dev/disk/by-partuuid/${uuid}\n`);
  });

  for (const state of ["empty", "LUKS"]) {
    test(`clean mode uses only tmpfs with a valid ${state} partition`, () => {
      const f = fixture();
      if (state === "LUKS") f.file("luks");
      f.file("run/ais-persist-mode", "clean");
      expect(f.run("run_latehook").exitCode).toBe(0);
      expect(f.writes()).toMatch(/^mount -t tmpfs [^\n]+\n$/);
    });
  }

  for (const change of ["uuid", "diskseq", "contents", "duplicate"]) {
    test(`rechecks ${change} after the passphrase prompt`, () => {
      const f = fixture();
      const mutation = {
        uuid: `echo ${otherUuid} >"$FIXTURE/dev/block/8:5.uuid"`,
        diskseq: 'echo 99 >"$FIXTURE/sys/devices/disk/diskseq"',
        contents: 'printf X >"$FIXTURE/dev/block/8:5"',
        duplicate: `echo ${uuid} >"$FIXTURE/dev/block/8:21.uuid"`,
      }[change];
      if (change === "duplicate") f.partition("clone", 5, "8:21", otherUuid);
      const result = f.run(`_persist_prompt() { touch "$FIXTURE/key"; ${mutation}; }\n_persist_read_drive && _persist_create`);
      expect(result.exitCode).not.toBe(0);
      expect(f.writes()).toBe("");
    });
  }

  for (const change of ["CHANGE_UUID", "NO_HEADER"]) {
    test(`verifies UUID and LUKS after formatting: ${change}`, () => {
      const f = fixture();
      const result = f.run("_persist_read_drive && _persist_create", { [change]: "1" });
      expect(result.exitCode).not.toBe(0);
      expect(f.writes()).toBe(`format ${f.root}/dev/disk/by-partuuid/${uuid}\n`);
    });
  }

  for (const mode of ["clean", "ephemeral"]) {
    test(`runtime exchange cannot mount in ${mode} mode`, () => {
      const f = fixture();
      f.file("run/ais-persist-mode", mode === "clean" ? "clean" : "latest");
      if (mode === "ephemeral") f.file("run/ais-persist-ephemeral");
      const result = f.runtime("exchange");
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(f.writes()).toBe("");
    });
  }

  for (const change of ["none", "diskseq", "duplicate", "mapper"]) {
    test(`runtime exchange validates successful boot identity: ${change}`, () => {
      const f = fixture();
      f.partition("disk", 4, "8:4", otherUuid);
      f.link("dev/block/8:4", `dev/disk/by-partuuid/${otherUuid}`);
      f.link("dev/block/253:0", "dev/mapper/ais-persist");
      f.file("run/ais-persist-identity", `${f.root}/sys/devices/disk:41:8:5\n`);
      f.executable("mountpoint", '[[ -e "$FIXTURE/mounted" ]]');
      f.executable("findmnt", 'case "${@: -1}" in */bootmnt) echo 8:3 ;; *) echo 8:4 ;; esac');
      f.executable("mount", 'printf "mount %s\\n" "$*" >>"$FIXTURE/writes"; touch "$FIXTURE/mounted"');
      f.executable("umount", 'echo umount >>"$FIXTURE/writes"');
      // Base UUID is independent of the exchange UUID in a host-created image.
      f.file("dev/block/8:3.uuid", "abcdef12-1234-4234-8234-123456789abc");
      if (change === "diskseq") f.file("sys/devices/disk/diskseq", "99");
      if (change === "duplicate") f.partition("clone", 4, "8:20", otherUuid);
      if (change === "mapper") f.file("sys/devices/mapper/dm/name", "other");
      const result = f.runtime("exchange");
      expect(result.exitCode, result.stderr.toString()).toBe(change === "none" ? 0 : 1);
      if (change === "none") {
        expect(f.writes()).toBe(`mount -t exfat -o rw,uid=0,gid=0,dmask=0077,fmask=0177,nosuid,nodev,noexec ${f.root}/dev/disk/by-partuuid/${otherUuid} ${f.root}/mnt/aisx\n`);
      } else expect(f.writes()).toBe("");
    });
  }

  test("all shipped menus contain the placeholder and initramfs contains no GPT writer", () => {
    for (const path of ["grub/raw.cfg", "grub/grub.cfg", "syslinux/raw.cfg", "syslinux/syslinux-linux.cfg"]) {
      const menu = readFileSync(`image/archiso/${path}`, "utf8");
      const entries = menu.split("\n").filter((line) => /^\s*(linux|APPEND)\s.*archisobasedir=/.test(line));
      expect(entries).toHaveLength(path.endsWith("raw.cfg") ? 3 : 1);
      for (const entry of entries) expect(entry.match(/ais\.drive=HOST_APP_REQUIRED/g)).toHaveLength(1);
    }
    for (const path of [hookPath, "image/archiso/airootfs/etc/initcpio/install/ais_persist"]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/\b(sgdisk|sfdisk|parted|partx|ais-gpt-check)\b/);
    }
  });
});
