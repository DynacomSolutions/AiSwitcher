import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const scratch = mkdtempSync(join(tmpdir(), "ais-gpt-device-SYNTHETIC_FIXTURE-"));
const hookSource = readFileSync(resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist"), "utf8");
const type = ["21686148-6449-6e6f-744e-656564454649", "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", "0fc63daf-8483-4772-8e79-3d69d8477de4", "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7"];
const partGuids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const names = ["BIOS", "AISBOOT", "AISBASE", "AISX"];

function fixture(name: string, extra = "", diskSize = "128M", grow = true) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const disk = join(dir, "disk.img");
  Bun.spawnSync(["truncate", "-s", diskSize, disk]);
  const starts = ["2048", "4096", "32768", "196608"];
  const sizes = ["2048", "28672", "163840", "32768"];
  const rows = names.map((n, i) => `start=${starts[i]}, size=${sizes[i]}, type=${type[i]}, uuid=${partGuids[i]}, name="${n}"${i === 1 ? ', attrs="LegacyBIOSBootable"' : ""}`).join("\n");
  const table = `label: gpt\nunit: sectors\nsector-size: 512\n\n${rows}${extra}`;
  const input = join(dir, "table.txt");
  writeFileSync(input, table);
  const write = Bun.spawnSync(["bash", "-c", `sfdisk '${disk}' < '${input}'`], { stdout: "pipe", stderr: "pipe" });
  if (write.exitCode !== 0) throw new Error(write.stderr.toString());
  if (grow) Bun.spawnSync(["truncate", "-s", "192M", disk]);
  const guid = Bun.spawnSync(["sfdisk", "--disk-id", disk], { stdout: "pipe" }).stdout.toString().trim().toLowerCase();
  const manifest = join(dir, "gpt-layout");
  const rowsManifest = names.map((n, i) => `part\t${i + 1}\t${starts[i]}\t${sizes[i]}\t${type[i]}\t${partGuids[i]}\t${n}\t${i === 1 ? "LegacyBIOSBootable" : "-"}`).join("\n");
  writeFileSync(manifest, `AIS-GPT-LAYOUT\t1\ndisk-guid\t${guid}\n${rowsManifest}\n`);
  return { dir, disk, manifest, starts, sizes, table, guid };
}

function hashSlice(disk: string, start: number, size: number) {
  const bytes = Bun.spawnSync(["dd", `if=${disk}`, "bs=512", `skip=${start}`, `count=${size}`, "status=none"], { stdout: "pipe" }).stdout;
  return createHash("sha256").update(bytes).digest("hex");
}

function hashImage(disk: string) {
  return Bun.spawnSync(["sha256sum", disk], { stdout: "pipe" }).stdout.toString().split(/\s+/)[0];
}

function actualNodeValidator(f: ReturnType<typeof fixture>, values: { uuid?: string; partition?: string; parent?: string; start?: string; size?: string; missing?: boolean } = {}) {
  const start = hookSource.indexOf("_persist_validate_node() {");
  const end = hookSource.indexOf("\n}\n\n_persist_verify_gpt", start) + 2;
  const fn = hookSource.slice(start, end).replaceAll('[ -b "$disk_real" ]', '[ -e "$disk_real" ]').replaceAll('[ -b "$node_real" ]', '[ -e "$node_real" ]');
  const dir = join(f.dir, "node-validator");
  const bin = join(dir, "bin");
  const parent = join(dir, "parent");
  const sysdev = join(parent, "child");
  mkdirSync(bin, { recursive: true });
  mkdirSync(sysdev, { recursive: true });
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(sysdev, "partition"), `${values.partition ?? "5"}\n`);
  writeFileSync(join(sysdev, "start"), `${values.start ?? "229376"}\n`);
  writeFileSync(join(sysdev, "size"), `${values.size ?? "163807"}\n`);
  writeFileSync(join(parent, "dev"), `${values.parent ?? "8:0"}\n`);
  const node = join(dir, "node");
  if (!values.missing) writeFileSync(node, "SYNTHETIC_FIXTURE_node");
  writeFileSync(join(bin, "readlink"), `#!/bin/sh\ncase "$2" in '${f.disk}') printf '%s\\n' '${f.disk}' ;; '${node}') printf '%s\\n' '${node}' ;; /sys/dev/block/8:5) printf '%s\\n' '${sysdev}' ;; *) printf '%s\\n' "$2" ;; esac\n`);
  writeFileSync(join(bin, "blkid"), `#!/bin/sh\nprintf '%s\\n' '${values.uuid ?? "55555555-5555-4555-8555-555555555555"}'\n`);
  writeFileSync(join(bin, "stat"), `#!/bin/sh\ncase "$2:$3" in %t:${node}) printf '8\\n' ;; %T:${node}) printf '5\\n' ;; %t:${f.disk}) printf '8\\n' ;; %T:${f.disk}) printf '0\\n' ;; *) exit 1 ;; esac\n`);
  for (const name of ["readlink", "blkid", "stat"]) chmodSync(join(bin, name), 0o755);
  const script = join(dir, "validator.sh");
  writeFileSync(script, `${fn}\nPERSIST_DISK='${f.disk}'\n_persist_validate_node '${node}' 5 '55555555-5555-4555-8555-555555555555' 229376 163807\n`);
  return Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
}

