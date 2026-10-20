import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
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

  test("the real build preparation supplies accounts and no recovery executable before profile generation", () => {
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
    expect(existsSync(join(profile, "airootfs/usr/local/bin/ais-gpt-check"))).toBe(false);
    expect(readlinkSync(join(profile, "airootfs/etc/systemd/system/multi-user.target.wants/ais-live-exchange.service"))).toBe("../ais-live-exchange.service");
    const build = readFileSync("image/build/build.sh", "utf8");
    expect(build.indexOf("in_root bash /build/profile/prepare-profile.sh")).toBeLessThan(build.indexOf("in_root mkarchiso"));
    expect(run(["bash", join(profile, "prepare-profile.sh"), profile]).exitCode).not.toBe(0);
  });
});
