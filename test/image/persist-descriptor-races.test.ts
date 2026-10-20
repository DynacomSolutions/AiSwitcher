import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ais-fd-races-"));
const source = readFileSync("image/archiso/airootfs/etc/initcpio/hooks/ais_persist", "utf8");
const functions = ["_persist_find_device", "_persist_check_diskseq", "_persist_write", "_persist_refresh_part_node", "_persist_validate_node", "_persist_pin_mapper", "_persist_mount"];
const sys = join(root, "sys"), nodes = join(root, "nodes"), dev = join(root, "dev");
for (const dir of [nodes, dev, `${sys}/disk/part5`, `${sys}/disk/part3`, `${sys}/mapper/dm`, `${sys}/mapper/slaves`]) mkdirSync(dir, { recursive: true });
for (const [path, value] of Object.entries({
  "disk/dev": "8:0", "disk/diskseq": "73", "disk/part3/partition": "3",
  "disk/part5/partition": "5", "disk/part5/dev": "8:5", "disk/part5/start": "24576", "disk/part5/size": "28638", "mapper/dm/name": "ais-persist",
})) writeFileSync(join(sys, path), `${value}\n`);
for (const [name, target] of [["8:0", "disk"], ["8:3", "disk/part3"], ["8:5", "disk/part5"], ["253:0", "mapper"]]) symlinkSync(join(sys, target!), join(dev, name!));
symlinkSync(`${sys}/disk/part5`, `${sys}/mapper/slaves/part5`);
for (const kind of ["disk", "part", "mapper"]) {
  writeFileSync(join(root, `${kind}-original`), `SYNTHETIC_FIXTURE_${kind}_original`);
  writeFileSync(join(root, `${kind}-substitute`), `SYNTHETIC_FIXTURE_${kind}_substitute`);
}
let production = functions.map(name => {
  const at = source.indexOf(`${name}() {`);
  return source.slice(at, source.indexOf("\n}\n", at) + 3);
}).join("\n").replaceAll("/sys/dev/block", dev).replaceAll("/dev/block", nodes)
  .replaceAll("/dev/mapper/ais-persist", `${nodes}/mapper`)
  .replaceAll('[ -b "$candidate" ]', '[ -e "$candidate" ]').replaceAll('[ -b "$PERSIST_DISK" ]', '[ -e "$PERSIST_DISK" ]')
  .replaceAll('[ -b "$disk_real" ]', '[ -e "$disk_real" ]').replaceAll('[ -b "$node_real" ]', '[ -e "$node_real" ]')
  .replaceAll('[ -b "$PERSIST_MAPPER" ]', '[ -e "$PERSIST_MAPPER" ]');
// Instrument the actual opens as well as every external observation and write.
// No production identity check is replaced: only block-device syscalls are
// represented by regular-file inodes and a synthetic sysfs tree, without root.
production = production.replace('exec 9<>"$candidate" || return 1', 'checkpoint before-open-9; exec 9<>"$candidate" || return 1; checkpoint after-open-9')
  .replace(`exec 8<>"${nodes}/$dev" || return 1`, `checkpoint before-open-8; exec 8<>"${nodes}/$dev" || return 1; checkpoint after-open-8`)
  .replace(`exec 5<>${nodes}/mapper || return 1`, `checkpoint before-open-5; exec 5<>${nodes}/mapper || return 1; checkpoint after-open-5`);
