import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ais-boot-identity-"));
const hook = readFileSync("image/archiso/airootfs/etc/initcpio/hooks/ais_persist", "utf8");
const uuid = "22222222-2222-4222-8222-222222222222";
function fn(name: string) { const at = hook.indexOf(`${name}() {`); return hook.slice(at, hook.indexOf("\n}\n", at) + 3); }
function boot(efi: boolean, cmdline: string) {
  const dir = mkdtempSync(join(root, "boot-"));
  if (efi) mkdirSync(join(dir, "efi"));
  writeFileSync(join(dir, "cmdline"), cmdline);
  const script = `${fn("_persist_uuid_valid")}\n${fn("_persist_boot_identity").replaceAll("/proc/cmdline", join(dir, "cmdline")).replaceAll("/sys/firmware/efi", join(dir, "efi"))}
_persist_boot_identity || exit 1
printf '%s' "$PERSIST_BOOT_PARTUUID"
`;
  return Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
}
test("UEFI requires one valid firmware PARTUUID; BIOS accepts its documented absence", () => {
  expect(boot(true, `quiet ais.boot_partuuid=${uuid}`).stdout.toString()).toBe(uuid);
  expect(boot(true, "quiet").exitCode).not.toBe(0);
  expect(boot(true, "ais.boot_partuuid=invalid").exitCode).not.toBe(0);
  expect(boot(true, `ais.boot_partuuid=${uuid} ais.boot_partuuid=${uuid}`).exitCode).not.toBe(0);
  expect(boot(false, "quiet").exitCode).toBe(0);
  expect(boot(false, `ais.boot_partuuid=${uuid}`).stdout.toString()).toBe(uuid);
  expect(hook).toContain("# shortcut: BIOS cannot identify the firmware's boot partition.");
});
test("every mode settles for five seconds and rescans the image-disk candidate set", () => {
  for (const [before, after, ok] of [["73", "73", true], ["73", "73 74", false], ["73", "74", false], ["73", "", false], ["73 74", "73", false]] as const) {
    const dir = mkdtempSync(join(root, "settle-")), log = join(dir, "events");
    const script = `${fn("_persist_stable_media")}
udevadm() { printf 'settle\\n' >>'$LOG'; }
sleep() { [ "$1" = 5 ] || exit 90; printf 'wait:5\\n' >>'$LOG'; }
scans=0
_persist_reject_ambiguous_media() {
  scans=$((scans+1)); printf 'scan:%s\\n' "$scans" >>'$LOG'
  if [ "$scans" = 1 ]; then PERSIST_CANDIDATES='$BEFORE'; else PERSIST_CANDIDATES='$AFTER'; fi
  [ "$PERSIST_CANDIDATES" = "$1" ]
}
PERSIST_DISKSEQ=73
_persist_stable_media
`.replaceAll("$LOG", log).replaceAll("$BEFORE", before).replaceAll("$AFTER", after);
    const result = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode === 0, `${before} -> ${after}`).toBe(ok);
    const events = readFileSync(log, "utf8");
    if (before === "73") expect(events).toBe("settle\nscan:1\nwait:5\nsettle\nscan:2\n");
    else expect(events).toBe("settle\nscan:1\n");
  }
  // The mode-independent late hook resolves the disk before any GPT repair.
  expect(fn("run_latehook").indexOf("_persist_find_device")).toBeLessThan(fn("run_latehook").indexOf("_persist_repair_gpt"));
});
test("GRUB probes the partition it loaded from and passes its UUID in every menu entry", () => {
  const loader = readFileSync("image/archiso/efiboot/grub.cfg", "utf8");
  const menu = readFileSync("image/archiso/grub/raw.cfg", "utf8");
  expect(loader).toContain('"$cmdpath"');
  expect(loader).toContain("probe --set=ais_boot_partuuid --part-uuid ($root)");
  expect(loader).not.toContain("search --");
  expect(menu.match(/ais\.boot_partuuid=\$\{ais_boot_partuuid\}/g)).toHaveLength(3);
  const modules = readFileSync("image/build/assemble.sh", "utf8");
  expect(modules).toContain("part_gpt fat probe regexp");
});
