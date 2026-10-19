import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ais-mount-contract-SYNTHETIC_FIXTURE-"));
const root = "image/archiso/airootfs";

function unit(path: string) { return readFileSync(resolve(root, path), "utf8"); }

describe("persistent image mount contract", () => {
  test("mount fragments match the fixed Revision 2 destinations and restrictions", () => {
    const hook = readFileSync(resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist"), "utf8");
    const exchange = unit("etc/systemd/system/mnt-aisx.mount");
    expect(hook).toContain('mount -o remount,bind,rw,noexec,nodev,nosuid /run/ais-persist "$newroot/mnt/persist"');
    expect(hook).toContain('mount --bind /run/ais-persist/@config "$newroot/home/agent"');
    expect(hook).toContain('mount --bind /run/ais-persist/@logs "$newroot/var/log/ais"');
    expect(hook).toContain('mount --bind /run/ais-persist/@snapshots "$newroot/.snapshots"');
    expect(hook).toContain('mount -t exfat -o rw,uid=0,gid=0,dmask=0077,fmask=0177,nosuid,nodev,noexec "$exchange_part" "$newroot/mnt/aisx"');
    expect(exchange).toContain("Where=/mnt/aisx");
    expect(exchange).toContain("What=/run/ais-live-exchange-device");
    expect(exchange).not.toMatch(/LABEL=|UUID=/);
    expect(hook).not.toContain("/opt/ais/models");
  });

  test("fresh persistent config ownership uses the fixed synthetic agent contract and rejects invalid IDs", () => {
    const hook = readFileSync(resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist"), "utf8");
    const start = hook.indexOf("    ids=/run/archiso/airootfs/etc/ais-live/agent-ids");
    const end = hook.indexOf("    PERSIST_UPPER=", start);
    const ownership = hook.slice(start, end);
    expect(ownership).toContain("chown \"$owner\" /run/ais-persist/@config");
    expect(ownership).toContain("printf 'uid=1001\\ngid=1001\\n' | cmp -s - \"$ids\"");
    const dir = mkdtempSync(join(tmpdir(), "ais-owner-SYNTHETIC_FIXTURE-"));
    mkdirSync(join(dir, "@pkglist"), { recursive: true });
    mkdirSync(join(dir, "@config"), { recursive: true });
    const ids = join(dir, "agent-ids");
    const log = join(dir, "chown.log");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const chown = join(bin, "chown");
    writeFileSync(chown, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    chmodSync(chown, 0o755);
    writeFileSync(join(bin, "stat"), "#!/bin/sh\nprintf '1001:1001\\n'\n");
    chmodSync(join(bin, "stat"), 0o755);
    const snippet = ownership
      .replace("/run/archiso/airootfs/etc/ais-live/agent-ids", ids)
      .replaceAll("/run/ais-persist", dir);
    writeFileSync(join(dir, "ownership.sh"), `#!/bin/bash\n_persist_die(){ exit 20; }\n${snippet}`);
    const validate = (value: string) => {
      writeFileSync(ids, value);
      return Bun.spawnSync(["bash", join(dir, "ownership.sh")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
      });
    };
    expect(validate("uid=1001\ngid=1001\n").exitCode).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("1001:1001");
    expect(validate("uid=1001\ngid=1002\n").exitCode).not.toBe(0);
    expect(validate("").exitCode).not.toBe(0);
  });

  test("exchange mount resolves the boot disk p4 device and has no global label discovery", () => {
    const exchange = unit("etc/systemd/system/mnt-aisx.mount");
    const hook = readFileSync(resolve("image/archiso/airootfs/etc/initcpio/hooks/ais_persist"), "utf8");
    expect(exchange).toContain("What=/run/ais-live-exchange-device");
    expect(exchange).not.toMatch(/LABEL=|UUID=/);
    expect(hook).toContain("PERSIST_EXCHANGE_PART=\"${candidate}4\"");
    expect(hook).toContain("/run/ais-live-exchange-device");
  });
});