const script = join(root, "race.sh");
writeFileSync(script, `#!/bin/bash
root=$1 inject=$2 mode=$3
printf '0\\n' >"$root/count"
: >"$root/events"; : >"$root/writes"; : >"$root/foreign"; : >"$root/injected"
ln -sfn "$root/disk-original" "$root/nodes/8:0"
ln -sfn "$root/part-original" "$root/nodes/8:5"
ln -sfn "$root/mapper-original" "$root/nodes/mapper"
printf '73\\n' >"$root/sys/disk/diskseq"
checkpoint() {
  local n
  read -r n <"$root/count"; n=$((n+1)); printf '%s\\n' "$n" >"$root/count"
  printf '%s\\n' "$1" >>"$root/events"
  if [ "$n" = "$inject" ]; then
    printf '%s\\n' "$n" >"$root/injected"
    for pair in 'disk 8:0' 'part 8:5' 'mapper mapper'; do
      set -- $pair
      if [ "$mode" = symlink ]; then
        ln -sfn "$root/$1-substitute" "$root/nodes/$2"
      else
        # Replacing the node inode, rather than just retargeting its alias.
        ln -f "$root/$1-substitute" "$root/replacement"
        mv -f "$root/replacement" "$root/nodes/$2"
      fi
    done
  fi
}
stat() {
  checkpoint stat
  local major minor
  if [ "$3" -ef "$root/disk-original" ]; then major=8; minor=0
  elif [ "$3" -ef "$root/part-original" ]; then major=8; minor=5
  elif [ "$3" -ef "$root/mapper-original" ]; then major=253; minor=0
  else major=8; minor=16; fi
  case "$2" in '%t:%T') printf '%x:%x\\n' "$major" "$minor";; '%t') printf '%x\\n' "$major";; '%T') printf '%x\\n' "$minor";; *) return 1;; esac
}
readlink() { checkpoint readlink; command readlink "$@"; }
cat() { checkpoint cat; command cat "$@"; }
findmnt() { checkpoint mounted-dev; printf '8:3\\n'; }
udevadm() { checkpoint udev; }
_persist_stable_media() { checkpoint stable-scan; }
_persist_boot_identity() { checkpoint firmware-identity; }
writer() {
  local name=$1 target=$2 kind=$3
  checkpoint "$name-open-for-write"
  printf '%s %s\\n' "$name" "$target" >>"$root/writes"
  if ! [ "$target" -ef "$root/$kind-original" ]; then
    printf '%s %s\\n' "$name" "$target" >>"$root/foreign"; return 90
  fi
}
sfdisk() {
  if [ "$1" = --part-uuid ]; then checkpoint partuuid; [ "$2" = /proc/self/fd/9 ] && printf '55555555-5555-4555-8555-555555555555\\n'
  else writer "$1" "$2" disk; fi
}
sgdisk() { writer "$1" "$2" disk; }
partx() { writer partx "$1" disk; }
cryptsetup() { writer "$1" "$2" part; }
mkfs.btrfs() { writer mkfs "$1" mapper; }
mkdir() { :; }
chmod() { :; }
mount() { [ "$1" = --no-canonicalize ] || return 1; writer mount "$6" mapper; }
${production}
_persist_find_device || exit 1
_persist_write sgdisk repair "$PERSIST_DISK" || exit 1
_persist_write sgdisk randomise "$PERSIST_DISK" || exit 1
_persist_find_device || exit 1
_persist_write sfdisk relocate "$PERSIST_DISK" || exit 1
_persist_write sfdisk create-partition "$PERSIST_DISK" || exit 1
_persist_write partx "$PERSIST_DISK" || exit 1
PERSIST_GPT_DUMP='part\t5\t24576\t28638\t0fc63daf-8483-4772-8e79-3d69d8477de4\t55555555-5555-4555-8555-555555555555\tAISPERSIST\t-'
_persist_refresh_part_node 5 || exit 1
_persist_write cryptsetup luksFormat "$PERSIST_RESOLVED_PART" || exit 1
_persist_refresh_part_node 5 || exit 1
_persist_write cryptsetup open "$PERSIST_RESOLVED_PART" || exit 1
_persist_pin_mapper || exit 1
_persist_write mkfs.btrfs "$PERSIST_MAPPER" || exit 1
_persist_mount || exit 1
_persist_refresh_part_node 5 && _persist_pin_mapper && _persist_check_diskseq || exit 1
checkpoint verified
exec 5>&- 8>&- 9>&-
`);
const run = (step: number, mode: string) => Bun.spawnSync(["bash", script, root, String(step), mode], { stdout: "pipe", stderr: "pipe" });

test("substitution between every pair of I/O steps never sends a write request to another disk, partition or mapper", () => {
  const baseline = run(0, "symlink");
  expect(baseline.exitCode, baseline.stderr.toString()).toBe(0);
  const events = readFileSync(join(root, "events"), "utf8").trim().split("\n");
  const writes = readFileSync(join(root, "writes"), "utf8");
  expect(events).toContain("before-open-9"); expect(events).toContain("after-open-8"); expect(events).toContain("after-open-5");
  expect(writes.trim().split("\n")).toHaveLength(9);
  expect(writes).toContain("luksFormat /proc/self/fd/8"); expect(writes).toContain("mkfs /proc/self/fd/5");
  expect(writes).toContain("mount /proc/self/fd/5");
  for (const mode of ["symlink", "node"]) {
    // Replay each boundary, including inside stat/sysfs checks, immediately
    // before each descriptor open and after the final check before a write.
    for (let step = 1; step < events.length; step++) {
      run(step, mode);
      expect(readFileSync(join(root, "injected"), "utf8").trim(), `${mode} boundary ${step}: ${events[step - 1]}`).toBe(String(step));
      expect(readFileSync(join(root, "foreign"), "utf8"), `${mode} boundary ${step}`).toBe("");
    }
  }
}, 300_000);

test("write guards check diskseq both before and after successful or failed requests", () => {
  const at = source.indexOf("_persist_write() {");
  const fn = source.slice(at, source.indexOf("\n}\n", at) + 3);
  for (const [before, after, writer, expected, calls] of [[1, 0, 0, 1, "check\n"], [0, 1, 0, 1, "check\nwrite\ncheck\n"], [0, 0, 7, 7, "check\nwrite\ncheck\n"], [0, 0, 0, 0, "check\nwrite\ncheck\n"]] as const) {
    const result = Bun.spawnSync(["bash", "-c", `${fn}
n=0
_persist_check_diskseq() { echo check; n=$((n+1)); if [ "$n" = 1 ]; then return ${before}; else return ${after}; fi; }
writer() { echo write; return ${writer}; }
_persist_write writer
`], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(expected); expect(result.stdout.toString()).toBe(calls);
  }
});
