import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = tmpdir();
const root = "image/archiso/airootfs";

function unit(path: string) { return readFileSync(resolve(root, path), "utf8"); }

describe("persistent image mount contract", () => {
  test("persistent mounts retain their fixed destinations and restrictions", () => {
    const hook = unit("etc/initcpio/hooks/ais_persist");
    expect(hook).toContain('mount -o remount,bind,rw,noexec,nodev,nosuid /run/ais-persist "$newroot/mnt/persist"');
    expect(hook).toContain('mount --bind /run/ais-persist/@config "$newroot/home/agent"');
    expect(hook).toContain('mount --bind /run/ais-persist/@logs "$newroot/var/log/ais"');
    expect(hook).toContain('mount --bind /run/ais-persist/@snapshots "$newroot/.snapshots"');
    expect(hook).not.toContain("/opt/ais/models");
  });

  test("fresh config ownership uses the generated agent ID contract", () => {
    const hook = unit("etc/initcpio/hooks/ais_persist");
    const start = hook.indexOf("    ids=/run/archiso/airootfs/etc/ais-live/agent-ids");
    const end = hook.indexOf("    PERSIST_UPPER=", start);
    const ownership = hook.slice(start, end);
    expect(ownership).toContain('awk ');
    expect(ownership).toContain('chown "$owner" /run/ais-persist/@config');
    expect(ownership).toContain('stat -c \'%u:%g\' /run/ais-persist/@config');
    expect(ownership).not.toContain("1001");

    const dir = join(scratch, "generated-agent-contract");
    mkdirSync(join(dir, "@pkglist"), { recursive: true });
    mkdirSync(join(dir, "@config"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    const passwd = join(dir, "passwd");
    const group = join(dir, "group");
    const ids = join(dir, "agent-ids");
    const log = join(dir, "chown.log");
    const generator = resolve("image/archiso/persist-contracts.sh");
    writeFileSync(passwd, "agent:x:2468:2469:SYNTHETIC_FIXTURE_agent:/var/empty/agent:/bin/sh\n");
    writeFileSync(group, "agent:x:2469:\n");
    const generated = Bun.spawnSync(["bash", generator, "agent-ids", passwd, group, ids], { stdout: "pipe", stderr: "pipe" });
    expect(generated.exitCode, generated.stderr.toString()).toBe(0);
    expect(readFileSync(ids, "utf8")).toBe("uid=2468\ngid=2469\n");

    const chown = join(dir, "bin/chown");
    const stat = join(dir, "bin/stat");
    writeFileSync(chown, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    writeFileSync(stat, "#!/bin/sh\nprintf '2468:2469\\n'\n");
    chmodSync(chown, 0o755);
    chmodSync(stat, 0o755);
    const snippet = ownership
      .replace("/run/archiso/airootfs/etc/ais-live/agent-ids", ids)
      .replaceAll("/run/ais-agent-ids", join(dir, "parsed-agent-ids"))
      .replaceAll("/run/ais-persist", dir);
    const script = join(dir, "ownership.sh");
    writeFileSync(script, `#!/bin/bash\n_persist_die(){ printf '%s\\n' "$*" >&2; exit 20; }\n${snippet}`);
    const validate = () => Bun.spawnSync(["bash", script], {
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    const ownerResult = validate();
    expect(ownerResult.exitCode, `${ownerResult.stdout.toString()} ${ownerResult.stderr.toString()}`).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("2468:2469");

    writeFileSync(passwd, "agent:x:2468:2470:SYNTHETIC_FIXTURE_agent:/var/empty/agent:/bin/sh\n");
    expect(Bun.spawnSync(["bash", generator, "agent-ids", passwd, group, ids], { stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);
  });

  test("exchange service resolves and verifies the boot disk p4 afresh", () => {
    const service = unit("etc/systemd/system/ais-live-exchange.service");
    const resolver = unit("usr/local/lib/ais-live/resolve-boot-partition");
    const hook = unit("etc/initcpio/hooks/ais_persist");
    expect(service).toContain("ExecStart=/usr/local/lib/ais-live/resolve-boot-partition exchange");
    expect(service).toContain("DefaultDependencies=no");
    expect(service).toContain("After=local-fs.target");
    expect(service).toContain("WantedBy=multi-user.target");
    expect(service).not.toContain("What=");
    expect(resolver).toContain("_persist_resolve");
    expect(resolver).toContain("_exchange_resolve");
    expect(resolver).toContain('mount -t exfat -o rw,uid=0,gid=0,dmask=0077,fmask=0177,nosuid,nodev,noexec "$EXCHANGE_PART" /mnt/aisx');
    expect(resolver).toContain("ais-persist-ephemeral");
    expect(hook).not.toContain("-t exfat");
    expect(hook).not.toContain("/dev/disk/by-label/AISX");
  });
});
