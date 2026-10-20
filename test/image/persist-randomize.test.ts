import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = process.env.TMPDIR ?? tmpdir();

const hook = readFileSync(resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist"), "utf8");
const template = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
const generated = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
];
const manifest = [
  "AIS-GPT-LAYOUT\t1",
  `disk-guid\t${template[0]}`,
  `part\t1\t2048\t2048\t21686148-6449-6e6f-744e-656564454649\t${template[1]}\tBIOS\t-`,
  `part\t2\t4096\t28672\tc12a7328-f81f-11d2-ba4b-00a0c93ec93b\t${template[2]}\tAISBOOT\tLegacyBIOSBootable`,
  `part\t3\t32768\t163840\t0fc63daf-8483-4772-8e79-3d69d8477de4\t${template[3]}\tAISBASE\t-`,
  `part\t4\t196608\t32768\tebd0a0a2-b9e5-4433-87c0-68b6b72699c7\t${template[4]}\tAISX\t-`,
].join("\n") + "\n";

function functionSource(name: string) {
  const start = hook.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`missing production function ${name}`);
  const end = hook.indexOf("\n}\n", start) + 3;
  if (end < 3) throw new Error(`unterminated production function ${name}`);
  return hook.slice(start, end);
}

function harness(name: string, options: { uuids?: string[]; verifyActual?: string; initialState?: "template" | "randomized"; mode?: "clean"; ambiguous?: boolean } = {}) {
  const dir = mkdtempSync(join(scratch, `persist-randomize-${name}-`));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const manifestPath = join(dir, "gpt-layout");
  const uuidPath = join(dir, "uuid-input");
  const uuidCountPath = join(dir, "uuid-count");
  const sgdiskLog = join(dir, "sgdisk.log");
  const eventLog = join(dir, "events.log");
  const modePath = join(dir, "mode");
  writeFileSync(manifestPath, manifest);
  writeFileSync(uuidPath, `${(options.uuids ?? generated).join("\n")}\n`);
  writeFileSync(uuidCountPath, "0\n");
  writeFileSync(modePath, `${options.mode ?? "clean"}\n`);

  writeFileSync(join(bin, "cat"), `#!/bin/sh
if [ "$1" = '${uuidPath}' ]; then
  n=$(/usr/bin/cat '${uuidCountPath}')
  n=$((n + 1))
  printf '%s\\n' "$n" > '${uuidCountPath}'
  /usr/bin/sed -n "\${n}p" '${uuidPath}'
elif [ "$1" = '${modePath}' ]; then
  /usr/bin/cat '${modePath}'
else
  exec /usr/bin/cat "$@"
fi
`);
  writeFileSync(join(bin, "sgdisk"), `#!/bin/sh
printf '%s\\n' "$@" > '${sgdiskLog}'
printf 'sgdisk\\n' >> '${eventLog}'
exit 0
`);
  writeFileSync(join(bin, "udevadm"), `#!/bin/sh
printf 'udevadm:%s\\n' "$*" >> '${eventLog}'
exit 0
`);
  for (const executable of ["cat", "sgdisk", "udevadm"]) chmodSync(join(bin, executable), 0o755);

  const actual = options.verifyActual ?? generated.join("\n");
  const verifier = `
_persist_check_diskseq() { printf 'diskseq\\n' >> '${eventLog}'; return 0; }
_persist_verify_gpt() {
  printf 'verify\\n' >> '${eventLog}'
  if [ -f '${sgdiskLog}' ]; then
    PERSIST_GUID_STATE=randomized
    PERSIST_GUID_SNAPSHOT='${actual}'
  else
    PERSIST_GUID_STATE='${options.initialState ?? "template"}'
    PERSIST_GUID_SNAPSHOT='${options.initialState === "randomized" ? generated.join("\n") : template.join("\n")}'
  fi
  return 0
}
`;
  const reject = `
_persist_reject_ambiguous_media() {
  printf 'ambiguity\\n' >> '${eventLog}'
  ${options.ambiguous ? "return 1" : "return 0"}
}
_persist_find_device() {
  printf 'find\\n' >> '${eventLog}'
  _persist_reject_ambiguous_media 73
}
_persist_repair_gpt() { return 0; }
_persist_record_runtime_identity() { printf 'record\\n' >> '${eventLog}'; return 0; }
_persist_create() { printf 'create\\n' >> '${eventLog}'; return 0; }
_persist_die() { printf 'die:%s\\n' "$*" >> '${eventLog}'; exit 42; }
`;
  let source = `# shellcheck disable=SC2034
${functionSource("_persist_write")}
${functionSource("_persist_uuid_valid")}
${functionSource("_persist_randomize_gpt")}
${options.mode ? `${functionSource("run_latehook")}` : ""}
${verifier}
${reject}
PERSIST_DISK='/proc/self/fd/9'
PERSIST_DISKSEQ=73
PERSIST_DISK_SYSFS=/sys/devices/SYNTHETIC_FIXTURE
PERSIST_DISK_DEV=8:0
PERSIST_CONSOLE='${join(dir, "console")}'
PERSIST_GUID_STATE='${options.initialState ?? "template"}'
PERSIST_GUID_SNAPSHOT='${options.initialState === "randomized" ? generated.join("\n") : template.join("\n")}'
PERSIST_GPT_MANIFEST='${manifestPath}'
PERSIST_GPT_RELOCATED=0
`;
  source = source.replaceAll("/run/archiso/bootmnt/ais-live/gpt-layout", manifestPath);
  source = source.replaceAll("/proc/sys/kernel/random/uuid", uuidPath);
  source = source.replaceAll("/run/ais-persist-mode", modePath);
  source += options.mode ? `run_latehook\n` : `_persist_randomize_gpt\n`;
  const script = join(dir, "harness.sh");
  writeFileSync(script, source);
  const result = Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  return { dir, eventLog, result, sgdiskLog, uuidCountPath };
}