function verifier(f: ReturnType<typeof fixture>) {
  const bin = join(f.dir, "bin");
  mkdirSync(bin, { recursive: true });
  const source = `${f.disk}3`;
  writeFileSync(join(bin, "findmnt"), `#!/bin/sh\nprintf '%s\\n' '${source}'\n`);
  writeFileSync(join(bin, "blkid"), `#!/bin/sh\nprintf '%s\\n' '${partGuids[2]}'\n`);
  writeFileSync(join(bin, "lsblk"), "#!/bin/sh\nprintf 'synthetic-disk\\n'\n");
  writeFileSync(join(bin, "readlink"), `#!/bin/sh\ncase "$2" in '${f.disk}') printf '%s\\n' '${f.disk}' ;; /dev/synthetic-disk) printf '%s\\n' '${f.disk}' ;; *) printf '%s\\n' "$2" ;; esac\n`);
  writeFileSync(join(bin, "sfdisk"), `#!/bin/sh\nif [ "$1" = --dump ]; then /usr/bin/sfdisk --dump "$2" | sed 's|${f.disk}|/dev/synthetic-disk|g'; else exec /usr/bin/sfdisk "$@"; fi\n`);
  writeFileSync(join(bin, "blockdev"), "#!/bin/sh\nprintf '393216\\n'\n");
  for (const name of ["findmnt", "blkid", "lsblk", "readlink", "blockdev", "sfdisk"]) chmodSync(join(bin, name), 0o755);
  const script = join(f.dir, "verify.sh");
  const copy = hookSource
    .replaceAll("/run/archiso/bootmnt/ais-live/gpt-layout", f.manifest)
    .replaceAll("/run/archiso/bootmnt", f.dir);
  writeFileSync(script, `${copy}\n_persist_die(){ echo "$*" >&2; return 1; }\nPERSIST_DISK='${f.disk}'\nPERSIST_EXCHANGE_PART='/dev/synthetic-disk4'\n_persist_validate_node(){ return 0; }\n_persist_verify_gpt\n`);
  chmodSync(script, 0o755);
  return Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
}

