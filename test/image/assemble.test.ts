import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tools = ["sfdisk", "sgdisk", "fallocate", "jq", "mkfs.fat", "mcopy", "mke2fs", "mkfs.exfat", "syslinux", "grub-mkstandalone"];
const available = tools.every((tool) => Bun.which(tool));
const scratch = mkdtempSync(join(tmpdir(), "ais-assemble-"));
const source = join(scratch, "iso");
const output = join(scratch, "live.img");
const run = (args: string[], env = {}) => Bun.spawnSync(args, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

describe.skipIf(!available)("raw GPT assembly", () => {
  test("creates the four-partition host template and installs both bootloaders without a loop device", () => {
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
    expect(statSync(output).size).toBeLessThan(2 * 1024 ** 3);
    for (const [index, label] of [[1, "AISBOOT"], [2, "AISBASE"], [3, "AISX"]] as const) {
      const offset = String(table.partitions[index].start * 512);
      expect(run(["blkid", "-p", "-O", offset, "-s", "LABEL", "-o", "value", output]).stdout.toString().trim()).toBe(label);
    }
    const fat = `${output}@@${table.partitions[1].start * 512}`;
    for (const file of ["/EFI/BOOT/BOOTX64.EFI", "/syslinux/ldlinux.sys", "/syslinux/ldlinux.c32"]) {
      expect(run(["mdir", "-a", "-i", fat, `::${file}`]).exitCode).toBe(0);
    }
    const config = run(["mtype", "-i", fat, "::/syslinux/syslinux.cfg"]).stdout.toString();
    expect(config).toContain("archisodevice=/dev/disk/by-partuuid/HOST_APP_REQUIRED");
    expect(config).toContain("ais.base=HOST_APP_REQUIRED ais.exchange=HOST_APP_REQUIRED ais.drive=HOST_APP_REQUIRED");
    expect(config).toContain("copytoram=n");
    expect(config).not.toContain("ais.test=");
    expect(config).not.toContain("console=ttyS0");
    expect(readFileSync("image/build/assemble.sh", "utf8")).toContain("-O ^has_journal -L AISBASE");
    expect(run(["bash", "image/build/assemble.sh", source, output]).exitCode).not.toBe(0);
  }, 120_000);

  test.skipIf(!Bun.which("expect"))("patches only disposable copies and keeps private OVMF variable stores", () => {
    const fake = join(scratch, "qemu-fixture");
    writeFileSync(fake, `#!/usr/bin/env python3
import json, socket, sys
args = sys.argv[1:]
qmp = next(arg[5:] for arg in args if arg.startswith("unix:"))
qmp_path = qmp.split(",", 1)[0]
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(qmp_path)
server.listen(1)
connection, _ = server.accept()
stream = connection.makefile("rwb", buffering=0)
stream.write(b'{"QMP":{"version":{},"capabilities":[]}}\\r\\n')
while True:
    command = json.loads(stream.readline())
    stream.write(json.dumps({"return": {}, "id": command["id"]}).encode() + b"\\r\\n")
    if command["execute"] == "cont": break
print("AIS-LIVE: stage=kernel-up status=ok", flush=True)
print("AIS-LIVE: stage=smoke-ready status=ok", flush=True)
if sys.stdin.readline().strip() != "AIS-TEST-POWEROFF": sys.exit(4)
print("AIS-LIVE: stage=poweroff status=ok", flush=True)
stream.write(b'{"event":"SHUTDOWN","data":{"guest":true,"reason":"guest-shutdown"}}\\r\\n')
connection.close()
server.close()
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
      const prepared = JSON.parse(run(["sfdisk", "--json", `${work}/live.img`]).stdout.toString()).partitiontable;
      expect(prepared.partitions).toHaveLength(5);
      expect(prepared.partitions.map((part: { uuid: string }) => part.uuid)).not.toContain("HOST_APP_REQUIRED");
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
