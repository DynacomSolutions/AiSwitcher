import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "image-assert-"));

function run(script: string, content: string): number {
  const file = join(dir, "input.txt");
  writeFileSync(file, content);
  return Bun.spawnSync(["bash", `image/build/${script}`, file], { stderr: "pipe", stdout: "pipe" }).exitCode;
}

describe("assert-disk.sh", () => {
  test("passes when peak growth is under 80% of free", () => {
    expect(run("assert-disk.sh", "1 100 1000\n2 700 400\n3 500 600\n")).toBe(0);
  });
  test("fails on a synthetic over-80% sample", () => {
    expect(run("assert-disk.sh", "1 100 1000\n2 950 150\n")).toBe(1);
  });
  test("fails without samples", () => {
    expect(run("assert-disk.sh", "")).toBe(2);
  });
  test("fails with a single sample (no final sample)", () => {
    expect(run("assert-disk.sh", "1 100 1000\n")).toBe(2);
  });
});

describe("assert-eltorito.sh", () => {
  const bios = "-b '/boot/syslinux/isolinux.bin' -no-emul-boot\n";
  const efi = "-eltorito-alt-boot\n-e '--interval:appended_partition_2:all::' -no-emul-boot\n";
  test("passes with both records", () => {
    expect(run("assert-eltorito.sh", bios + efi)).toBe(0);
  });
  test("fails without a BIOS record", () => {
    expect(run("assert-eltorito.sh", efi)).not.toBe(0);
  });
  test("fails without an EFI record", () => {
    expect(run("assert-eltorito.sh", bios)).not.toBe(0);
  });
  test("fails on an EFI platform id without an -e entry", () => {
    expect(run("assert-eltorito.sh", bios + "-eltorito-alt-boot\n-eltorito-platform efi\n")).not.toBe(0);
  });
  test("fails on an empty -e entry", () => {
    expect(run("assert-eltorito.sh", bios + "-e ''\n")).not.toBe(0);
  });
});

test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
