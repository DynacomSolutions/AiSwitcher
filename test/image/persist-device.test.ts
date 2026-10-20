import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const scratch = mkdtempSync(join(tmpdir(), "ais-live-persist-test-"));
const hookSource = readFileSync(resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist"), "utf8");
const generator = resolve("image/archiso/persist-contracts.sh");
const type = ["21686148-6449-6e6f-744e-656564454649", "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", "0fc63daf-8483-4772-8e79-3d69d8477de4", "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"];
const guids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const names = ["BIOS", "AISBOOT", "AISBASE", "AISX"];
const starts = ["2048", "4096", "32768", "196608"];
const sizes = ["2048", "28672", "163840", "32768"];

function fixture(name: string, options: { extra?: string; rows?: { starts?: string[]; sizes?: string[]; names?: string[] } } = {}) {
  const dir = join(scratch, `device-${name}`);
  mkdirSync(dir, { recursive: true });
  const disk = join(dir, "disk.img");
  Bun.spawnSync(["truncate", "-s", "192M", disk]);
  const ss = options.rows?.starts ?? starts;
  const sz = options.rows?.sizes ?? sizes;
  const ns = options.rows?.names ?? names;
  const rows = ns.map((n, i) => `start=${ss[i]}, size=${sz[i]}, type=${type[i]}, uuid=${guids[i]}, name="${n}"${i === 1 ? ', attrs="LegacyBIOSBootable"' : ""}`).join("\n");
  const input = join(dir, "table.txt");
  writeFileSync(input, `label: gpt\nunit: sectors\nsector-size: 512\n\n${rows}${options.extra ?? ""}\n`);
  const written = Bun.spawnSync(["bash", "-c", `sfdisk '${disk}' < '${input}'`], { stdout: "pipe", stderr: "pipe" });
  if (written.exitCode !== 0) throw new Error(written.stderr.toString());
  const manifest = join(dir, "gpt-layout");
  const dump = join(dir, "gpt.json");
  const generated = Bun.spawnSync(["bash", generator, "gpt-layout", disk, manifest, dump], { stdout: "pipe", stderr: "pipe" });
  return { dir, disk, manifest, dump, generated, ss, sz, ns };
}

function sliceHash(disk: string, start: number, size: number) {
  const bytes = Bun.spawnSync(["dd", `if=${disk}`, "bs=512", `skip=${start}`, `count=${size}`, "status=none"], { stdout: "pipe" }).stdout;
  return createHash("sha256").update(bytes).digest("hex");
}

function imageHash(disk: string) {
  return Bun.spawnSync(["sha256sum", disk], { stdout: "pipe" }).stdout.toString().split(/\s+/)[0];
}

function ambiguityHarness(name: string, disks: Array<{ seq: string; fixture: ReturnType<typeof fixture>; label?: string; fstype?: string }>) {
  const dir = join(scratch, `ambiguity-${name}`);
  const bin = join(dir, "bin");
  const sysblock = join(dir, "sys-block");
  const devices = join(dir, "devices");
  const bySeq = join(dir, "block-nodes");
  const devBlock = join(dir, "dev-block");
  const bootmnt = join(dir, "bootmnt");
  mkdirSync(bin, { recursive: true });
  mkdirSync(sysblock, { recursive: true });
  mkdirSync(devices, { recursive: true });
  mkdirSync(bySeq, { recursive: true });
  mkdirSync(devBlock, { recursive: true });
  mkdirSync(join(bootmnt, "ais-live"), { recursive: true });
  writeFileSync(join(bootmnt, "ais-live", "gpt-layout"), readFileSync(disks[0].fixture.manifest));
  const aliases: string[] = [];
  for (const [index, item] of disks.entries()) {
    const sysdir = join(sysblock, `sd${String.fromCharCode(97 + index)}`);
    mkdirSync(sysdir, { recursive: true });
    writeFileSync(join(sysdir, "diskseq"), `${item.seq}\n`);
    writeFileSync(join(sysdir, "dev"), `8:${index * 16}\n`);
    mkdirSync(join(sysdir, "device"), { recursive: true });
    Bun.spawnSync(["ln", "-sfn", sysdir, join(devBlock, `8:${index * 16}`)]);
    const diskAlias = join(bySeq, `8:${index * 16}`);
    Bun.spawnSync(["ln", "-sfn", item.fixture.disk, diskAlias]);
    aliases.push(diskAlias);
    for (let partition = 1; partition <= 4; partition++) {
      const node = join(devices, `disk-${item.seq}-part${partition}`);
      writeFileSync(node, "SYNTHETIC_FIXTURE_partition-node");
      Bun.spawnSync(["ln", "-sfn", node, join(bySeq, `8:${index * 16 + partition}`)]);
      const child = join(sysdir, `sd${String.fromCharCode(97 + index)}${partition}`);
      mkdirSync(child, { recursive: true });
      writeFileSync(join(child, "partition"), `${partition}\n`);
      writeFileSync(join(child, "dev"), `8:${index * 16 + partition}\n`);
      Bun.spawnSync(["ln", "-sfn", child, join(devBlock, `8:${index * 16 + partition}`)]);
    }
  }
  const source = join(bySeq, "8:3");
  writeFileSync(join(bin, "findmnt"), `#!/bin/sh\nprintf '%s\\n' '${source}'\n`);
  const statCases = disks.map((item, index) => [
    `    '${bySeq}/8:${index * 16}') printf '8:${(index * 16).toString(16)}\\n' ;;`,
    ...[1, 2, 3, 4].map((partition) => `    '${bySeq}/8:${index * 16 + partition}') printf '8:${(index * 16 + partition).toString(16)}\\n' ;;`),
  ].join("\n")).join("\n");
  writeFileSync(join(bin, "stat"), `#!/bin/sh\n[ "$1" = -Lc ] && [ "$2" = '%t:%T' ] || exec /usr/bin/stat "$@"\ncase "$3" in\n${statCases}\n    *) exit 1 ;;\nesac\n`);
  writeFileSync(join(bin, "blkid"), `#!/bin/sh\nflag= node=\nwhile [ "$#" -gt 0 ]; do case "$1" in -s) flag=$2; shift 2;; -o) shift 2;; -p|-c) shift;; *) node=$1; shift;; esac; done\ncase "$flag:$node" in\n  LABEL:*:1[6-9]|LABEL:*:20) value='${disks[1]?.label ?? ""}' ;;\n  LABEL:*) value=AISBASE ;;\n  TYPE:*:1[6-9]|TYPE:*:20) value='${disks[1]?.fstype ?? (disks[1]?.label === "AISBASE" ? "ext4" : "")}' ;;\n  TYPE:*) value=vfat ;;\n  *) exit 3 ;;\nesac\n[ -n "$value" ] || exit 2\nprintf '%s\\n' "$value"\n`);
  writeFileSync(join(bin, "mount"), `#!/bin/sh\ntarget=\nfor arg do target=$arg; done\nmkdir -p "$target/ais-live"\ncp '${disks[1]?.fixture.manifest}' "$target/ais-live/gpt-layout"\n`);
  writeFileSync(join(bin, "umount"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "sfdisk"), `#!/bin/sh\nexec /usr/bin/sfdisk "$@"\n`);
  for (const executable of ["findmnt", "stat", "blkid", "mount", "umount", "sfdisk"]) chmodSync(join(bin, executable), 0o755);

  let sourceText = hookSource
    .replaceAll("/run/archiso/bootmnt", bootmnt)
    .replaceAll("/run/ais-persist-ambiguity-probe", join(dir, "probe"))
    .replaceAll("/sys/block/*", `${sysblock}/*`)
    .replaceAll("/sys/dev/block", devBlock)
    .replaceAll("/dev/block", bySeq)
    .replaceAll('[ -b "$part" ]', '[ -e "$part" ]')
    .replaceAll('[ -b "$PERSIST_PROBE_DISK" ]', '[ -e "$PERSIST_PROBE_DISK" ]');
  const start = sourceText.indexOf("_persist_reject_ambiguous_media() {");
  const end = sourceText.indexOf("\n}\n", start) + 3;
  sourceText = sourceText.slice(start, end);
  const script = join(dir, "ambiguity.sh");
  writeFileSync(script, `${sourceText}\n_persist_reject_ambiguous_media '${disks[0].seq}'\n`);
  return { result: Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" }), aliases };
}

function validateNode(f: ReturnType<typeof fixture>, changes: Record<string, string> = {}) {
  const dir = join(f.dir, `validate-${Math.random().toString(16).slice(2)}`);
  const bin = join(dir, "bin");
  const sysdev = join(dir, "sysfs", "disk", "part3");
  mkdirSync(bin, { recursive: true });
  mkdirSync(sysdev, { recursive: true });
  const parent = join(dir, "sysfs", "disk");
  writeFileSync(join(sysdev, "partition"), `${changes.partition ?? "3"}\n`);
  writeFileSync(join(sysdev, "start"), `${changes.start ?? starts[2]}\n`);
  writeFileSync(join(sysdev, "size"), `${changes.size ?? sizes[2]}\n`);
  writeFileSync(join(parent, "dev"), `${changes.parent ?? "8:0"}\n`);
  writeFileSync(join(parent, "diskseq"), `${changes.diskseq ?? "73"}\n`);
  const diskNode = join(dir, "disk-node");
  const partNode = join(dir, "part-node");
  writeFileSync(diskNode, "SYNTHETIC_FIXTURE_disk-node");
  writeFileSync(partNode, "SYNTHETIC_FIXTURE_part-node");
  const diskAlias = join(dir, "by-diskseq-73");
  const partAlias = join(dir, "by-partuuid", changes.aliasUuid ?? guids[2]);
  mkdirSync(join(dir, "by-partuuid"), { recursive: true });
  Bun.spawnSync(["ln", "-sfn", diskNode, diskAlias]);
  Bun.spawnSync(["ln", "-sfn", partNode, partAlias]);
  const expectedNode = join(dir, "by-partuuid", guids[2]);
  const expectedDisk = diskAlias;
  writeFileSync(join(bin, "readlink"), `#!/bin/sh\ncase "$2" in '${expectedDisk}') printf '%s\\n' '${diskNode}' ;; '${expectedNode}') [ '${existsSync(join(dir, "by-partuuid", guids[2]))}' = true ] || exit 1; printf '%s\\n' '${partNode}' ;; /sys/dev/block/8:5) printf '%s\\n' '${sysdev}' ;; *) exec /usr/bin/readlink "$@" ;; esac\n`);
  writeFileSync(join(bin, "stat"), `#!/bin/sh\npath=$(/usr/bin/readlink -f "$3") || exit 1\ncase "$2:$path" in %t:${diskNode}) printf '8\\n' ;; %T:${diskNode}) printf '0\\n' ;; %t:${partNode}) printf '8\\n' ;; %T:${partNode}) printf '5\\n' ;; *) exit 1 ;; esac\n`);
  writeFileSync(join(bin, "sfdisk"), `#!/bin/sh\n[ "$1" = --part-uuid ] && [ "$2" = '${expectedDisk}' ] && [ "$3" = 3 ] || exit 9\nprintf '%s\\n' '${changes.uuid ?? guids[2]}'\n`);
  for (const executable of ["readlink", "stat", "sfdisk"]) chmodSync(join(bin, executable), 0o755);
  const fnStart = hookSource.indexOf("_persist_validate_node() {");
  const fnEnd = hookSource.indexOf("\n}\n", fnStart) + 3;
  const functionSource = hookSource.slice(fnStart, fnEnd).replaceAll('[ -b "$disk_real" ]', '[ -e "$disk_real" ]').replaceAll('[ -b "$node_real" ]', '[ -e "$node_real" ]');
  const script = join(dir, "validate.sh");
  writeFileSync(script, `${functionSource}\nPERSIST_DISK='${expectedDisk}'\nPERSIST_DISKSEQ='${changes.expectedDiskseq ?? "73"}'\nPERSIST_DISK_DEV='${changes.expectedDev ?? "8:0"}'\nPERSIST_DISK_SYSFS='${changes.expectedSysfs ?? parent}'\n_persist_validate_node '${expectedNode}' 3 '${guids[2]}' '${starts[2]}' '${sizes[2]}'\n`);
  return Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
}

function verifyGpt(f: ReturnType<typeof fixture>, manifestPath = f.manifest, changedUuid = "") {
  const dir = join(f.dir, `verify-${Math.random().toString(16).slice(2)}`);
  const bin = join(dir, "bin");
  const aliases = join(dir, "by-diskseq");
  mkdirSync(bin, { recursive: true });
  mkdirSync(aliases, { recursive: true });
  const bootPart = join(aliases, "73-part3");
  const p4Alias = join(dir, "by-partuuid", guids[3]);
  mkdirSync(join(dir, "by-partuuid"), { recursive: true });
  writeFileSync(join(dir, "p3-node"), "SYNTHETIC_FIXTURE_boot-partition");
  writeFileSync(join(dir, "p4-node"), "SYNTHETIC_FIXTURE_exchange-partition");
  Bun.spawnSync(["ln", "-sfn", join(dir, "p3-node"), bootPart]);
  Bun.spawnSync(["ln", "-sfn", join(dir, "p4-node"), p4Alias]);
  const manifest = join(dir, "gpt-layout");
  writeFileSync(manifest, readFileSync(manifestPath));
  const fn = (name: string) => {
    const start = hookSource.indexOf(`${name}() {`);
    const end = hookSource.indexOf("\n}\n", start) + 3;
    return hookSource.slice(start, end);
  };
  const verify = fn("_persist_verify_gpt")
    .replaceAll("/run/archiso/bootmnt/ais-live/gpt-layout", manifest)
    .replaceAll("/dev/disk/by-diskseq", aliases)
    .replaceAll("/dev/disk/by-partuuid", join(dir, "by-partuuid"))
    .replaceAll('[ -b "$boot_part_real" ]', '[ -e "$boot_part_real" ]');
  const blkid = join(bin, "blkid");
  writeFileSync(blkid, `#!/bin/sh\n[ "$1" = -p ] && [ "$2" = -c ] && [ "$3" = /dev/null ] && [ "$4" = -s ] && [ "$5" = PART_ENTRY_UUID ] && [ "$6" = -o ] && [ "$7" = value ] && [ "$8" = '${bootPart}' ] || exit 9\nprintf '%s\\n' '${changedUuid || guids[2]}'\n`);
  const blockdev = join(bin, "blockdev");
  writeFileSync(blockdev, `#!/bin/sh\n[ "$1" = --getsz ] && [ "$2" = '${f.disk}' ] || exit 9\nprintf '393216\\n'\n`);
  const findmnt = join(bin, "findmnt");
  writeFileSync(findmnt, `#!/bin/sh\nprintf '8:3\\n'\n`);
  const stat = join(bin, "stat");
  writeFileSync(stat, `#!/bin/sh\n[ "$3" = '${bootPart}' ] && printf '8:3\\n'\n`);
  for (const executable of [blkid, blockdev, findmnt, stat]) chmodSync(executable, 0o755);
  const script = join(dir, "verify.sh");
  writeFileSync(script, `${fn("_persist_uuid_valid")}\n${fn("_persist_decimal_valid")}\n_persist_check_diskseq(){ return 0; }\n_persist_validate_node(){ return 0; }\n_persist_refresh_part_node(){ case $1 in 3) PERSIST_RESOLVED_PART='${bootPart}';; 4) PERSIST_RESOLVED_PART='${p4Alias}';; *) return 1;; esac; }\n_persist_no_part5(){ return 0; }\n${verify}\nPERSIST_DISK='${f.disk}'\nPERSIST_DISKSEQ=73\nPERSIST_DISK_DEV=8:0\nPERSIST_DISK_SYSFS=/sys/devices/fixture\nPERSIST_ALLOW_P5_NODE_MISSING=0\nPERSIST_BOOT_PARTUUID='${changedUuid || guids[1]}'\n_persist_verify_gpt\n`);
  return Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
}

type CreateMutation = "none" | "diskseq" | "partuuid" | "stale-p5" | "existing-p5-no-node" | "bad-p5-guid" | "bad-p5-extent" | "bad-p5-name" | "corrupt-primary" | "corrupt-backup";

function createTransition(name: string, mutation: CreateMutation = "none") {
  const p5Entries: Partial<Record<CreateMutation, string>> = {
    "existing-p5-no-node": '\nstart=229376, size=163807, type=0fc63daf-8483-4772-8e79-3d69d8477de4, uuid=55555555-5555-4555-8555-555555555555, name="AISPERSIST"',
    "bad-p5-guid": '\nstart=229376, size=163807, type=0fc63daf-8483-4772-8e79-3d69d8477de4, uuid=44444444-4444-4444-8444-444444444444, name="AISPERSIST"',
    "bad-p5-extent": '\nstart=229377, size=163806, type=0fc63daf-8483-4772-8e79-3d69d8477de4, uuid=55555555-5555-4555-8555-555555555555, name="AISPERSIST"',
    "bad-p5-name": '\nstart=229376, size=163807, type=0fc63daf-8483-4772-8e79-3d69d8477de4, uuid=55555555-5555-4555-8555-555555555555, name="unexpected"',
  };
  const f = fixture(`create-${name}`, { extra: p5Entries[mutation] ?? "" });
  const manifestFixture = p5Entries[mutation] ? fixture(`create-manifest-${name}`) : f;
  const randomizedDiskGuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const randomizedParts = [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
  ];
  Bun.spawnSync(["sfdisk", "--disk-id", f.disk, randomizedDiskGuid]);
  randomizedParts.forEach((uuid, index) => Bun.spawnSync(["sfdisk", "--part-uuid", f.disk, String(index + 1), uuid]));
  const contract = manifestFixture.manifest;
  const sourceHashes = starts.map((start, index) => sliceHash(f.disk, Number(start), Number(sizes[index])));

  const dir = join(f.dir, `transition-${mutation}`);
  const bin = join(dir, "bin");
  const bySeq = join(dir, "by-diskseq");
  const byPart = join(dir, "by-partuuid");
  const devBlock = join(dir, "dev-block");
  const blockNodes = join(dir, "block-nodes");
  const sysRoot = join(dir, "sys-block");
  const sysdir = join(sysRoot, "sda");
  const partNodes = join(dir, "part-nodes");
  const mapper = join(dir, "mapper");
  const bootmnt = join(dir, "bootmnt");
  const consolePath = join(dir, "console");
  const uuidFile = join(dir, "uuid");
  const log = join(dir, "format.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(bySeq, { recursive: true });
  mkdirSync(byPart, { recursive: true });
  mkdirSync(devBlock, { recursive: true });
  mkdirSync(blockNodes, { recursive: true });
  mkdirSync(partNodes, { recursive: true });
  mkdirSync(sysdir, { recursive: true });
  mkdirSync(join(bootmnt, "ais-live"), { recursive: true });
  writeFileSync(join(bootmnt, "ais-live", "gpt-layout"), readFileSync(contract));
  writeFileSync(consolePath, "");
  writeFileSync(uuidFile, "cccccccc-cccc-4ccc-8ccc-cccccccccccc\n");
  writeFileSync(join(sysdir, "diskseq"), "73\n");
  writeFileSync(join(sysdir, "dev"), "8:0\n");
  const dm = join(sysRoot, "dm-0");
  mkdirSync(join(dm, "dm"), { recursive: true });
  mkdirSync(join(dm, "slaves"));
  writeFileSync(join(dm, "dm/name"), "ais-persist\n");
  writeFileSync(mapper, "SYNTHETIC_FIXTURE_mapper");
  Bun.spawnSync(["ln", "-sfn", dm, join(devBlock, "253:0")]);
  Bun.spawnSync(["ln", "-sfn", join(sysdir, "sda5"), join(dm, "slaves/sda5")]);
  const diskAlias = join(bySeq, "73");
  Bun.spawnSync(["ln", "-sfn", f.disk, diskAlias]);
  Bun.spawnSync(["ln", "-sfn", f.disk, join(blockNodes, "8:0")]);
  Bun.spawnSync(["ln", "-sfn", sysdir, join(devBlock, "8:0")]);
  const partStart = [...starts];
  const partSize = [...sizes];
  for (let partition = 1; partition <= 4; partition++) {
    const node = join(partNodes, `part${partition}`);
    writeFileSync(node, `SYNTHETIC_FIXTURE_part${partition}`);
    const child = join(sysdir, `sda${partition}`);
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "partition"), `${partition}\n`);
    writeFileSync(join(child, "dev"), `8:${partition}\n`);
    writeFileSync(join(child, "start"), `${partStart[partition - 1]}\n`);
    writeFileSync(join(child, "size"), `${partSize[partition - 1]}\n`);
    Bun.spawnSync(["ln", "-sfn", child, join(devBlock, `8:${partition}`)]);
    Bun.spawnSync(["ln", "-sfn", node, `${diskAlias}-part${partition}`]);
    Bun.spawnSync(["ln", "-sfn", node, join(blockNodes, `8:${partition}`)]);
    Bun.spawnSync(["ln", "-sfn", node, join(byPart, randomizedParts[partition - 1])]);
  }
  if (mutation === "stale-p5") {
    mkdirSync(join(sysdir, "sda5"));
    writeFileSync(join(sysdir, "sda5", "partition"), "5\n");
    const stale = join(partNodes, "stale-part5");
    writeFileSync(stale, "SYNTHETIC_FIXTURE_stale_partition_node");
    Bun.spawnSync(["ln", "-sfn", stale, `${diskAlias}-part5`]);
  }
  if (mutation === "corrupt-primary" || mutation === "corrupt-backup") {
    const sector = mutation === "corrupt-primary" ? 1 : 393215;
    const corrupt = Bun.spawnSync(["bash", "-c", `printf '\\132' | dd of='${f.disk}' bs=1 seek=${sector * 512 + 16} conv=notrunc status=none`]);
    if (corrupt.exitCode !== 0) throw new Error(`Could not corrupt GPT fixture: ${corrupt.stderr.toString()}`);
  }
  const wholeImageBefore = imageHash(f.disk);
  const sfdisk = join(bin, "sfdisk");
  // After the real sfdisk write, publish the new UUID alias and its exact geometry.
  const sfdiskAdapter = `#!/bin/sh
/usr/bin/sfdisk "$@" || exit $?
case " $* " in *" -N 5 "*)
  uuid=$(printf '%s\\n' "$PERSIST_EXPECTED_P5_UUID")
  start=$(printf '%s\\n' "$PERSIST_EXPECTED_P5_START")
  size=$(printf '%s\\n' "$PERSIST_EXPECTED_P5_SIZE")
  node='${join(partNodes, "part5")}'
  mkdir -p '${join(sysdir, "sda5")}'
  printf '5\\n' >'${join(sysdir, "sda5", "partition")}'
  printf '8:5\\n' >'${join(sysdir, "sda5", "dev")}'
  printf '%s\\n' "$start" >'${join(sysdir, "sda5", "start")}'
  printf '%s\\n' "$size" >'${join(sysdir, "sda5", "size")}'
  printf 'SYNTHETIC_FIXTURE_part5\\n' >"$node"
  ln -sfn '${join(sysdir, "sda5")}' '${join(devBlock, "8:5")}'
  ln -sfn "$node" '${join(bySeq, "73-part5")}'
  ln -sfn "$node" "${byPart}/$uuid"
  ln -sfn "$node" '${join(blockNodes, "8:5")}'
  ;;
esac
`;
  writeFileSync(sfdisk, sfdiskAdapter);
  const stat = join(bin, "stat");
  writeFileSync(stat, `#!/bin/sh
if [ "$1" = -Lc ]; then
  format=$2
  path=$(readlink -f "$3") || exit 1
  major=8
  case "$path" in
    '${f.disk}') minor=0 ;;
    '${mapper}') major=253; minor=0 ;;
    '${join(partNodes, "part1")}') minor=1 ;;
    '${join(partNodes, "part2")}') minor=2 ;;
    '${join(partNodes, "part3")}') minor=3 ;;
    '${join(partNodes, "part4")}') minor=4 ;;
    '${join(partNodes, "part5")}') minor=5 ;;
    *) exit 1 ;;
  esac
  case "$format" in
    '%t:%T') printf '%x:%x\\n' "$major" "$minor" ;;
    '%t') printf '8\\n' ;;
    '%T') printf '%x\\n' "$minor" ;;
    *) exit 1 ;;
  esac
else
  exec /usr/bin/stat "$@"
fi
`);
  const blkid = join(bin, "blkid");
  writeFileSync(blkid, `#!/bin/sh
[ "$1" = -p ] && [ "$2" = -c ] && [ "$3" = /dev/null ] && [ "$4" = -s ] && [ "$5" = PART_ENTRY_UUID ] && [ "$6" = -o ] && [ "$7" = value ] || exit 9
case "$8" in /proc/self/fd/6) /usr/bin/sfdisk --part-uuid '${f.disk}' 3;; /proc/self/fd/7) /usr/bin/sfdisk --part-uuid '${f.disk}' 4;; /proc/self/fd/8) /usr/bin/sfdisk --part-uuid '${f.disk}' 5;; '${byPart}/'*) printf '%s\\n' "\${8##*/}";; *) exit 2;; esac
`);
  const blockdev = join(bin, "blockdev");
  writeFileSync(blockdev, `#!/bin/sh\n[ "$1" = --getsz ] && [ "$2" = /proc/self/fd/9 ] && printf '393216\\n'\n`);
  const findmnt = join(bin, "findmnt");
  writeFileSync(findmnt, `#!/bin/sh\nprintf '8:3\\n'\n`);
  const keyctl = join(bin, "keyctl");
  writeFileSync(keyctl, `#!/bin/sh
case "$1" in
  search) printf '12345\\n'; if [ '${mutation}' = diskseq ]; then printf '74\\n' >'${join(sysdir, "diskseq")}'; fi; if [ '${mutation}' = partuuid ]; then ln -sfn '${join(partNodes, "part4")}' '${byPart}/'"$PERSIST_EXPECTED_P5_UUID"; fi ;;
  pipe) printf 'SYNTHETIC_FIXTURE_key\\n' ;;
  *) exit 0 ;;
esac
`);
  const cryptsetup = join(bin, "cryptsetup");
  writeFileSync(cryptsetup, `#!/bin/sh
case "$1" in
  isLuks) [ -e '${join(dir, "luks-created")}' ] ;;
  luksFormat) printf 'luksFormat\\n' >>'${log}'; touch '${join(dir, "luks-created")}';;
  open) printf 'open\\n' >>'${log}';;
  *) exit 0 ;;
esac
`);
  const mkfs = join(bin, "mkfs.btrfs");
  writeFileSync(mkfs, `#!/bin/sh\nprintf 'mkfs.btrfs\\n' >>'${log}'\n`);
  const generic = ["wipefs", "udevadm"];
  writeFileSync(join(bin, "wipefs"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "udevadm"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "partx"), "#!/bin/sh\nexit 0\n");
  const executablePaths = [sfdisk, stat, blkid, blockdev, findmnt, keyctl, cryptsetup, mkfs, join(bin, "partx"), ...generic.map((name) => join(bin, name))];
  executablePaths.forEach((path) => chmodSync(path, 0o755));

  const names = ["_persist_uuid_valid", "_persist_decimal_valid", "_persist_check_diskseq", "_persist_write", "_persist_no_part5", "_persist_pin_mapper", "_persist_validate_node", "_persist_refresh_part_node", "_persist_verify_gpt", "_persist_create"];
  const functions = names.map((name) => {
    const start = hookSource.indexOf(`${name}() {`);
    const end = hookSource.indexOf("\n}\n", start) + 3;
    return hookSource.slice(start, end);
  }).join("\n");
  const adapted = functions
    .replaceAll("/run/archiso/bootmnt/ais-live/gpt-layout", join(bootmnt, "ais-live/gpt-layout"))
    .replaceAll("/dev/disk/by-diskseq", bySeq)
    .replaceAll("/dev/disk/by-partuuid", byPart)
    .replaceAll("/sys/dev/block", devBlock)
    .replaceAll("/dev/block", blockNodes)
    .replaceAll("/dev/mapper/ais-persist", mapper)
    .replaceAll('[ -b "$PERSIST_MAPPER" ]', '[ -e "$PERSIST_MAPPER" ]')
    .replaceAll('[ -b "$PERSIST_DISK" ]', '[ -e "$PERSIST_DISK" ]')
    .replaceAll("/proc/sys/kernel/random/uuid", uuidFile)
    .replaceAll('[ -b "$resolved" ]', '[ -e "$resolved" ]')
    .replaceAll('[ -b "$boot_part_real" ]', '[ -e "$boot_part_real" ]')
    .replaceAll('[ -b "$disk_real" ]', '[ -e "$disk_real" ]')
    .replaceAll('[ -b "$node_real" ]', '[ -e "$node_real" ]')
    .replaceAll('[ -b "$boot_part_real" ]', '[ -e "$boot_part_real" ]');
  const script = join(dir, "create.sh");
  writeFileSync(script, `${adapted}
_persist_prompt(){ return 0; }
_persist_find_device(){ _persist_check_diskseq; }
_persist_die(){ printf '%s\\n' "$*" >&2; exit 99; }
read(){ reply=$PERSIST_CONFIRM_DISK; return 0; }
PERSIST_CONSOLE='${consolePath}'
exec 9<> '${diskAlias}'
PERSIST_DISK=/proc/self/fd/9
PERSIST_CONFIRM_DISK='${diskAlias}'
PERSIST_DISKSEQ=73
PERSIST_DISK_DEV=8:0
PERSIST_DISK_SYSFS='${sysdir}'
PERSIST_ALLOW_P5_NODE_MISSING=0
PERSIST_EXPECTED_P5_UUID=
PERSIST_EXPECTED_P5_START=
PERSIST_EXPECTED_P5_SIZE=
export PERSIST_EXPECTED_P5_UUID PERSIST_EXPECTED_P5_START PERSIST_EXPECTED_P5_SIZE
_persist_create
`);
  return {
    f,
    log,
    sourceHashes,
    wholeImageBefore,
    currentImageHash: () => imageHash(f.disk),
    currentSourceHashes: () => starts.map((start, index) => sliceHash(f.disk, Number(start), Number(sizes[index]))),
    result: Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" }),
    getLog: () => existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

describe("persistent disk identity contract", () => {
  test("the production generator emits the strict image manifest and existing partition bytes remain unchanged", () => {
    const f = fixture("manifest");
    expect(f.generated.exitCode, f.generated.stderr.toString()).toBe(0);
    const manifest = readFileSync(f.manifest, "utf8");
    expect(manifest.split("\n")).toHaveLength(7);
    expect(manifest).toContain("AIS-GPT-LAYOUT\t1\n");
    expect(manifest).toContain("part\t3\t32768\t163840\t0fc63daf-8483-4772-8e79-3d69d8477de4\t33333333-3333-4333-8333-333333333333\tAISBASE\t-\n");
    const before = starts.map((start, i) => sliceHash(f.disk, Number(start), Number(sizes[i])));
    expect(Bun.spawnSync(["sfdisk", "--verify", f.disk]).exitCode).toBe(0);
    expect(starts.map((start, i) => sliceHash(f.disk, Number(start), Number(sizes[i])))).toEqual(before);
  }, 30000);

  test("ambiguity scan accepts one boot disk and refuses duplicate manifest or duplicate AISBASE media", () => {
    const valid = fixture("single");
    const duplicate = fixture("duplicate");
    const singleScan = ambiguityHarness("single", [{ seq: "73", fixture: valid }]);
    expect(singleScan.result.exitCode, `${singleScan.result.stdout.toString()} ${singleScan.result.stderr.toString()}`).toBe(0);
    const unrelated = ambiguityHarness("unrelated", [
      { seq: "73", fixture: valid },
      { seq: "74", fixture: duplicate },
    ]);
    expect(unrelated.result.exitCode, `${unrelated.result.stdout.toString()} ${unrelated.result.stderr.toString()}`).toBe(0);

    const duplicateManifest = ambiguityHarness("duplicate-manifest", [
      { seq: "73", fixture: valid },
      { seq: "74", fixture: duplicate, fstype: "ext4" },
    ]);
    expect(duplicateManifest.result.exitCode, `${duplicateManifest.result.stdout.toString()} ${duplicateManifest.result.stderr.toString()}`).not.toBe(0);

    const relabelled = fixture("relabelled", { rows: { names: ["BIOS", "AISBOOT", "OTHERBASE", "AISX"] } });
    const duplicateLabel = ambiguityHarness("duplicate-label", [
      { seq: "73", fixture: valid },
      { seq: "74", fixture: relabelled, label: "AISBASE" },
    ]);
    expect(duplicateLabel.result.exitCode).not.toBe(0);
  }, 30000);

  test("the production node validator binds the on-disk PARTUUID, partition geometry, parent diskseq, devno and disk sysfs", () => {
    const f = fixture("node-validation");
    expect(validateNode(f).exitCode).toBe(0);
    const mismatches: Array<Record<string, string>> = [
      { uuid: "55555555-5555-4555-8555-555555555555" },
      { partition: "4" },
      { start: "32769" },
      { size: "163839" },
      { parent: "8:1" },
      { diskseq: "74" },
      { expectedDiskseq: "74" },
      { expectedSysfs: "/sys/devices/pci0000:00/other" },
      { aliasUuid: "55555555-5555-4555-8555-555555555555" },
    ];
    for (const [index, mismatch] of mismatches.entries()) {
      expect(validateNode(f, mismatch).exitCode, `mismatch ${index}: ${JSON.stringify(mismatch)}`).not.toBe(0);
    }
  }, 30000);

  test("the production GPT verifier rejects missing, malformed, overlapping, wrong-type, and mismatched identity contracts", () => {
    const f = fixture("gpt-verification");
    expect(verifyGpt(f).exitCode).toBe(0);
    const missing = join(f.dir, "missing-gpt-layout");
    writeFileSync(missing, "");
    expect(verifyGpt(f, missing).exitCode).not.toBe(0);

    const manifest = readFileSync(f.manifest, "utf8");
    const malformed = join(f.dir, "malformed-gpt-layout");
    writeFileSync(malformed, manifest.replace("AIS-GPT-LAYOUT\t1", "AIS-GPT-LAYOUT\t2"));
    expect(verifyGpt(f, malformed).exitCode).not.toBe(0);
    const overlap = join(f.dir, "overlap-gpt-layout");
    writeFileSync(overlap, manifest.replace("part\t4\t196608", "part\t4\t32769"));
    expect(verifyGpt(f, overlap).exitCode).not.toBe(0);
    const wrongType = join(f.dir, "wrong-type-gpt-layout");
    writeFileSync(wrongType, manifest.replace("0fc63daf-8483-4772-8e79-3d69d8477de4", "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"));
    expect(verifyGpt(f, wrongType).exitCode).not.toBe(0);
    expect(verifyGpt(f, f.manifest, "55555555-5555-4555-8555-555555555555").exitCode).not.toBe(0);
  }, 30000);

  test("guarded creation preserves source partition bytes and refuses disk or partition-node substitution before LUKS formatting", () => {
    const success = createTransition("positive");
    expect(success.result.exitCode, `${success.result.stdout.toString()} ${success.result.stderr.toString()}`).toBe(0);
    expect(success.getLog()).toContain("luksFormat");
    expect(success.getLog()).toContain("mkfs.btrfs");
    expect(success.currentSourceHashes()).toEqual(success.sourceHashes);

    const aliasSwap = createTransition("ignored-alias-swap", "partuuid");
    expect(aliasSwap.result.exitCode, aliasSwap.result.stderr.toString()).toBe(0);
    expect(aliasSwap.getLog()).toContain("luksFormat");
    expect(aliasSwap.currentSourceHashes()).toEqual(aliasSwap.sourceHashes);

    for (const mutation of ["diskseq"] as const) {
      const refusal = createTransition(mutation, mutation);
      expect(refusal.result.exitCode, `${mutation}: ${refusal.result.stdout.toString()} ${refusal.result.stderr.toString()}`).not.toBe(0);
      expect(refusal.getLog()).not.toContain("luksFormat");
      expect(refusal.getLog()).not.toContain("mkfs.btrfs");
      expect(refusal.currentSourceHashes()).toEqual(refusal.sourceHashes);
    }
  }, 60000);

  test("guarded creation refuses stale or invalid existing partition 5 without changing the image or formatting", () => {
    for (const mutation of ["stale-p5", "existing-p5-no-node", "bad-p5-guid", "bad-p5-extent", "bad-p5-name"] as const) {
      const refusal = createTransition(mutation, mutation);
      expect(refusal.result.exitCode, `${mutation}: ${refusal.result.stdout.toString()} ${refusal.result.stderr.toString()}`).not.toBe(0);
      expect(refusal.getLog(), mutation).not.toContain("luksFormat");
      expect(refusal.getLog(), mutation).not.toContain("mkfs.btrfs");
      expect(refusal.currentImageHash(), mutation).toBe(refusal.wholeImageBefore);
      expect(refusal.currentSourceHashes(), mutation).toEqual(refusal.sourceHashes);
    }
  }, 120000);

  test("guarded creation refuses corrupt primary or backup GPT headers before writes or formatting", () => {
    for (const mutation of ["corrupt-primary", "corrupt-backup"] as const) {
      const refusal = createTransition(mutation, mutation);
      expect(refusal.result.exitCode, `${mutation}: ${refusal.result.stdout.toString()} ${refusal.result.stderr.toString()}`).not.toBe(0);
      expect(refusal.getLog(), mutation).not.toContain("luksFormat");
      expect(refusal.getLog(), mutation).not.toContain("mkfs.btrfs");
      expect(refusal.currentImageHash(), mutation).toBe(refusal.wholeImageBefore);
      expect(refusal.currentSourceHashes(), mutation).toEqual(refusal.sourceHashes);
    }
  }, 60000);
});