describe("first-boot GPT randomisation", () => {
  test("writes generated disk and partition GUIDs through the held descriptor", () => {
    const h = harness("writes-identities");
    expect(h.result.exitCode, h.result.stderr.toString()).toBe(0);
    const args = readFileSync(h.sgdiskLog, "utf8").trimEnd().split("\n");
    expect(args).toEqual([
      "-U", generated[0],
      "-u", `1:${generated[1]}`,
      "-u", `2:${generated[2]}`,
      "-u", `3:${generated[3]}`,
      "-u", `4:${generated[4]}`,
      "/proc/self/fd/9",
    ]);
    expect(readFileSync(h.eventLog, "utf8")).toContain("udevadm:trigger --subsystem-match=block\nudevadm:settle --timeout=10\n");
  });

  test.each([
    ["malformed generated UUID", ["bad-guid", ...generated.slice(1)]],
    ["duplicate generated UUID", [template[1], ...generated.slice(1)]],
    ["duplicate among generated UUIDs", [generated[0], generated[0], ...generated.slice(2)]],
  ])("refuses %s before issuing a GPT write", (_name, uuids) => {
    const h = harness(`refuses-${String(_name).replaceAll(" ", "-")}`, { uuids });
    expect(h.result.exitCode).not.toBe(0);
    expect(() => readFileSync(h.sgdiskLog)).toThrow();
  });

  test("reuses already-randomised GUIDs without writing again", () => {
    const h = harness("reboot-no-write", { initialState: "randomized" });
    expect(h.result.exitCode, h.result.stderr.toString()).toBe(0);
    expect(() => readFileSync(h.sgdiskLog)).toThrow();
    expect(readFileSync(h.uuidCountPath, "utf8").trim()).toBe("0");
  });

  test("rejects a post-write GUID snapshot that differs from the generated set", () => {
    const wrong = [generated[0], generated[1], generated[2], generated[3], template[4]].join("\n");
    const h = harness("wrong-post-write", { verifyActual: wrong });
    expect(h.result.exitCode).not.toBe(0);
    expect(readFileSync(h.sgdiskLog, "utf8")).toContain("/proc/self/fd/9");
  });
});

describe("initramfs late-hook ordering", () => {
  test("checks ambiguity before randomisation and records identity before clean return", () => {
    const h = harness("latehook-clean", { mode: "clean" });
    expect(h.result.exitCode, h.result.stderr.toString()).toBe(0);
    const events = readFileSync(h.eventLog, "utf8").trim().split("\n");
    const index = (event: string) => events.indexOf(event);
    expect(index("find")).toBeGreaterThanOrEqual(0);
    expect(index("ambiguity")).toBeGreaterThan(index("find"));
    expect(index("sgdisk")).toBeGreaterThan(index("ambiguity"));
    expect(index("record")).toBeGreaterThan(index("sgdisk"));
    expect(events).not.toContain("create");
    expect(readFileSync(join(h.dir, "console"), "utf8")).toContain("mode=clean");
  });

  test("ambiguity refusal exits before randomisation, identity recording, creation, or exchange work", () => {
    const h = harness("latehook-ambiguous", { mode: "clean", ambiguous: true });
    expect(h.result.exitCode).toBe(42);
    const events = readFileSync(h.eventLog, "utf8").trim().split("\n");
    expect(events.slice(0, 3)).toEqual(["find", "ambiguity", expect.stringContaining("die:")]);
    expect(events).not.toContain("sgdisk");
    expect(events).not.toContain("record");
    expect(events).not.toContain("create");
  });
});
