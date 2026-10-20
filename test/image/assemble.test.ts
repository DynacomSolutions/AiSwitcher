import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
    // Inspect the actual ext4 payload staged and written by the real assembler.
    const work = built.stdout.toString().match(/assemble: work files: ([^\n]+)/)?.[1];
    expect(work).toBeDefined();
    const contract = run(["debugfs", "-R", "cat /ais-live/gpt-layout", `${work}/base.img`]).stdout.toString();
    expect(contract).toBe(readFileSync(`${work}/base/ais-live/gpt-layout`, "utf8"));
    expect(contract.trimEnd().split("\n")).toEqual([
      "AIS-GPT-LAYOUT\t1", `disk-guid\t${table.id.toLowerCase()}`,
      ...table.partitions.map((p: {start: number; size: number; type: string; uuid: string; name: string; attrs?: string}, n: number) =>
        ["part", n + 1, p.start, p.size, p.type.toLowerCase(), p.uuid.toLowerCase(), p.name, p.attrs ?? "-"].join("\t")),
    ]);
    const extracted = join(scratch, "actual-base.img");
    expect(run(["dd", `if=${output}`, `of=${extracted}`, "bs=512", `skip=${table.partitions[2].start}`, `count=${table.partitions[2].size}`, "status=none"]).exitCode).toBe(0);
    expect(run(["debugfs", "-R", "cat /ais-live/gpt-layout", extracted]).stdout.toString()).toBe(contract);
    const fat = `${output}@@${table.partitions[1].start * 512}`;
    for (const file of ["/EFI/BOOT/BOOTX64.EFI", "/syslinux/ldlinux.sys", "/syslinux/ldlinux.c32"]) {
      expect(run(["mdir", "-a", "-i", fat, `::${file}`]).exitCode).toBe(0);
    }
    const config = run(["mtype", "-i", fat, "::/syslinux/syslinux.cfg"]).stdout.toString();
    expect(config).toContain("archisodevice=/dev/disk/by-label/AISBASE");
    expect(config).not.toContain("ais.test=");
    expect(config).not.toContain("console=ttyS0");
    expect(run(["bash", "image/build/assemble.sh", source, output]).exitCode).not.toBe(0);
  }, 120_000);

  test.skipIf(!Bun.which("expect"))("patches only disposable copies and keeps private OVMF variable stores", () => {
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
      }
      if (firmware === "uefi") {
        expect(readFileSync(`${work}/OVMF_VARS.fd`, "utf8")).toBe("SYNTHETIC_FIXTURE");
      }
    }
    expect(hash()).toBe(original);
    expect(readFileSync(vars, "utf8")).toBe("SYNTHETIC_FIXTURE");
  }, 120_000);
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
