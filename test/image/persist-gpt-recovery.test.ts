import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, writeSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "ais-gpt-recovery-"));
const checker = join(root, "ais-gpt-check");
const run = (args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
const must = (args: string[]) => {
  const result = run(args);
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString()} ${result.stdout.toString()}`);
  return result.stdout.toString().trim();
};
must(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "image/archiso/ais-gpt-check.c", "-o", checker]);
// These tests intentionally require real tools. A missing dependency must not
// turn the crash-safety gate into an unreported skip.
must(["sgdisk", "--version"]);
const sectors = 26624;
const starts = [2048, 4096, 8192, 16384];
const sizes = [2048, 4096, 8192, 8192];
const base = join(root, "template.img"), manifest = join(root, "gpt-layout");
writeFileSync(base, ""); truncateSync(base, sectors * 512);
const table = ["label: gpt", "unit: sectors", "sector-size: 512", "",
  'start=2048, size=2048, type=21686148-6449-6e6f-744e-656564454649, name="BIOS"',
  'start=4096, size=4096, type=c12a7328-f81f-11d2-ba4b-00a0c93ec93b, name="AISBOOT", attrs="LegacyBIOSBootable"',
  'start=8192, size=8192, type=0fc63daf-8483-4772-8e79-3d69d8477de4, name="AISBASE"',
  'start=16384, size=8192, type=ebd0a0a2-b9e5-4433-87c0-68b6b72699c7, name="AISX"', ""].join("\n");
const layoutPath = join(root, "layout"); writeFileSync(layoutPath, table);
must(["bash", "-c", 'sfdisk "$1" < "$2"', "fixture", base, layoutPath]);
must(["bash", "image/archiso/persist-contracts.sh", "gpt-layout", base, manifest, join(root, "gpt.json")]);
function bytes(path: string, offset: number, length: number) {
  const fd = openSync(path, "r"), value = Buffer.alloc(length);
  expect(readSync(fd, value, 0, length, offset)).toBe(length); closeSync(fd); return value;
}
function put(path: string, offset: number, value: Buffer) {
  const fd = openSync(path, "r+"); writeSync(fd, value, 0, value.length, offset); closeSync(fd);
}
for (const [n, start] of starts.entries()) {
  const marker = Buffer.from(`SYNTHETIC_FIXTURE_partition_${n + 1}`);
  put(base, start * 512, marker); put(base, (start + sizes[n]!) * 512 - marker.length, marker);
}
const hashes = (path: string) => starts.map((start, n) => createHash("sha256").update(bytes(path, start * 512, sizes[n]! * 512)).digest("hex"));
const payloads = hashes(base);
const hook = readFileSync("image/archiso/airootfs/etc/initcpio/hooks/ais_persist", "utf8");
function fn(name: string) { const at = hook.indexOf(`${name}() {`); return hook.slice(at, hook.indexOf("\n}\n", at) + 3); }
function recovery(path: string, contract = manifest, bootUuid = "") {
  const dir = mkdtempSync(join(root, "repair-")), backup = join(dir, "backup.bin"), script = join(dir, "repair.sh");
  // The real hook, checker and sgdisk run on an inherited descriptor. Only the
  // hardware diskseq probe is replaced because regular files have no dev_t.
  writeFileSync(script, `${fn("_persist_write")}\n${fn("_persist_repair_gpt")
    .replaceAll("ais-gpt-check", `'${checker}'`).replaceAll("/run/ais-gpt-recovery.bin", backup)
    .replaceAll("/run/archiso/bootmnt/ais-live/gpt-layout", contract)}
_persist_check_diskseq() { [ -f /proc/self/fd/9 ]; }
exec 9<>"$1"
PERSIST_DISK=/proc/self/fd/9
PERSIST_BOOT_PARTUUID=$2
_persist_repair_gpt
`);
  return run(["bash", script, path, bootUuid]);
}
function fixture(name: string) { const dir = join(root, name); mkdirSync(dir); const path = join(dir, "disk.img"); copyFileSync(base, path); return path; }
function corrupt(path: string, at: number) { const value = bytes(path, at, 1); value[0] = value[0]! ^ 0xff; put(path, at, value); }

describe("real GPT recovery without loop devices or root", () => {
  for (const half of [false, true]) {
    for (const [copy, target, offset] of [
      ["primary", "header", 512 + 16], ["primary", "table", 1024 + 16],
      ["backup", "header", (sectors - 1) * 512 + 16], ["backup", "table", (sectors - 33) * 512 + 16],
    ] as const) {
      test(`repairs ${copy} ${target}, half-randomised=${half}, preserving all four payloads`, () => {
        const path = fixture(`${copy}-${target}-${half}`);
        must(["sgdisk", "--randomize-guids", path]);
        const bootUuid = half && copy === "backup"
          ? readFileSync(manifest, "utf8").split("\n")[3]!.split("\t")[5]!
          // Match the production boot parser's UUID normalisation.
          : must(["sfdisk", "--part-uuid", path, "2"]).toLowerCase();
        if (half) put(path, 512, bytes(base, 512, 33 * 512));
        corrupt(path, offset);
        const goodOffset = copy === "primary" ? (sectors - 1) * 512 : 512;
        const expectedGuid = bytes(path, goodOffset + 56, 16);
        const result = recovery(path, manifest, bootUuid);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        expect(bytes(path, 512 + 56, 16)).toEqual(expectedGuid);
        expect(bytes(path, (sectors - 1) * 512 + 56, 16)).toEqual(expectedGuid);
        expect(must([checker, path, manifest, join(root, "unused.bin"), ""])).toBe("clean");
        expect(hashes(path)).toEqual(payloads);
        expect(must(["sgdisk", "--verify", path])).toContain("No problems found");
      }, 30000);
    }
  }
  test("two valid but half-randomised copies refuse without writes", () => {
    const path = fixture("valid-disagreement"); must(["sgdisk", "--randomize-guids", path]);
    put(path, 512, bytes(base, 512, 33 * 512));
    const before = readFileSync(path);
    expect(recovery(path).exitCode).not.toBe(0);
    expect(readFileSync(path)).toEqual(before); expect(hashes(path)).toEqual(payloads);
  });
  test("two damaged copies refuse without writes", () => {
    const path = fixture("both-bad"); corrupt(path, 528); corrupt(path, (sectors - 33) * 512 + 16);
    const before = readFileSync(path); expect(recovery(path).exitCode).not.toBe(0);
    expect(readFileSync(path)).toEqual(before); expect(hashes(path)).toEqual(payloads);
  });
  test("a malformed manifest cannot authorise a repair before the shell verifier runs", () => {
    const canonical = readFileSync(manifest, "utf8");
    const variants = [
      canonical.replace("disk-guid\t", "disk-guid "),
      canonical.replace("part\t1\t", "part\t+1\t"),
      canonical.replace("\t2048\t", "\t02048\t"),
      canonical.replace("\t2048\t", "\t+2048\t"),
      canonical.replace("\t2048\t", " 2048\t"),
      `${canonical}\n`,
    ];
    for (const [n, contract] of variants.entries()) {
      const path = fixture(`malformed-manifest-${n}`), input = `${path}.manifest`;
      writeFileSync(input, contract); corrupt(path, 528);
      const before = readFileSync(path);
      expect(recovery(path, input).exitCode).not.toBe(0);
      expect(readFileSync(path)).toEqual(before); expect(hashes(path)).toEqual(payloads);
    }
  });
  test("a surviving copy with a foreign layout or firmware UUID cannot authorise repair", () => {
    for (const foreign of [false, true]) {
      const path = fixture(`foreign-${foreign}`);
      if (foreign) must(["sgdisk", "--change-name=4:FOREIGN", path]);
      corrupt(path, 528); const before = readFileSync(path);
      expect(recovery(path, manifest, foreign ? "" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").exitCode).not.toBe(0);
      expect(readFileSync(path)).toEqual(before); expect(hashes(path)).toEqual(payloads);
    }
  });
  test("finds the original backup on a grown image with a corrupt primary", () => {
    const path = fixture("grown"); truncateSync(path, sectors * 1024); corrupt(path, 528);
    const result = recovery(path);
    expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
    expect(must([checker, path, manifest, join(root, "unused-grown.bin"), ""])).toBe("clean");
    expect(hashes(path)).toEqual(payloads);
  });
  test("real GPT writers follow the held descriptor after its pathname is replaced", () => {
    for (const replacement of ["node", "symlink"]) {
      const path = fixture(`held-${replacement}`), held = `${path}.held`, substitute = `${path}.substitute`;
      copyFileSync(base, substitute);
      const before = readFileSync(substitute);
      const result = run(["bash", "-c", `
set -e
exec 9<>"$1"
mv "$1" "$2"
if [ "$4" = node ]; then cp "$3" "$1"; else ln -s "$3" "$1"; fi
sgdisk --randomize-guids /proc/self/fd/9
sfdisk --no-reread --no-tell-kernel --relocate gpt-bak-std /proc/self/fd/9
sfdisk --part-uuid /proc/self/fd/9 4 44444444-4444-4444-8444-444444444444
exec 9>&-
`, "held-descriptor-test", path, held, substitute, replacement]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(path)).toEqual(before);
      expect(readFileSync(substitute)).toEqual(before);
      expect(bytes(held, 568, 16)).not.toEqual(bytes(base, 568, 16));
      expect(must(["sfdisk", "--part-uuid", held, "4"])).toBe("44444444-4444-4444-8444-444444444444");
      expect(hashes(held)).toEqual(payloads);
    }
  }, 30_000);
});