function createPersist(f: ReturnType<typeof fixture>, options: { nodeExists?: boolean; partxDoesNotCreate?: boolean; validateNodeFails?: boolean } = {}) {
  const bin = join(f.dir, "create-bin");
  mkdirSync(bin, { recursive: true });
  const node = join(f.dir, "persist-node");
  const log = join(f.dir, "format.log");
  const source = "/dev/synthetic-disk3";
  const scripts: Record<string, string> = {
    findmnt: `#!/bin/sh\nprintf '%s\\n' '${source}'\n`,
    blkid: `#!/bin/sh\ncase "$*" in *synthetic-disk3*) printf '%s\\n' '${partGuids[2]}';; *synthetic-disk4*) printf '%s\\n' '${partGuids[3]}';; *) /usr/bin/sfdisk --dump '${f.disk}' | sed -n 's/.*uuid=\\([^,]*\\).*name="AISPERSIST".*/\\1/p';; esac\n`,
    lsblk: "#!/bin/sh\nprintf 'synthetic-disk\\n'\n",
    readlink: `#!/bin/sh\ncase "$2" in '${f.disk}'|/dev/synthetic-disk) printf '%s\\n' '${f.disk}' ;; *) printf '%s\\n' "$2" ;; esac\n`,
    blockdev: "#!/bin/sh\nprintf '393216\\n'\n",
    partx: `#!/bin/sh\n${options.nodeExists || options.partxDoesNotCreate ? "" : `touch '${node}'`}\n`,
    udevadm: "#!/bin/sh\nexit 0\n",
    cryptsetup: `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = isLuks ] && exit 1\nexit 0\n`,
    wipefs: "#!/bin/sh\nexit 0\n",
    keyctl: "#!/bin/sh\n[ \"$1\" = pipe ] && printf 'SYNTHETIC_FIXTURE_key_material' || printf '77\\n'\n",
    "mkfs.btrfs": `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`,
    sfdisk: `#!/bin/sh\nif [ "$1" = --dump ]; then /usr/bin/sfdisk --dump "$2" | sed 's|${f.disk}|/dev/synthetic-disk|g'; else exec /usr/bin/sfdisk "$@"; fi\n`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const console = join(f.dir, "console");
  writeFileSync(console, `${f.disk}\n`);
  const copy = hookSource
    .replaceAll("/run/archiso/bootmnt/ais-live/gpt-layout", f.manifest)
    .replaceAll("/run/archiso/bootmnt", f.dir)
    .replaceAll("/dev/console", console)
    .replace("printf '\\nPersistence will partition and format %s. Type the full device path to confirm: ' \"$PERSIST_DISK\" >\"$PERSIST_CONSOLE\"", ":")
    .replaceAll('PERSIST_PART="${candidate}5"', `PERSIST_PART='${node}'`)
    .replaceAll('PERSIST_PART="${candidate}p5"', `PERSIST_PART='${node}'`)
    .replaceAll('PERSIST_EXCHANGE_PART="${candidate}4"', "PERSIST_EXCHANGE_PART='/dev/synthetic-disk4'")
    .replaceAll('PERSIST_EXCHANGE_PART="${candidate}p4"', "PERSIST_EXCHANGE_PART='/dev/synthetic-disk4'")
    .replaceAll('PERSIST_PART="${candidate}p5"', `PERSIST_PART='${node}'`)
    .replaceAll('[ -b "$PERSIST_PART" ]', '[ -e "$PERSIST_PART" ]');
  const script = join(f.dir, "create.sh");
  if (options.nodeExists) writeFileSync(node, "SYNTHETIC_FIXTURE_stale_node");
  writeFileSync(script, `${copy}\nPERSIST_DISK='${f.disk}'\nPERSIST_PART='${node}'\nPERSIST_EXCHANGE_PART='/dev/synthetic-disk4'\nPERSIST_CONSOLE='${console}'\n_persist_die(){ printf '%s\\n' "$*"; return 1; }\n_persist_prompt(){ return 0; }\n_persist_find_device(){ return 0; }\n_persist_validate_node(){ [ "$2" = 5 ] && ${options.validateNodeFails ? "return 1" : "return 0"}; return 0; }\n_persist_create\n`);
  chmodSync(script, 0o755);
  return { result: Bun.spawnSync(["bash", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" }), log, node };
}

describe("persistent disk GPT contract", () => {
  test("accepts only the exact four-entry manifest and rejects extra entries", () => {
    const valid = fixture("valid");
    const validResult = verifier(valid);
    expect(validResult.exitCode, `${validResult.stdout.toString()} ${validResult.stderr.toString()}`).toBe(0);
    const extra = fixture("unexpected", `\nstart=229376, size=2048, type=${type[2]}, uuid=55555555-5555-4555-8555-555555555555, name="unexpected"`);
    expect(verifier(extra).exitCode).not.toBe(0);
    const malformed = fixture("manifest-extra");
    writeFileSync(malformed.manifest, readFileSync(malformed.manifest, "utf8") + "unexpected\n");
    expect(verifier(malformed).exitCode).not.toBe(0);
  }, 30000);

  test("real sparse image has stable bytes for all existing partitions before and after validation", () => {
    const f = fixture("bytes");
    const before = f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])));
    const result = verifier(f);
    expect(result.exitCode, `${result.stdout.toString()} ${result.stderr.toString()}`).toBe(0);
    const after = f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])));
    expect(after).toEqual(before);
    expect(Bun.spawnSync(["sfdisk", "--verify", f.disk]).exitCode).toBe(0);
  }, 30000);

  test("actual slot-5 creation preserves every p1-p4 byte and only then requests LUKS formatting", () => {
    const f = fixture("create-happy");
    for (let i = 0; i < 4; i++) {
      const payload = join(f.dir, `payload-${i + 1}`);
      writeFileSync(payload, Buffer.alloc(4096, `SYNTHETIC_FIXTURE_PART_${i + 1}`));
      Bun.spawnSync(["dd", `if=${payload}`, `of=${f.disk}`, "bs=1", `seek=${Number(f.starts[i]) * 512}`, "conv=notrunc", "status=none"]);
    }
    const before = f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])));
    const created = createPersist(f);
    expect(created.result.exitCode, `${created.result.stdout.toString()} ${created.result.stderr.toString()}`).toBe(0);
    const after = f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])));
    expect(after).toEqual(before);
    const dump = Bun.spawnSync(["sfdisk", "--dump", f.disk], { stdout: "pipe" }).stdout.toString();
    expect(dump.match(/name="AISPERSIST"/g)).toHaveLength(1);
    expect(readFileSync(created.log, "utf8")).toContain("luksFormat");
  }, 30000);

  test("stale p5 node without a GPT entry is refused before prompting or writing", () => {
    const f = fixture("stale-node");
    const created = createPersist(f, { nodeExists: true });
    expect(created.result.exitCode).not.toBe(0);
    expect(existsSync(created.log) ? readFileSync(created.log, "utf8") : "").not.toContain("luksFormat");
    expect(Bun.spawnSync(["sfdisk", "--dump", f.disk], { stdout: "pipe" }).stdout.toString()).not.toContain("AISPERSIST");
  }, 30000);

  test("a p5 device that fails identity validation is never formatted", () => {
    const f = fixture("node-identity");
    const created = createPersist(f, { validateNodeFails: true });
    expect(created.result.exitCode).not.toBe(0);
    expect(existsSync(created.log) ? readFileSync(created.log, "utf8") : "").not.toContain("luksFormat");
    expect(Bun.spawnSync(["sfdisk", "--dump", f.disk], { stdout: "pipe" }).stdout.toString()).toContain("AISPERSIST");
  }, 30000);

  test("existing GPT p5 remains unformatted when partx succeeds but its node stays absent", () => {
    const f = fixture("existing-p5-no-node", `\nstart=229376, size=163807, type=${type[2]}, uuid=55555555-5555-4555-8555-555555555555, name="AISPERSIST"`, "192M", false);
    const before = f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])));
    const created = createPersist(f, { partxDoesNotCreate: true });
    expect(created.result.exitCode).not.toBe(0);
    expect(`${created.result.stdout.toString()} ${created.result.stderr.toString()}`).toContain("Existing persistence partition node is unavailable");
    expect(existsSync(created.log) ? readFileSync(created.log, "utf8") : "").not.toContain("luksFormat");
    expect(f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])))).toEqual(before);
    expect(Bun.spawnSync(["sfdisk", "--dump", f.disk], { stdout: "pipe" }).stdout.toString()).toContain("AISPERSIST");
  }, 30000);

  test("the actual node validator accepts the exact GPT identity and rejects every mismatched identity field", () => {
    const f = fixture("node-validator");
    expect(actualNodeValidator(f).exitCode).toBe(0);
    const failures = [
      { uuid: "66666666-6666-4666-8666-666666666666" },
      { start: "229377" },
      { size: "163806" },
      { partition: "4" },
      { parent: "8:1" },
      { missing: true },
    ];
    for (const [index, mismatch] of failures.entries()) {
      expect(actualNodeValidator(fixture(`node-validator-${index}`), mismatch).exitCode).not.toBe(0);
    }
  }, 30000);

  test("pre-existing p5 with a duplicate GUID, wrong extent, or name is rejected by the complete-table verifier", () => {
    const variants = [
      `\nstart=229376, size=32735, type=${type[2]}, uuid=${partGuids[3]}, name="AISPERSIST"`,
      `\nstart=229377, size=32734, type=${type[2]}, uuid=55555555-5555-4555-8555-555555555555, name="AISPERSIST"`,
      `\nstart=229376, size=32735, type=${type[2]}, uuid=55555555-5555-4555-8555-555555555555, name="unexpected"`,
    ];
    for (const [index, extra] of variants.entries()) {
      const f = fixture(`existing-p5-${index}`, extra);
      const result = verifier(f);
      expect(result.exitCode, `${result.stdout.toString()} ${result.stderr.toString()}`).not.toBe(0);
    }
  }, 30000);

  test("an unexpected p5 entry is rejected before any formatting request", () => {
    const f = fixture("unexpected-before-write", `\nstart=229376, size=32735, type=${type[2]}, uuid=55555555-5555-4555-8555-555555555555, name="unexpected"`);
    const created = createPersist(f);
    expect(created.result.exitCode).not.toBe(0);
    expect(existsSync(created.log) ? readFileSync(created.log, "utf8") : "").not.toContain("luksFormat");
  }, 30000);

  test("corrupt primary and backup GPT headers are refused before any partition write", () => {
    for (const [index, headerSector] of [1, 262143].entries()) {
      const f = fixture(`corrupt-gpt-${index}`);
      const fd = openSync(f.disk, "r+");
      const changed = Buffer.from([0x5a]);
      writeSync(fd, changed, 0, 1, headerSector * 512 + 16);
      closeSync(fd);
      const wholeImageBefore = hashImage(f.disk);
      const before = f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])));
      const created = createPersist(f);
      expect(created.result.exitCode).not.toBe(0);
      expect(existsSync(created.log) ? readFileSync(created.log, "utf8") : "").not.toContain("luksFormat");
      expect(f.starts.map((s, i) => hashSlice(f.disk, Number(s), Number(f.sizes[i])))).toEqual(before);
      expect(hashImage(f.disk)).toBe(wholeImageBefore);
      expect(Bun.spawnSync(["sfdisk", "--dump", f.disk], { stdout: "pipe" }).stdout.toString()).not.toContain("AISPERSIST");
    }
  }, 30000);
});
