import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test("rejects a malformed sample between valid endpoints", () => {
    expect(run("assert-disk.sh", "1 100 1000\n2 950 invalid\n3 200 900\n")).toBe(2);
  });
  test("rejects a short or blank sample between valid endpoints", () => {
    expect(run("assert-disk.sh", "1 100 1000\n\n3 200 900\n")).toBe(2);
    expect(run("assert-disk.sh", "1 100 1000\n2 200\n3 200 900\n")).toBe(2);
  });
  test("rejects non-numeric timestamps and negative numeric columns", () => {
    expect(run("assert-disk.sh", "one 100 1000\n2 -10 900\n")).toBe(2);
  });
  test("rejects zero initial available space", () => {
    expect(run("assert-disk.sh", "1 100 0\n2 110 10\n")).toBe(2);
  });
});

describe("sample-df.sh", () => {
  test("fails when df exits nonzero even if it prints a numeric row", () => {
    const fakeBin = join(dir, "bin");
    const fakeDf = join(fakeBin, "df");
    const output = join(dir, "samples.txt");
    Bun.spawnSync(["mkdir", "-p", fakeBin]);
    writeFileSync(fakeDf, "#!/usr/bin/env bash\nprintf '100 200\\n'\nexit 1\n", { mode: 0o755 });
    const result = Bun.spawnSync(["bash", "image/build/sample-df.sh", "--once", output], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });
  test("writes one valid sample when df succeeds", () => {
    const fakeBin = join(dir, "success-bin");
    const fakeDf = join(fakeBin, "df");
    const output = join(dir, "success-samples.txt");
    Bun.spawnSync(["mkdir", "-p", fakeBin]);
    writeFileSync(fakeDf, "#!/usr/bin/env bash\nprintf '100 900\\n'\n", { mode: 0o755 });
    const result = Bun.spawnSync(["bash", "image/build/sample-df.sh", "--once", output], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toMatch(/^\d+\s+100\s+900\n$/);
  });
});

test("README disk budget arithmetic matches the stated units", () => {
  const readme = readFileSync("image/README.md", "utf8");
  const growth = 9_101_324;
  const decimalBudget = 14_000_000_000 / 1024;
  const threshold = decimalBudget * 0.8;
  const headroom = threshold - growth;
  expect(readme).toContain("66.57% of a 14 GB budget (13,671,875 KiB)");
  expect(readme).toContain("10,937,500 KiB");
  expect(readme).toContain("1,836,176 KiB (about 1.75 GiB)");
  expect(readme).toContain("85.24 GiB (89,378,688 KiB");
  expect((growth / decimalBudget * 100).toFixed(2)).toBe("66.57");
  expect((89_378_688 / 1_048_576).toFixed(2)).toBe("85.24");
  expect(Math.round(threshold)).toBe(10_937_500);
  expect(Math.round(headroom)).toBe(1_836_176);
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
