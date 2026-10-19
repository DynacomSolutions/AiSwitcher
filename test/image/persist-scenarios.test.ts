import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ais-persist-scenarios-"));
let fixtureIndex = 0;
const expectBin = process.env.AIS_EXPECT_BIN ?? "expect";
const expectAvailable = Boolean(Bun.which(expectBin));

function fakeQemu(body: string, phase: string) {
  const fixture = join(scratch, `serial-${fixtureIndex++}.tcl`);
  writeFileSync(fixture, body);
  return Bun.spawnSync([expectBin, "image/test/persist.exp", "5", "tclsh", fixture], {
    env: { ...process.env, AIS_PERSIST_PHASE: phase, AIS_SERIAL_LOG: `${fixture}.output` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const fakePoweroff = `
proc prompt {text} { puts -nonewline $text; flush stdout }
proc line {} { if {[gets stdin value] < 0} { exit 4 }; return $value }
`;
function success(phase: string, mode = "latest") {
  if (phase === "created") {
    return `${fakePoweroff}
exec stty -echo <@stdin
prompt {Create encrypted persistence. Enter a passphrase (at least 12 characters): }
line
prompt {Confirm passphrase: }
line
prompt {Persistence will partition and format /dev/vda. Type the full device path to confirm: }
set device [line]
if {$device ne "/dev/vda"} { puts stderr "unexpected device confirmation: <$device>"; exit 5 }
puts {AIS-LIVE: stage=first-boot-create status=ok}
`;
  }
  if (phase === "wrong-pass") {
    return `${fakePoweroff}
for {set i 0} {$i < 4} {incr i} {
    prompt {AIS persistence passphrase: }
    line
    if {$i < 3} { puts {Unable to unlock persistence. Try again.}; flush stdout }
}

`;
  }
  if (phase === "pick") {
    return `${fakePoweroff}
prompt {Choose a boot snapshot: }
puts {  1) pre-pacman-20261019T14151000000000000}
puts {AIS-LIVE: prompt=snapshot-selection}
prompt {Selection: }
if {[line] ne "1"} { exit 6 }
`;
  }
  return fakePoweroff;
}

function successByPath() {
  return `${fakePoweroff}
exec stty -echo <@stdin
prompt {Create encrypted persistence. Enter a passphrase (at least 12 characters): }
line
prompt {Confirm passphrase: }
line
prompt {Persistence will partition and format /dev/disk/by-path/pci-0000:00:04.0-virtio0. Type the full device path to confirm: }
set device [line]
if {$device ne "/dev/disk/by-path/pci-0000:00:04.0-virtio0"} { puts stderr "unexpected device confirmation: <$device>"; exit 5 }
puts {AIS-LIVE: stage=first-boot-create status=ok}
`;
}

function markers(phase: string, mode = "latest", extras = "") {
  return `${extras}
puts {AIS-LIVE: stage=persist status=ok mode=${mode}}
puts {AIS-LIVE: stage=kernel-up status=ok}
puts {AIS-LIVE: stage=persist-test status=ok phase=${phase}}
flush stdout
exit 0
`;
}

describe("persistence scenario protocol", () => {
  test("guest assertion functions reject deliberately broken metadata, key, and package fixtures", () => {
    const assertions = resolve("image/archiso/airootfs/usr/local/lib/ais-live/persist-assertions");
    const fixtureBin = join(scratch, `assert-fixtures-${fixtureIndex++}`);
    const dump = join(scratch, `luks-dump-${fixtureIndex++}`);
    const explicit = join(scratch, `explicit-${fixtureIndex++}`);
    Bun.spawnSync(["mkdir", "-p", fixtureBin]);
    writeFileSync(join(fixtureBin, "keyctl"), `#!/usr/bin/bash
if [[ $1 == search ]]; then [[ \${SEARCH_ALLOWED:-0} == 1 ]]; exit; fi
if [[ $1 == read ]]; then [[ \${READ_ALLOWED:-0} == 1 ]]; exit; fi
exit 1
`);
    writeFileSync(join(fixtureBin, "pacman"), `#!/usr/bin/bash
[[ \${PACKAGE_INSTALLED:-0} == 1 ]]
`);
    writeFileSync(join(fixtureBin, "runuser"), `#!/usr/bin/bash
[[ $1 == -u && $2 == agent && $3 == -- ]] || exit 2
shift 3
exec "$@"
`);
    Bun.spawnSync(["chmod", "+x", join(fixtureBin, "keyctl"), join(fixtureBin, "pacman"), join(fixtureBin, "runuser")]);
    writeFileSync(dump, "Version: 2\n\t PBKDF: argon2id\n");
    writeFileSync(explicit, "tree\n");
    const run = (body: string, extra: Record<string, string> = {}) => Bun.spawnSync([
      "bash", "-c", `source "$1"; ${body}`, "assertions", assertions,
    ], { env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH}`, ...extra }, stdout: "pipe", stderr: "pipe" });
    expect(run(`persist_assert_luks_dump "${dump}"`).exitCode).toBe(0);
    writeFileSync(dump, "Version: 2\n\t PBKDF: pbkdf2\n");
    expect(run(`persist_assert_luks_dump "${dump}"`).exitCode).not.toBe(0);
    writeFileSync(dump, "Version: 1\n\t PBKDF: argon2id\n");
    expect(run(`persist_assert_luks_dump "${dump}"`).exitCode).not.toBe(0);
    expect(run('persist_assert_key_description "user;0;0;003f0000"').exitCode).toBe(0);
    expect(run('persist_assert_key_description "user;0;0;00000000"').exitCode).not.toBe(0);
    expect(run('persist_assert_key_description "user;1000;0;003f0000"').exitCode).not.toBe(0);
    expect(run('persist_assert_key_description "user;0;1000;003f0000"').exitCode).not.toBe(0);
    expect(run("persist_assert_key_unreadable_as agent 314159").exitCode).toBe(0);
    expect(run("persist_assert_key_unreadable_as agent 314159", { READ_ALLOWED: "1" }).exitCode).not.toBe(0);
    expect(run("persist_assert_key_revoked 314159").exitCode).toBe(0);
    expect(run("persist_assert_key_revoked 314159", { SEARCH_ALLOWED: "1" }).exitCode).not.toBe(0);
    expect(run("persist_assert_key_revoked 314159", { READ_ALLOWED: "1" }).exitCode).not.toBe(0);
    expect(run(`persist_assert_package_recorded tree "${explicit}"`, { PACKAGE_INSTALLED: "1" }).exitCode).toBe(0);
    expect(run(`persist_assert_package_recorded tree "${explicit}"`).exitCode).not.toBe(0);
    writeFileSync(explicit, "other\n");
    expect(run(`persist_assert_package_recorded tree "${explicit}"`, { PACKAGE_INSTALLED: "1" }).exitCode).not.toBe(0);
  });

  test("guest service is explicitly guarded and runs ahead of the live getty", () => {
    const service = readFileSync(resolve("image/archiso/airootfs/etc/systemd/system/ais-live-persist-test.service"), "utf8");
    const script = readFileSync(resolve("image/archiso/airootfs/usr/local/lib/ais-live/persist-test"), "utf8");
    expect(service).toContain("ConditionKernelCommandLine=ais.test=1");
    expect(service).toContain("ConditionKernelCommandLine=ais.scenario=persist");
    expect(service).toContain("ConditionKernelCommandLine=ais.persist-phase");
    expect(service).toContain("Before=getty-pre.target");
    expect(service.match(/^After=.*ais-live-kernel-up\.service$/m)).not.toBeNull();
    expect(service).toContain("ExecStart=/usr/local/lib/ais-live/persist-test");
    const wants = resolve("image/archiso/airootfs/etc/systemd/system/multi-user.target.wants/ais-live-persist-test.service");
    expect(lstatSync(wants).isSymbolicLink()).toBe(true);
    expect(realpathSync(wants)).toBe(resolve("image/archiso/airootfs/etc/systemd/system/ais-live-persist-test.service"));
    expect(script).toContain("case \"$phase\" in");
    expect(script).toContain("pacman --config /run/ais-persist-test-pacman.conf -Sy --noconfirm");
    expect(script).toContain("pacman --config /run/ais-persist-test-pacman.conf -S --noconfirm tree");
    expect(script).toContain("PackageRequired DatabaseOptional");
    expect(script).toContain("$boots -eq 5 && $transactions -eq 10");
    expect(script).toContain("pick-mutated-source");
    expect(script).toContain("keyctl search @u user ais-live-exchange");
    expect(script).toContain('key_description=$(keyctl rdescribe "$keyid")');
    expect(script).not.toContain('key_description=$(keyctl describe "$keyid")');
    expect(script).toContain("systemctl is-active --quiet ais-live-key-lifetime.service");
    expect(script).toContain("agent-home-owner");
    expect(script).toContain("package-not-recorded");
    expect(script).toContain("package-persist-not-recorded");
    expect(script).toContain("argon2id");
    expect(script).toContain("exchange-key-permissions");
    expect(script).toContain("agent-read-exchange-key");
    expect(script).toContain("offline-package-addition-not-recorded");
    expect(script).toContain("pending-migration-survived-pick");
    expect(script).toContain("displaced-data-not-reclaimed");
    expect(script).toContain("outbox-not-written");
    expect(script).toContain("shutdown-retained-exchange-key");
    expect(script).toContain("keyctl search @u user ais-live-exchange");
    expect(script).toContain("persist_assert_key_revoked \"$key_serial\"");
    expect(script).toContain("migration-user-additions");
    expect(script).toContain("systemctl start ais-live-persist-retry.service");
    expect(script).toContain("systemctl stop ais-live-outbox-shutdown.service");
    expect(script).toContain("systemctl stop ais-live-key-lifetime.service");
    expect(script).toContain("btrfs subvolume sync");
  });

  test("expect driver admits every guest phase and refuses broken invariant markers", () => {
    const driver = readFileSync(resolve("image/test/persist.exp"), "utf8");
    const guest = readFileSync(resolve("image/archiso/airootfs/usr/local/lib/ais-live/persist-test"), "utf8");
    const phases = ["created", "wrong-pass", "package", "verify-package", "retry", "clean", "pick", "verify-pick", "retention"];
    for (const phase of phases) {
      expect(driver).toContain(phase);
      expect(guest).toContain(phase);
    }
    for (const reason of ["luks2", "argon2id", "exchange-key-permissions", "agent-read-exchange-key", "offline-package-addition-not-recorded", "pending-migration-survived-pick", "outbox-not-written", "shutdown-retained-exchange-key", "displaced-data-not-reclaimed"]) {
      const broken = fakeQemu(`${fakePoweroff}
puts {AIS-LIVE: stage=persist status=ok mode=latest}
puts {AIS-LIVE: stage=kernel-up status=ok}
puts {AIS-LIVE: stage=persist-test status=fail reason=${reason}}
flush stdout
`, "created");
      expect(broken.exitCode).not.toBe(0);
      expect(broken.stderr.toString()).toContain("guest reported a boot or assertion failure");
    }
  });

  test("growth verification derives sector count from the supported sfdisk JSON schema", () => {
    const host = readFileSync(resolve("image/test/run-persist-scenarios.sh"), "utf8");
    const parsed = Bun.spawnSync(["jq", "-er", ".partitiontable.sectorsize, .partitiontable.lastlba, .partitiontable.partitions[4].start, .partitiontable.partitions[4].size"], {
      stdin: Buffer.from(JSON.stringify({ partitiontable: { label: "gpt", sectorsize: 512, firstlba: 34, lastlba: 8388574, partitions: [{}, {}, {}, {}, { start: 7340032, size: 1048543 }] } })),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.toString().trim().split("\n")).toEqual(["512", "8388574", "7340032", "1048543"]);
    expect(host).toContain("sectorsize=$(jq -er '.partitiontable.sectorsize'");
    expect(host).toContain("sectors=$(( $(stat -c %s \"$current\") / sectorsize ))");
    expect(host).not.toContain(".partitiontable.sectors'");
  });

  test("creates a byte-checked duplicate-label disk for create and clean", () => {
    const host = readFileSync(resolve("image/test/run-persist-scenarios.sh"), "utf8");
    expect(host).toContain("duplicate-ais-labels.img");
    expect(host).toContain("SYNTHETIC_FIXTURE_duplicate_AIS_labels_sentinel");
    expect(host).toContain("run_phase created latest \"$image\" 4G \"$duplicate_disk\"");
    expect(host).toContain("run_phase clean clean \"$current\" '' \"$duplicate_disk\"");
    expect(host).toContain("modified duplicate-label disk");
  });

  test("gives online replay phases a restricted network interface", () => {
    const host = readFileSync(resolve("image/test/run-persist-scenarios.sh"), "utf8");
    expect(host).toContain("$phase == retry || $phase == verify-pick");
    expect(host).toContain("user,id=persisttest,restrict=on");
  });

  test("rejects leaked passphrases anywhere in serial output, including after success", () => {
    const serial = join(scratch, `serial-leak-${fixtureIndex++}.log`);
    writeFileSync(serial, `${markers("created")}\nSYNTHETIC_FIXTURE_ais_live_persist_passphrase\n`);
    const checked = Bun.spawnSync(["bash", "image/test/check-persist-serial.sh", serial], { stdout: "pipe", stderr: "pipe" });
    expect(checked.exitCode).not.toBe(0);
    expect(checked.stderr.toString()).toContain("synthetic passphrase leaked to serial output");
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("accepts the first-create prompt sequence and full device confirmation", () => {
    const result = fakeQemu(success("created") + markers("created", "latest", ""), "created");
    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("persist-test: phase=created verified");
    expect(result.stdout.toString()).not.toContain("SYNTHETIC_FIXTURE_ais_live_persist_passphrase");
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("accepts colon-bearing PCI by-path aliases in the device confirmation", () => {
    const result = fakeQemu(successByPath() + markers("created"), "created");
    if (result.exitCode !== 0) throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
    expect(result.exitCode).toBe(0);
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("requires three wrong-password retries before unlock succeeds", () => {
    const result = fakeQemu(success("wrong-pass") + markers("wrong-pass"), "wrong-pass");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("persist-test: phase=wrong-pass verified");
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("fails closed on a create marker during an existing-volume boot", () => {
    const result = fakeQemu(markers("wrong-pass", "latest", "puts {AIS-LIVE: stage=first-boot-create status=ok}"), "wrong-pass");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unexpected reformat marker");
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("fails closed when fewer than three unlock failures are reported", () => {
    const twoRetries = `${fakePoweroff}
for {set i 0} {$i < 3} {incr i} {
    prompt {AIS persistence passphrase: }
    line
    if {$i < 2} { puts {Unable to unlock persistence. Try again.}; flush stdout }
}
`;
    const result = fakeQemu(twoRetries + markers("wrong-pass"), "wrong-pass");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("three wrong passphrases were not rejected");
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("rejects a success marker for a different scenario phase", () => {
    const result = fakeQemu(markers("clean"), "verify-package");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("wrong persistence scenario phase");
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("selects an older snapshot and rejects guest failure markers", () => {
    const picked = fakeQemu(success("pick") + markers("pick", "pick"), "pick");
    expect(picked.exitCode).toBe(0);
    const failed = fakeQemu(markers("verify-package", "latest", "puts {AIS-LIVE: stage=persist-test status=fail reason=package-persist}"), "verify-package");
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr.toString()).toContain("guest reported a boot or assertion failure");
  });

  test.skipIf(!expectAvailable || !Bun.which("tclsh"))("processes coalesced serial markers and pre-pacman menu entries in stream order", () => {
    const ordered = `${fakePoweroff}
exec stty -echo <@stdin
prompt {Choose a boot snapshot: }
puts {  1) pre-pacman-20261019T14151000000000000}
puts {AIS-LIVE: prompt=snapshot-selection}
prompt {Selection: }
if {[line] ne "1"} { exit 6 }
puts {AIS-LIVE: stage=persist status=ok mode=pick}
puts {AIS-LIVE: stage=kernel-up status=ok}
puts {package transaction log: pre-pacman-20261019T14151100000000000 snapshot created}
puts {AIS-LIVE: stage=persist-test status=ok phase=pick}
flush stdout
exit 0
`;
    const result = fakeQemu(ordered, "pick");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("persist-test: phase=pick verified");
  });
});
