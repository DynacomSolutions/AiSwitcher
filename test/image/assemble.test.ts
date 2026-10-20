import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tools = ["sfdisk", "mkfs.fat", "mcopy", "mke2fs", "mkfs.exfat", "syslinux", "grub-mkstandalone"];
const available = tools.every((tool) => Bun.which(tool));
const scratch = mkdtempSync(join(tmpdir(), "ais-assemble-"));
const source = join(scratch, "iso");
const output = join(scratch, "live.img");
const run = (args: string[], env = {}) => Bun.spawnSync(args, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

describe.skipIf(!available)("raw GPT assembly", () => {
  test("creates the four labelled partitions and installs both bootloaders without a loop device", () => {
    mkdirSync(join(source, "arch/boot/x86_64"), { recursive: true });
    mkdirSync(join(source, "arch/x86_64"), { recursive: true });
    for (const file of ["arch/boot/x86_64/vmlinuz-linux", "arch/boot/x86_64/initramfs-linux.img", "arch/x86_64/airootfs.sfs"]) {
      writeFileSync(join(source, file), "SYNTHETIC_FIXTURE\n");
    }
    const built = run(["bash", "image/build/assemble.sh", source, output]);
    expect(built.stderr.toString()).not.toContain("Permission denied");
    expect(built.exitCode).toBe(0);
    const dump = run(["sfdisk", "--dump", output]).stdout.toString();
    expect(dump).toContain("label: gpt");
    expect(dump).toContain("LegacyBIOSBootable");
    const table = JSON.parse(run(["sfdisk", "--json", output]).stdout.toString()).partitiontable;
    expect(table.sectorsize).toBe(512);
    expect(table.partitions.map((p: { name: string }) => p.name)).toEqual(["BIOS", "AISBOOT", "AISBASE", "AISX"]);
    expect(table.partitions.map((p: { type: string }) => p.type.toUpperCase())).toEqual([
      "21686148-6449-6E6F-744E-656564454649", "C12A7328-F81F-11D2-BA4B-00A0C93EC93B",
      "0FC63DAF-8483-4772-8E79-3D69D8477DE4", "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7",
    ]);
    expect(run(["sfdisk", "--verify", output]).exitCode).toBe(0);
    expect(statSync(output).size).toBeLessThan(3 * 1024 ** 3);
    for (const [index, label] of [[1, "AISBOOT"], [2, "AISBASE"], [3, "AISX"]] as const) {
      const offset = String(table.partitions[index].start * 512);
      expect(run(["blkid", "-p", "-O", offset, "-s", "LABEL", "-o", "value", output]).stdout.toString().trim()).toBe(label);
    }
    // Inspect the built filesystem, not just the mke2fs arguments: ext4's
    // feature_compat bit 0x4 would allow journal replay on a read-only mount.
    const baseFd = openSync(output, "r");
    try {
      const superblock = Buffer.alloc(1024);
      expect(readSync(baseFd, superblock, 0, superblock.length, table.partitions[2].start * 512 + 1024)).toBe(1024);
      expect(superblock.readUInt16LE(56)).toBe(0xef53);
      expect(superblock.readUInt32LE(92) & 0x4).toBe(0);
    } finally { closeSync(baseFd); }
    const fat = `${output}@@${table.partitions[1].start * 512}`;
    for (const file of ["/EFI/BOOT/BOOTX64.EFI", "/syslinux/ldlinux.sys", "/syslinux/ldlinux.c32"]) {
      expect(run(["mdir", "-a", "-i", fat, `::${file}`]).exitCode).toBe(0);
    }
    for (const path of ["boot/grub/grub.cfg", "syslinux/syslinux.cfg"]) {
      const config = run(["mtype", "-i", fat, `::/${path}`]).stdout.toString();
      expect(config.match(/archisodevice=\/dev\/disk\/by-partuuid\/HOST_APP_REQUIRED/g)).toHaveLength(3);
      for (const key of ["base", "exchange", "drive"]) {
        expect(config.match(new RegExp(`ais\\.${key}=HOST_APP_REQUIRED`, "g"))).toHaveLength(3);
      }
      expect(config.match(/\bcopytoram=n\b/g)).toHaveLength(3);
      expect(config).not.toContain("ais.test=");
      expect(config).not.toContain("console=ttyS0");
    }
    expect(run(["bash", "image/build/assemble.sh", source, output]).exitCode).not.toBe(0);
  }, 120_000);

  test.skipIf(!Bun.which("sgdisk"))("host preparation assigns every GUID, zeros p5 and patches both boot menus", () => {
    const personalised = join(scratch, "host-created.img");
    const originalHash = run(["sha256sum", output]).stdout.toString();
    const before = JSON.parse(run(["sfdisk", "--json", output]).stdout.toString()).partitiontable;
    const result = run(["bash", "image/test/prepare-persist-drive.sh", output, personalised]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const after = JSON.parse(run(["sfdisk", "--json", personalised]).stdout.toString()).partitiontable;
    const oldIds = [before.id, ...before.partitions.map((p: { uuid: string }) => p.uuid)];
    const newIds = [after.id, ...after.partitions.map((p: { uuid: string }) => p.uuid)];
    expect(after.partitions).toHaveLength(5);
    expect(new Set(newIds).size).toBe(6);
    for (const id of newIds) expect(oldIds).not.toContain(id);
    for (let index = 0; index < 4; index++) {
      const { start, size, type, attrs } = before.partitions[index];
      expect(after.partitions[index]).toMatchObject({ start, size, type, ...(attrs ? { attrs } : {}) });
      if (index === 1) continue; // The ESP must change to carry the assigned identity.
      const hash = (image: string) => {
        const checked = run(["bash", "-o", "pipefail", "-c",
          'dd if="$1" bs=512 skip="$2" count="$3" status=none | sha256sum',
          "partition-hash", image, String(start), String(size)]);
        expect(checked.exitCode).toBe(0);
        return checked.stdout.toString();
      };
      expect(hash(personalised)).toBe(hash(output));
    }
    const persist = after.partitions[4];
    expect(persist.type.toUpperCase()).toBe("CA7D7CCB-63ED-4C53-861C-1742536059CC");
    expect(persist.start + persist.size - 1).toBe(after.lastlba);
    const fd = openSync(personalised, "r");
    try {
      const bytes = Buffer.alloc(16 * 1024 * 1024, 255);
      expect(readSync(fd, bytes, 0, bytes.length, persist.start * 512)).toBe(bytes.length);
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      // The old backup GPT falls inside p5 and must also have been erased.
      const backup = Buffer.alloc(33 * 512, 255);
      expect(readSync(fd, backup, 0, backup.length, statSync(output).size - backup.length)).toBe(backup.length);
      expect(backup.every((byte) => byte === 0)).toBe(true);
    } finally { closeSync(fd); }
    const fat = `${personalised}@@${after.partitions[1].start * 512}`;
    for (const config of ["boot/grub/grub.cfg", "syslinux/syslinux.cfg"]) {
      const menu = run(["mtype", "-i", fat, `::${config}`]);
      expect(menu.exitCode).toBe(0);
      const lines = menu.stdout.toString().split("\n").filter((line) => /^\s*(linux|APPEND)\s/.test(line));
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        const base = after.partitions[2].uuid.toLowerCase();
        const exchange = after.partitions[3].uuid.toLowerCase();
        expect(line.match(/ais\.base=\S+/g)).toEqual([`ais.base=${base}`]);
        expect(line.match(/ais\.exchange=\S+/g)).toEqual([`ais.exchange=${exchange}`]);
        expect(line.match(/ais\.drive=\S+/g)).toEqual([`ais.drive=${persist.uuid.toLowerCase()}`]);
        expect(line.match(/archisodevice=\S+/g)).toEqual([`archisodevice=/dev/disk/by-partuuid/${base}`]);
        expect(line.match(/\bcopytoram=\S+/g)).toEqual(["copytoram=n"]);
        expect(line).not.toContain("HOST_APP_REQUIRED");
      }
    }
    expect(run(["sgdisk", "-v", personalised]).stdout.toString()).toContain("No problems found");
    expect(run(["sha256sum", output]).stdout.toString()).toBe(originalHash);
    expect(run(["bash", "image/test/prepare-persist-drive.sh", output, personalised]).exitCode).not.toBe(0);
  }, 120_000);

  test.skipIf(!Bun.which("expect") || !Bun.which("sgdisk"))("patches only disposable copies and keeps private OVMF variable stores", () => {
    const fake = join(scratch, "qemu-fixture");
    writeFileSync(fake, `#!/usr/bin/env tclsh
puts "AIS-LIVE: stage=kernel-up status=ok"
puts "AIS-LIVE: stage=smoke-ready status=ok"
flush stdout
if {[gets stdin line] < 0 || $line ne "AIS-TEST-POWEROFF"} {exit 4}
puts "AIS-LIVE: stage=poweroff status=ok"
exit 0
`, { mode: 0o755 });
    const code = join(scratch, "CODE.fd"), vars = join(scratch, "VARS.fd");
    writeFileSync(code, "SYNTHETIC_FIXTURE");
    writeFileSync(vars, "SYNTHETIC_FIXTURE");
    const hash = () => run(["sha256sum", output]).stdout.toString();
    const original = hash();
    for (const firmware of ["bios", "uefi"]) {
      const boot = run(["bash", "image/test/run-qemu.sh", output, firmware], {
        AIS_QEMU_BIN: fake, AIS_OVMF_CODE: code, AIS_OVMF_VARS: vars,
      });
      expect(boot.stderr.toString()).toBe("");
      expect(boot.exitCode).toBe(0);
      const work = boot.stdout.toString().match(/qemu-test: work files: ([^\n]+)/)?.[1];
      expect(work).toBeDefined();
      for (const path of ["syslinux/syslinux.cfg", "boot/grub/grub.cfg"]) {
        const text = run(["mtype", "-i", `${work}/live.img@@2097152`, `::${path}`]).stdout.toString();
        expect(text.match(/console=ttyS0,115200 ais.test=1 ais.smoke=1/g)).toHaveLength(3);
        expect(text).not.toContain("ais.mode=latest");
        expect(text).not.toContain("HOST_APP_REQUIRED");
        expect(text.match(/\bcopytoram=n\b/g)).toHaveLength(3);
      }
      if (firmware === "uefi") {
        expect(readFileSync(`${work}/OVMF_VARS.fd`, "utf8")).toBe("SYNTHETIC_FIXTURE");
      }
    }
    expect(hash()).toBe(original);
    expect(readFileSync(vars, "utf8")).toBe("SYNTHETIC_FIXTURE");
  }, 120_000);
});

test.skipIf(!process.env.CI)("CI requires sgdisk for host preparation tests", () => {
  expect(Bun.which("sgdisk")).not.toBeNull();
});

test("refuses a missing source before creating an output", () => {
  expect(run(["bash", "image/build/assemble.sh", join(scratch, "missing"), join(scratch, "missing.img")]).exitCode).not.toBe(0);
});

test("refuses a dangling output symlink without writing its target", () => {
  const target = join(scratch, "symlink-target.img");
  const link = join(scratch, "output-link.img");
  symlinkSync(target, link);
  expect(run(["bash", "image/build/assemble.sh", scratch, link]).exitCode).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("the serial stage service is test-only and orders before the serial getty", () => {
  const service = readFileSync(resolve("image/archiso/airootfs/etc/systemd/system/ais-live-kernel-up.service"), "utf8");
  expect(service).toContain("ConditionKernelCommandLine=ais.test=1");
  expect(service).toContain("Wants=getty-pre.target");
  expect(service).toContain("Before=getty-pre.target");
});
