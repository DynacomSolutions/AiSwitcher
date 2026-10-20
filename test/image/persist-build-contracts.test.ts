import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ais-persist-contracts-"));
const generator = resolve("image/archiso/persist-contracts.sh");
const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(args, {
  env: { ...process.env, ...env },
  stdout: "pipe",
  stderr: "pipe",
});

describe("persist build contracts", () => {
  test("agent IDs come from the actual passwd and group records", () => {
    const passwd = join(root, "passwd");
    const group = join(root, "group");
    const output = join(root, "contracts/agent-ids");
    writeFileSync(passwd, "root:x:0:0:root:/var/empty/root:/bin/bash\nagent:x:2501:2502:Agent:/var/empty/agent:/bin/bash\n");
    writeFileSync(group, "root:x:0:\nagent:x:2502:\n");

    const result = run(["bash", generator, "agent-ids", passwd, group, output]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("uid=2501\ngid=2502\n");
  });

  test("missing or inconsistent account definitions fail without inventing IDs", () => {
    const passwd = join(root, "missing-passwd");
    const group = join(root, "missing-group");
    const output = join(root, "contracts/missing-agent-ids");
    mkdirSync(join(root, "contracts"), { recursive: true });
    writeFileSync(passwd, "root:x:0:0:root:/root:/bin/bash\n");
    writeFileSync(group, "root:x:0:\n");

    const result = run(["bash", generator, "agent-ids", passwd, group, output]);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(output)).toBe(false);
    expect(result.stderr.toString()).toContain("agent account must exist exactly once");
  });

  test("missing assembled image fails without emitting a GPT contract", () => {
    const image = join(root, "missing-assembled.img");
    const output = join(root, "contracts/missing-gpt-layout");
    const dump = join(root, "work/missing-sfdisk.json");

    const result = run(["bash", generator, "gpt-layout", image, output, dump]);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(output)).toBe(false);
    expect(result.stderr.toString()).toContain("missing assembled disk image");
  });

  test("profile generation fails when account inputs are absent", () => {
    const profile = join(root, "build/profile");
    mkdirSync(join(profile, "airootfs/etc"), { recursive: true });
    cpSync(resolve("image/archiso/profiledef.sh"), join(profile, "profiledef.sh"));
    cpSync(resolve("image/archiso/persist-contracts.sh"), join(profile, "persist-contracts.sh"));

    const result = run(["bash", join(profile, "profiledef.sh")], { SOURCE_DATE_EPOCH: "1792368000" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("missing account definitions");
    expect(existsSync(join(profile, "airootfs/etc/ais-live/agent-ids"))).toBe(false);
  });

  test("the real build preparation supplies accounts and the compiled recovery gate before profile generation", () => {
    const profile = join(root, "build/production-profile");
    cpSync(resolve("image/archiso"), profile, { recursive: true });
    const prepared = run(["bash", join(profile, "prepare-profile.sh"), profile]);
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
    const result = run(["bash", join(profile, "profiledef.sh")], { SOURCE_DATE_EPOCH: "1792368000" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(profile, "airootfs/etc/ais-live/agent-ids"), "utf8")).toBe("uid=1001\ngid=1001\n");
    expect(readFileSync(join(profile, "airootfs/etc/passwd"), "utf8")).toContain("agent:x:1001:1001:");
    expect(readFileSync(join(profile, "airootfs/etc/group"), "utf8")).toContain("agent:x:1001:");
    expect(readFileSync(join(profile, "airootfs/etc/shadow"), "utf8")).toContain("agent:!:");
    expect(run([join(profile, "airootfs/usr/local/bin/ais-gpt-check")]).stderr.toString()).toContain("usage: ais-gpt-check");
    expect(readlinkSync(join(profile, "airootfs/etc/systemd/system/multi-user.target.wants/ais-live-exchange.service"))).toBe("../ais-live-exchange.service");
    const build = readFileSync("image/build/build.sh", "utf8");
    expect(build.indexOf("in_root bash /build/profile/prepare-profile.sh")).toBeLessThan(build.indexOf("in_root mkarchiso"));
    expect(run(["bash", join(profile, "prepare-profile.sh"), profile]).exitCode).not.toBe(0);
  });

  test("gpt-layout is rendered from the assembled image's actual partition table", () => {
    const image = join(root, "assembled.img");
    const layout = join(root, "sfdisk.layout");
    const dump = join(root, "work/sfdisk.json");
    const output = join(root, "base/ais-live/gpt-layout");
    writeFileSync(image, "");
    truncateSync(image, 512_000_000);
    writeFileSync(layout, [
      "label: gpt",
      "unit: sectors",
      "sector-size: 512",
      "",
      "start=2048, size=2048, type=21686148-6449-6E6F-744E-656564454649, name=BIOS",
      "start=4096, size=262144, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name=AISBOOT, attrs=LegacyBIOSBootable",
      "start=266240, size=524288, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name=AISBASE",
      "start=790528, size=65536, type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name=AISX",
      "",
    ].join("\n"));
    const createTable = run(["bash", "-c", 'sfdisk "$1" < "$2"', "contract-test", image, layout]);
    expect(createTable.exitCode).toBe(0);

    const result = run(["bash", generator, "gpt-layout", image, output, dump]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const manifest = readFileSync(output, "utf8").trimEnd().split("\n");
    const actual = JSON.parse(readFileSync(dump, "utf8")).partitiontable;
    expect(manifest).toHaveLength(6);
    expect(manifest[0]).toBe("AIS-GPT-LAYOUT\t1");
    expect(manifest[1]).toBe(`disk-guid\t${actual.id.toLowerCase()}`);
    for (const [index, partition] of actual.partitions.entries()) {
      expect(manifest[index + 2]).toBe([
        "part", String(index + 1), String(partition.start), String(partition.size),
        partition.type.toLowerCase(), partition.uuid.toLowerCase(), partition.name,
        partition.attrs ?? "-",
      ].join("\t"));
    }
    const duplicateUuid = run(["sfdisk", "--part-uuid", image, "2", actual.partitions[0].uuid]);
    expect(duplicateUuid.exitCode).toBe(0);
    const rejectedOutput = join(root, "base/ais-live/duplicate-gpt-layout");
    const rejected = run(["bash", generator, "gpt-layout", image, rejectedOutput, join(root, "work/duplicate-sfdisk.json")]);
    expect(rejected.exitCode).not.toBe(0);
    expect(existsSync(rejectedOutput)).toBe(false);
  });
});
