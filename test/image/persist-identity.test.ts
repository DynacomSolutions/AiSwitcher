import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hookPath = resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist");
const uuid = "12345678-1234-4234-8234-123456789abc";
const otherUuid = "87654321-4321-4321-8321-cba987654321";
const exchangeUuid = "abcdef12-1234-4234-8234-123456789abc";
const bootArgs = `archisobasedir=arch archisodevice=/dev/disk/by-partuuid/${otherUuid} copytoram=n ais.base=${otherUuid} ais.exchange=${exchangeUuid}`;

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
    file(`sys/devices/${disk}/p${number}/size`, "32768");
    link(`sys/devices/${disk}/p${number}`, `sys/class/block/${disk}${number}`);
    link(`sys/devices/${disk}/p${number}`, `sys/dev/block/${dev}`);
    file(`dev/block/${dev}`);
    file(`dev/block/${dev}.uuid`, id);
  };
  partition("disk", 3, "8:3", otherUuid);
  link("dev/block/8:3", `dev/disk/by-partuuid/${otherUuid}`);
  partition("disk", 5, "8:5", uuid);
  truncateSync(join(root, "dev/block/8:5"), 16 * 1024 * 1024);
  link("dev/block/8:5", `dev/disk/by-partuuid/${uuid}`);
  file("sys/devices/mapper/dm/name", "ais-persist");
  link("sys/devices/mapper", "sys/dev/block/253:0");
  link("sys/devices/disk/p5", "sys/devices/mapper/slaves/p5");
  file("dev/block/253:0");
  mkdirSync(join(root, "dev/mapper"), { recursive: true });
  file("proc/cmdline", `${bootArgs} ais.mode=latest ais.drive=${uuid}`);
  file("run/ais-persist-mode", "latest");
  file("console");
  file("writes");
  const hook = file("hook", remap(readFileSync(hookPath, "utf8"))
    .replace(`archisodevice=${root}/dev/disk`, "archisodevice=/dev/disk")
    // Regular sparse files stand in for block devices. All other checks run.
    .replace('[ -b "$1" ]', '[ -f "$1" ]'));
  executable("udevadm", "exit 0");
  executable("findmnt", "printf '8:3\\n'");
  executable("blkid", 'target=$(readlink -f "${@: -1}"); cat "$target.uuid"');
  executable("blockdev", 'exec /usr/bin/stat -Lc %s "${@: -1}"');
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
getarg() { _persist_arg "$1" || printf '%s\\n' "$2"; }
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
  for (const parameter of [
    `cow_device=/dev/disk/by-partuuid/${uuid}`, "cow_label=AISBASE", "cow_persistent=y",
    "cow_directory=elsewhere", "cow_flags=rw", "cow_spacesize=1G", "cow_chunksize=8",
    "cow_future=1", "cow_device", "img_dev=/dev/block/8:3", "img_loop=/base.img",
    "archisolabel=AISBASE", "archisosearchuuid=SYNTHETIC_FIXTURE", "archisosearchfilename=/arch/base",
    "archisodevice=/dev/block/8:3", `archisodevice=/dev/disk/by-partuuid/${otherUuid}`,
    "archisobasedir=other", "dm_snap_prefix=other", "copytoram=y", "copytoram=auto",
    "copytoram=n", "copytoram_size=1G", '"cow_device"=/dev/block/8:5',
  ]) {
    test(`early hook refuses unsafe or repeated archiso argument: ${parameter}`, () => {
      const f = fixture();
      f.file("proc/cmdline", `${bootArgs} ais.drive=${uuid} ${parameter}`);
      const result = f.run("run_hook; mount /dev/block/8:3 /run/archiso/bootmnt");
      expect(result.exitCode).toBe(90);
      expect(result.stderr.toString()).toContain("Emergency:");
      expect(f.writes()).toBe("");
    });
  }

  test("early hook accepts only the unique base PARTUUID before archiso", () => {
    const f = fixture();
    const result = f.run('run_hook && printf "%s\\n" "$PERSIST_BASE_DEV"');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("8:3\n");
    expect(f.writes()).toBe("");
    const hooks = readFileSync("image/archiso/airootfs/etc/mkinitcpio.conf.d/archiso.conf", "utf8");
    expect(hooks).toMatch(/HOOKS=\([^)]*\bais_persist\s+archiso\b/);
  });

  for (const invalid of ["placeholder", "missing", "duplicate", "wrong-number", "wrong-symlink", "repeated", "missing-copytoram", "missing-device"]) {
    test(`invalid base contract stops before any mount: ${invalid}`, () => {
      const f = fixture();
      if (invalid === "placeholder") f.file("proc/cmdline", bootArgs.replaceAll(otherUuid, "HOST_APP_REQUIRED"));
      if (invalid === "missing") f.file("proc/cmdline", bootArgs.replace(` ais.base=${otherUuid}`, ""));
      if (invalid === "duplicate") f.partition("clone", 3, "8:19", otherUuid);
      if (invalid === "wrong-number") f.file("sys/devices/disk/p3/partition", "4");
      if (invalid === "wrong-symlink") {
        unlinkSync(join(f.root, `dev/disk/by-partuuid/${otherUuid}`));
        f.link("dev/block/8:5", `dev/disk/by-partuuid/${otherUuid}`);
      }
      if (invalid === "repeated") f.file("proc/cmdline", `${bootArgs} ais.base=${otherUuid}`);
      if (invalid === "missing-copytoram") f.file("proc/cmdline", bootArgs.replace(" copytoram=n", ""));
      if (invalid === "missing-device") f.file("proc/cmdline", bootArgs.replace(` archisodevice=/dev/disk/by-partuuid/${otherUuid}`, ""));
      const result = f.run("run_hook; mount /dev/block/8:3 /run/archiso/bootmnt");
      expect(result.exitCode).toBe(90);
      expect(f.writes()).toBe("");
    });
  }

  for (const drive of ["HOST_APP_REQUIRED", "", `${uuid} ais.drive=${uuid}`, "../../other", "00000000-0000-0000-0000-000000000000"]) {
    test(`invalid or placeholder identity uses only tmpfs: ${drive}`, () => {
      const f = fixture();
      f.file("proc/cmdline", `${bootArgs} ${drive ? `ais.drive=${drive}` : "ais.mode=latest"}`);
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
    f.file("proc/cmdline", `${bootArgs} aisXdrive=${uuid}`);
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
        f.partition("other", 3, "8:19", exchangeUuid);
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
    expect(f.writes()).toBe(`format /proc/self/fd/8\nopen ${f.root}/dev/disk/by-partuuid/${uuid}\nmkfs\n`);
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
      expect(f.writes()).toBe("format /proc/self/fd/8\n");
    });
  }

  test("fd verification rejects a node swapped after symlink resolution, before open", () => {
    const f = fixture();
    f.partition("other", 5, "8:21", exchangeUuid);
    truncateSync(join(f.root, "dev/block/8:21"), 16 * 1024 * 1024);
    f.file("resolved-node");
    const stat = readFileSync(join(f.root, "bin/stat"), "utf8");
    f.executable("stat", `[[ \${@: -1} != /proc/self/fd/8 ]] || touch "$FIXTURE/fd-checked"\n${stat}`);
    f.executable("readlink", `target=$(/usr/bin/readlink "$@") || exit 1
if [[ -e "$FIXTURE/armed" && \${@: -1} == "$FIXTURE/dev/disk/by-partuuid/${uuid}" ]]; then
    # Model a second device node for the same partition; the sysfs probe's
    # /dev/block path stays stable while the resolved open path is replaced.
    target=$FIXTURE/resolved-node
    mv "$target" "$FIXTURE/original-node"
    ln -s "$FIXTURE/dev/block/8:21" "$target"
fi
printf '%s\\n' "$target"`);
    const result = f.run('_persist_read_drive && _persist_resolve && touch "$FIXTURE/armed" && _persist_format 123');
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(f.root, "fd-checked"))).toBe(true);
    expect(f.writes()).toBe("");
  });

  test("changing the PARTUUID symlink after open cannot redirect formatting", () => {
    const f = fixture();
    f.partition("other", 5, "8:21", exchangeUuid);
    f.file("dev/block/8:21", "SYNTHETIC_FIXTURE_existing_foreign_contents");
    f.executable("blockdev", `ln -sf "$FIXTURE/dev/block/8:21" "$FIXTURE/dev/disk/by-partuuid/${uuid}"
exec /usr/bin/stat -Lc %s /proc/self/fd/8`);
    const cryptsetup = readFileSync(join(f.root, "bin/cryptsetup"), "utf8");
    f.executable("cryptsetup", cryptsetup.replace("luksFormat)", 'luksFormat)\nreadlink -f "${@: -1}" > "$FIXTURE/formatted-node"'));
    const result = f.run("_persist_read_drive && _persist_create");
    // Final pathname validation refuses further setup, but only the original
    // descriptor was formatted; the replacement's non-zero contents survive.
    expect(result.exitCode).not.toBe(0);
    expect(f.writes()).toBe("format /proc/self/fd/8\n");
    expect(readFileSync(join(f.root, "formatted-node"), "utf8").trim()).toBe(join(f.root, "dev/block/8:5"));
    expect(readFileSync(join(f.root, "dev/block/8:21"), "utf8")).toBe("SYNTHETIC_FIXTURE_existing_foreign_contents");
  });

  for (const change of ["device-number", "uuid", "partition", "parent", "size", "luks", "probe-error", "nonzero", "short-read"]) {
    test(`format rechecks the open fd and refuses ${change}`, () => {
      const f = fixture();
      // The size probe runs after fd 8 is open; mutate contents there to prove
      // that the final LUKS/zero checks read the descriptor, after prompting.
      const probe = {
        nonzero: "printf X > /proc/self/fd/8",
        "short-read": "truncate -s 1024 /proc/self/fd/8",
        luks: 'touch "$FIXTURE/luks"',
      }[change];
      if (probe) f.executable("blockdev", `bytes=$(/usr/bin/stat -Lc %s /proc/self/fd/8)\n${probe}\nprintf '%s\\n' "$bytes"`);
      if (change === "probe-error") {
        const script = readFileSync(join(f.root, "bin/cryptsetup"), "utf8");
        f.executable("cryptsetup", script.replace('isLuks) [[', 'isLuks) [[ ${@: -1} == /proc/self/fd/8 ]] && exit 4; [['));
      }
      const mutation = {
        "device-number": `ln -sf "$FIXTURE/dev/block/8:3" "$FIXTURE/dev/disk/by-partuuid/${uuid}"`,
        uuid: `echo ${exchangeUuid} > "$FIXTURE/dev/block/8:5.uuid"`,
        partition: 'echo 4 > "$FIXTURE/sys/devices/disk/p5/partition"',
        parent: 'echo 99 > "$FIXTURE/sys/devices/disk/diskseq"',
        size: 'echo 32769 > "$FIXTURE/sys/devices/disk/p5/size"',
      }[change] ?? ":";
      const result = f.run(`_persist_read_drive && _persist_resolve && { ${mutation}; } && _persist_format 123`);
      expect(result.exitCode, result.stderr.toString()).not.toBe(0);
      expect(f.writes()).toBe("");
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

  for (const change of ["none", "diskseq", "duplicate", "mapper", "placeholder", "missing", "repeated", "wrong-number", "wrong-disk", "wrong-symlink"]) {
    test(`runtime exchange validates successful boot identity: ${change}`, () => {
      const f = fixture();
      f.partition(change === "wrong-disk" ? "other" : "disk", 4, "8:4", exchangeUuid);
      f.link("dev/block/8:4", `dev/disk/by-partuuid/${exchangeUuid}`);
      f.link("dev/block/253:0", "dev/mapper/ais-persist");
      f.file("run/ais-persist-identity", `${f.root}/sys/devices/disk:41:8:5\n`);
      f.executable("mountpoint", '[[ -e "$FIXTURE/mounted" ]]');
      f.executable("findmnt", 'case "${@: -1}" in */bootmnt) echo 8:3 ;; *) echo 8:4 ;; esac');
      f.executable("mount", 'printf "mount %s\\n" "$*" >>"$FIXTURE/writes"; touch "$FIXTURE/mounted"');
      f.executable("umount", 'echo umount >>"$FIXTURE/writes"');
      if (change === "diskseq") f.file("sys/devices/disk/diskseq", "99");
      if (change === "duplicate") f.partition("clone", 4, "8:20", exchangeUuid);
      if (change === "mapper") f.file("sys/devices/mapper/dm/name", "other");
      if (change === "placeholder") f.file("proc/cmdline", `${bootArgs.replace(exchangeUuid, "HOST_APP_REQUIRED")} ais.drive=${uuid}`);
      if (change === "missing") f.file("proc/cmdline", `${bootArgs.replace(` ais.exchange=${exchangeUuid}`, "")} ais.drive=${uuid}`);
      if (change === "repeated") f.file("proc/cmdline", `${bootArgs} ais.drive=${uuid} ais.exchange=${exchangeUuid}`);
      if (change === "wrong-number") f.file("sys/devices/disk/p4/partition", "5");
      if (change === "wrong-symlink") {
        unlinkSync(join(f.root, `dev/disk/by-partuuid/${exchangeUuid}`));
        f.link("dev/block/8:3", `dev/disk/by-partuuid/${exchangeUuid}`);
      }
      const result = f.runtime("exchange");
      expect(result.exitCode, result.stderr.toString()).toBe(change === "none" ? 0 : 1);
      if (change === "none") {
        expect(f.writes()).toBe(`mount -t exfat -o rw,uid=0,gid=0,dmask=0077,fmask=0177,nosuid,nodev,noexec ${f.root}/dev/disk/by-partuuid/${exchangeUuid} ${f.root}/mnt/aisx\n`);
      } else expect(f.writes()).toBe("");
    });
  }

  test("all shipped menus contain the placeholder and initramfs contains no GPT writer", () => {
    for (const path of ["grub/raw.cfg", "grub/grub.cfg", "syslinux/raw.cfg", "syslinux/syslinux-linux.cfg"]) {
      const menu = readFileSync(`image/archiso/${path}`, "utf8");
      const entries = menu.split("\n").filter((line) => /^\s*(linux|APPEND)\s.*archisobasedir=/.test(line));
      expect(entries).toHaveLength(path.endsWith("raw.cfg") ? 3 : 1);
      for (const entry of entries) {
        for (const key of ["base", "exchange", "drive"]) {
          expect(entry.match(new RegExp(`ais\\.${key}=HOST_APP_REQUIRED`, "g"))).toHaveLength(1);
        }
        expect(entry.match(/archisodevice=\/dev\/disk\/by-partuuid\/HOST_APP_REQUIRED/g)).toHaveLength(1);
        expect(entry.match(/\bcopytoram=n\b/g)).toHaveLength(1);
        expect(entry).not.toMatch(/by-label|archisosearch|cow_/);
      }
    }
    for (const path of [hookPath, "image/archiso/airootfs/etc/initcpio/install/ais_persist"]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/\b(sgdisk|sfdisk|parted|partx|ais-gpt-check)\b/);
    }
  });
});
