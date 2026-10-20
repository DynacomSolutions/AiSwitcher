import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ais-exchange-identity-"));
const hookSource = readFileSync(resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist"), "utf8");
const helperSource = readFileSync(resolve("image/archiso/airootfs/usr/local/lib/ais-live/resolve-boot-partition"), "utf8");
const guids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

type Variant = {
  diskseq?: string;
  diskMinor?: string;
  guids?: string[];
  p4Uuid?: string;
  p4Start?: string;
  p4Size?: string;
  secondDrive?: boolean;
  malformedIdentity?: boolean;
  mountedSource?: string;
  firmwareUuid?: string;
};

function makeFixture(name: string, variant: Variant = {}) {
  const base = join(root, name);
  const bin = join(base, "bin");
  const bySeq = join(base, "dev/disk/by-diskseq");
  const byPartUuid = join(base, "dev/disk/by-partuuid");
  const byDev = join(base, "dev/block");
  const nodes = join(base, "nodes");
  const sys = join(base, "sys/dev/block");
  const runRoot = join(base, "run");
  const bootMount = join(base, "bootmnt");
  const target = join(base, "mnt/aisx");
  const log = join(base, "mount.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(bySeq, { recursive: true });
  mkdirSync(byPartUuid, { recursive: true });
  mkdirSync(byDev, { recursive: true });
  mkdirSync(nodes, { recursive: true });
  mkdirSync(sys, { recursive: true });
  mkdirSync(bootMount, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(log, "");

  for (const path of ["disk", "part3", "part4", "part5"]) writeFileSync(join(nodes, path), "SYNTHETIC_FIXTURE\n");
  symlinkSync(join(nodes, "disk"), join(bySeq, "73"));
  symlinkSync(join(nodes, "part3"), join(bySeq, "73-part3"));
  symlinkSync(join(nodes, "part4"), join(bySeq, "73-part4"));
  symlinkSync(join(nodes, "part5"), join(bySeq, "73-part5"));
  symlinkSync(join(nodes, "disk"), join(byDev, "8:0"));
  for (const [index, uuid] of guids.entries()) symlinkSync(join(nodes, `part${index + 1}`), join(byPartUuid, uuid));
  writeFileSync(join(bootMount, "manifest"), "SYNTHETIC_FIXTURE\n");
  const cmdline = join(base, "cmdline");
  writeFileSync(cmdline, variant.firmwareUuid ? `ais.boot_partuuid=${variant.firmwareUuid}\n` : "ais.mode=clean\n");

  const identityPath = join(runRoot, "ais-persist-identity");
  mkdirSync(runRoot, { recursive: true });
  const identityRows = [
    "AIS-PERSIST-IDENTITY\t1",
    "diskseq\t73",
    "dev\t8:0",
    "sysfs\t/sys/devices/fixture/disk",
    `guids\t${guids.join(",")}`,
    `part4-uuid\t${guids[3]}`,
    "part4-start\t4096",
    "part4-size\t8192",
  ];
  if (variant.malformedIdentity) identityRows[2] = "dev\tbroken";
  writeFileSync(identityPath, `${identityRows.join("\n")}\n`);
  writeFileSync(join(runRoot, "ais-persist-device"), "/dev/synthetic-stale-partition\n");

  const hook = hookSource
    .replaceAll("/dev/disk/by-diskseq", bySeq)
    .replaceAll("/dev/disk/by-partuuid", byPartUuid)
    .replaceAll('"/dev/block/', `"${byDev}/`)
    .replaceAll("/sys/dev/block", sys)
    .replaceAll("/proc/cmdline", cmdline)
    .replaceAll("/sys/firmware/efi", join(base, "efi"))
    .replaceAll("/run/archiso/bootmnt", bootMount)
    .replaceAll("/run/ais-persist-ambiguity-probe", join(base, "probe"))
    .replaceAll('[ -b "$bootdev" ]', '[ -e "$bootdev" ]')
    .replaceAll('[ -b "$candidate" ]', '[ -e "$candidate" ]')
    .replaceAll('[ -b "$PERSIST_DISK" ]', '[ -e "$PERSIST_DISK" ]')
    .replaceAll('[ -b "$resolved" ]', '[ -e "$resolved" ]')
    .replace('[ -r "$boot_parent/diskseq" ]', '[ -r /dev/null ]');
  const hookPath = join(base, "ais_persist");
  writeFileSync(hookPath, hook);

  const helperPath = join(base, "resolve-boot-partition");
  const helper = helperSource
    .replace("/etc/initcpio/hooks/ais_persist", hookPath)
    .replace("/run/ais-persist-identity", identityPath)
    .replaceAll("/mnt/aisx", target)
    .replace(`. ${hookPath}`, ": # test preloads the production hook");
  writeFileSync(helperPath, helper);
  chmodSync(helperPath, 0o755);

  const writeCommand = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  writeCommand("findmnt", `if [[ "$*" == *"${bootMount}"* ]]; then if [[ "$*" == *MAJ:MIN* ]]; then printf '8:3\\n'; else printf '%s\\n' '${join(bySeq, "73-part3")}'; fi; elif [[ "$*" == *"${target}"* ]]; then if [[ "$*" == *MAJ:MIN* ]]; then printf '%s\\n' "\${AIS_MOUNT_DEV:-8:20}"; else printf '%s\\n' "\${AIS_MOUNT_SOURCE:-}"; fi; else exit 1; fi`);
  writeCommand("udevadm", "exit 0");
  writeCommand("sleep", "exit 0");
  writeCommand("mountpoint", `[[ \${AIS_MOUNTED:-0} == 1 ]]`);
  writeCommand("mount", `[[ $1 == --no-canonicalize && $6 == /proc/self/fd/7 && $6 -ef '${join(nodes, "part4")}' ]] || exit 1; printf '%s\\n' "$*" >> '${log}'`);
  writeCommand("cryptsetup", `[[ $2 == /proc/self/fd/8 && $2 -ef '${join(nodes, "part5")}' ]] || exit 1; case $1 in isLuks) exit 0;; luksDump) printf 'Version: 2\\nPBKDF: argon2id\\n';; *) exit 1;; esac`);
  writeCommand("umount", `printf 'umount %s\\n' "$*" >> '${log}'`);
  writeCommand("stat", `format= path=; while (($#)); do if [[ $1 == -Lc ]]; then format=$2; shift 2; else path=$1; shift; fi; done; if [[ $path == *part3 ]]; then minor=3; elif [[ $path -ef '${join(nodes, "part4")}' ]]; then minor=4; else minor=\${AIS_DISK_MINOR:-0}; fi; case $format in %t) printf '8\\n';; %T) printf '%s\\n' "$minor";; %t:%T) printf '8:%s\\n' "$minor";; *) exit 2;; esac`);
  writeCommand("readlink", `if [[ $1 == -f && $2 == ${sys}/8:3 ]]; then printf '/sys/devices/fixture/disk/disk0p3\\n'; elif [[ $1 == -f && $2 == ${sys}/8:* || $2 == ${sys}/0:0 ]]; then printf '/sys/devices/fixture/disk\\n'; else exec /usr/bin/readlink "$@"; fi`);
  writeCommand("cat", `case $1 in /sys/devices/fixture/disk/diskseq) printf '%s\\n' "\${AIS_DISKSEQ:-73}";; /sys/devices/fixture/disk/dev) printf '8:%s\\n' "\${AIS_DISK_MINOR:-0}";; /sys/devices/fixture/disk/disk0p3/partition) printf '3\\n';; *) exec /usr/bin/cat "$@";; esac`);

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AIS_DISKSEQ: variant.diskseq ?? "73",
    AIS_DISK_MINOR: variant.diskMinor ?? "0",
    AIS_SECOND_DRIVE: variant.secondDrive ? "1" : "0",
    AIS_RUNTIME_GUIDS: (variant.guids ?? guids).join("\n"),
    AIS_P4_UUID: variant.p4Uuid ?? guids[3],
    AIS_P4_START: variant.p4Start ?? "4096",
    AIS_P4_SIZE: variant.p4Size ?? "8192",
  };
  const driver = `source '${hookPath}';
_persist_reject_ambiguous_media() { PERSIST_CANDIDATES=73; [[ \${AIS_SECOND_DRIVE:-0} == 0 ]]; }
_persist_verify_gpt() {
  [[ $PERSIST_BOOT_PARTUUID == $(printf '%s\\n' "$AIS_RUNTIME_GUIDS" | sed -n '3p') ]] || return 1
  PERSIST_GUID_SNAPSHOT=$(printf '%s\\n' "\${AIS_RUNTIME_GUIDS}")
  PERSIST_GPT_DUMP=$(printf 'part\\t4\\t%s\\t%s\\ttype\\t%s\\tAISX\\t-\\n' "\${AIS_P4_START}" "\${AIS_P4_SIZE}" "\${AIS_P4_UUID}")
  PERSIST_P5_PRESENT=1
}
_persist_refresh_part_node() {
  case $1 in
    4) exec 7<>'${join(nodes, "part4")}'; PERSIST_RESOLVED_PART=/proc/self/fd/7 ;;
    5) exec 8<>'${join(nodes, "part5")}'; PERSIST_RESOLVED_PART=/proc/self/fd/8 ;;
    *) return 1 ;;
  esac
}
`;
  return { base, env, driver, helper, log, target, bySeq, identityPath };
}

function run(fixture: ReturnType<typeof makeFixture>, mode = "exchange") {
  return Bun.spawnSync(["bash", "-c", fixture.driver + fixture.helper, "resolve-boot-partition", mode], {
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("fresh-process exchange identity", () => {
  test("derives the exchange partition afresh from the original boot identity after a clean transition", () => {
    const fixture = makeFixture("clean-transition");
    const exchange = run(fixture, "exchange");
    expect(exchange.exitCode, exchange.stderr.toString()).toBe(0);
    expect(readFileSync(fixture.log, "utf8")).toContain(`/proc/self/fd/7 ${fixture.target}`);
    expect(readFileSync(fixture.identityPath, "utf8")).toContain("diskseq\t73\n");
    expect(readFileSync(join(fixture.base, "run/ais-persist-device"), "utf8")).toBe("/dev/synthetic-stale-partition\n");
  });

  test("uses the verified runtime UUIDs after first-boot randomisation", () => {
    const fixture = makeFixture("randomised-firmware-uuid", { firmwareUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const result = run(fixture);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(fixture.log, "utf8")).toContain(`/proc/self/fd/7 ${fixture.target}`);
  });

  test("runs persistence diagnostics before closing the held partition descriptor", () => {
    const fixture = makeFixture("held-persist-probe");
    const result = run(fixture, "persist");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("Version: 2\nPBKDF: argon2id\n");
    expect(readFileSync(fixture.log, "utf8")).toBe("");
  });

  test("rejects diskseq changes and reused raw device nodes before any mount", () => {
    for (const [name, variant] of [
      ["changed-diskseq", { diskseq: "74" }],
      ["reused-device-node", { diskMinor: "1" }],
    ] as const) {
      const fixture = makeFixture(name, variant);
      const result = run(fixture);
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(fixture.log, "utf8").length).toBe(0);
    }
  });

  test("rejects changed GPT identifiers and exchange geometry without mounting", () => {
    const changedGuids = [...guids];
    changedGuids[0] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const variants: Variant[] = [
      { guids: changedGuids },
      { p4Uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { p4Start: "4097" },
      { p4Size: "8191" },
    ];
    for (const [index, variant] of variants.entries()) {
      const fixture = makeFixture(`changed-gpt-${index}`, variant);
      const result = run(fixture);
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(fixture.log, "utf8").length).toBe(0);
    }
  });

  test("rejects absent or malformed identity records and a second AIS drive", () => {
    const missing = makeFixture("missing-identity");
    writeFileSync(missing.identityPath, "");
    const missingResult = run(missing);
    expect(missingResult.exitCode).not.toBe(0);
    expect(readFileSync(missing.log, "utf8").length).toBe(0);

    const malformed = makeFixture("malformed-identity", { malformedIdentity: true });
    expect(run(malformed).exitCode).not.toBe(0);
    expect(readFileSync(malformed.log, "utf8").length).toBe(0);

    const duplicate = makeFixture("second-ais-drive", { secondDrive: true });
    expect(run(duplicate).exitCode).not.toBe(0);
    expect(readFileSync(duplicate.log, "utf8").length).toBe(0);
  });

  test("rejects an already mounted exchange partition from another device", () => {
    const fixture = makeFixture("wrong-mounted-source", { mountedSource: "/dev/synthetic-other-partition" });
    fixture.env.AIS_MOUNTED = "1";
    fixture.env.AIS_MOUNT_SOURCE = "/dev/synthetic-other-partition";
    const result = run(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(fixture.log, "utf8").length).toBe(0);
  });

  test("recognises the held exchange partition by its mount dev_t after its source alias changes", () => {
    const fixture = makeFixture("mounted-by-dev");
    fixture.env.AIS_MOUNTED = "1";
    fixture.env.AIS_MOUNT_DEV = "8:4";
    fixture.env.AIS_MOUNT_SOURCE = "/dev/synthetic-stale-partition";
    const result = run(fixture);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(fixture.log, "utf8")).toBe("");
  });
});
