import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "../../image");
const script = join(root, "lib/ais-live-context");
const sandboxes: string[] = [];

async function sandbox(): Promise<string> {
  const testTempRoot = process.env.AIS_TEST_SCRATCH_DIR ?? tmpdir();
  await mkdir(testTempRoot, { recursive: true });
  const path = await mkdtemp(join(testTempRoot, "ais-live-context-SYNTHETIC_FIXTURE-"));
  sandboxes.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(home: string, uid = "4242") {
  const mockBin = join(home, "mock-bin");
  await mkdir(mockBin, { recursive: true });
  await writeFile(join(mockBin, "id"), `#!/bin/sh\nprintf '${uid}\\n'\n`);
  await writeFile(join(mockBin, "getent"), "#!/bin/sh\nprintf 'agent:x:4242:4242::/synthetic/agent\\n'\n");
  await chmod(join(mockBin, "id"), 0o755);
  await chmod(join(mockBin, "getent"), 0o755);
  return spawnSync(script, ["--home", home], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${mockBin}:${process.env.PATH}` },
  });
}

describe("AIS live agent context", () => {
  test("adds and replaces one managed block while preserving surrounding memory", async () => {
    const home = await sandbox();
    const memory = join(home, ".ais/memory/GLOBAL.md");
    const prefix = "# Existing memory\n\nKeep this text.\n";
    const suffix = "\n\nTail stays here.\n";
    await Bun.write(memory, `${prefix}<!-- ais-live:start -->\nold block\n<!-- ais-live:end -->${suffix}`);

    expect((await run(home)).status).toBe(0);
    const first = await Bun.file(memory).text();
    const end = first.indexOf("<!-- ais-live:end -->");
    expect(first.slice(0, first.indexOf("<!-- ais-live:start -->"))).toBe(prefix);
    expect(first.slice(end + "<!-- ais-live:end -->".length)).toBe(suffix);
    expect(first.match(/<!-- ais-live:start -->/g)).toHaveLength(1);
    expect(first.match(/<!-- ais-live:end -->/g)).toHaveLength(1);
    expect(first).toContain("restricted `agent` user");
    expect(first).toContain("AUR installs require approval");
    expect(first).toContain("confirmation popup");
    expect(first).toContain("/opt/ais/models");

    expect((await run(home)).status).toBe(0);
    expect(await Bun.file(memory).text()).toBe(first);
    expect((await stat(memory)).mode & 0o777).toBe(0o600);
  });

  test("adds a separator after existing text without a final newline", async () => {
    const home = await sandbox();
    const memory = join(home, ".ais/memory/GLOBAL.md");
    const original = "Existing text without a final newline";
    await Bun.write(memory, original);

    expect((await run(home)).status).toBe(0);
    const updated = await Bun.file(memory).text();
    expect(updated.startsWith(`${original}\n<!-- ais-live:start -->\n`)).toBe(true);
    expect(updated.match(/<!-- ais-live:start -->/g)).toHaveLength(1);
  });

  test("preserves CRLF bytes around an existing managed block", async () => {
    const home = await sandbox();
    const memory = join(home, ".ais/memory/GLOBAL.md");
    const prefix = "# Existing memory\r\n\r\nKeep this text.\r\n";
    const suffix = "\r\n\r\nTail stays here.\r\n";
    const original = `${prefix}<!-- ais-live:start -->\r\nold block\r\n<!-- ais-live:end -->${suffix}`;
    await Bun.write(memory, original);

    expect((await run(home)).status).toBe(0);
    const updated = await readFile(memory, "utf8");
    const start = updated.indexOf("<!-- ais-live:start -->");
    const end = updated.indexOf("<!-- ais-live:end -->");
    expect(updated.slice(0, start)).toBe(prefix);
    expect(JSON.stringify(updated.slice(end + "<!-- ais-live:end -->".length))).toBe(JSON.stringify(suffix));
    expect(updated.slice(0, start)).toContain("\r\n");
    expect(updated.slice(0, start)).not.toMatch(/(?<!\r)\n/);
  });

  test("rejects a malformed marker block without overwriting the file", async () => {
    const home = await sandbox();
    const memory = join(home, ".ais/memory/GLOBAL.md");
    const original = "prefix\n<!-- ais-live:start -->\nbroken\n";
    await Bun.write(memory, original);
    const result = await run(home);
    expect(result.status).not.toBe(0);
    expect(await Bun.file(memory).text()).toBe(original);
  });

  test("refuses a caller whose UID is not the agent UID, even with a home override", async () => {
    const home = await sandbox();
    const result = await run(home, "4243");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must run as agent");
  });

  test("keeps plugin entrypoint and system integration aligned with runtime paths", async () => {
    const tree = join(root, "archiso/airootfs");
    const manifest = await readFile(join(tree, "home/live/.config/herdr/plugins/ais-guard/herdr-plugin.toml"), "utf8");
    const entrypoint = await readFile(join(tree, "home/live/.config/herdr/plugins/ais-guard/confirm"), "utf8");
    const socket = await readFile(join(tree, "etc/systemd/system/ais-guardd.socket"), "utf8");
    const unit = await readFile(join(tree, "etc/systemd/system/ais-guardd.service"), "utf8");
    const udev = await readFile(join(tree, "etc/udev/rules.d/99-ais-guard.rules"), "utf8");
    const profile = await readFile(join(tree, "etc/profile.d/ais-guard.sh"), "utf8");
    const bootProfile = await readFile(join(tree, "etc/profile.d/ais-live-boot.sh"), "utf8");
    const guardd = await readFile(join(root, "lib/ais-guardd"), "utf8");

    expect(manifest).toContain('id = "ais-guard"');
    expect(manifest).toContain('placement = "overlay"');
    expect(manifest).toContain('command = ["./confirm"]');
    expect(entrypoint).toContain("/usr/local/lib/ais-live/ais-guard-popup");
    expect(socket).toContain("ListenStream=/run/ais-guard.sock");
    expect(socket).toContain("Backlog=8");
    expect(socket).toContain("SocketMode=0666");
    expect(unit).toContain("ExecStart=/usr/local/lib/ais-live/ais-guardd");
    expect(unit).toContain("Group=live");
    expect(unit).toContain("RuntimeDirectory=ais-guard");
    expect(unit).toContain("RuntimeDirectoryMode=0750");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(unit).not.toMatch(/^ProtectSystem=/m);
    expect(unit).not.toMatch(/^ProtectHome=/m);
    expect(unit).not.toMatch(/^PrivateTmp=/m);
    expect(unit).not.toMatch(/^Environment(?:File)?=/m);
    expect(udev).toContain('MODE="0600", OWNER="root", GROUP="root"');
    expect(profile).toContain("/usr/local/guard/bin:$PATH");
    expect(bootProfile).toContain('HERDR_SOCKET_PATH="/run/user/$(/usr/bin/id -u)/herdr.sock"');
    expect(bootProfile).toContain("  export HERDR_SOCKET_PATH\n");
    expect(guardd).toContain("'/usr/local/bin/herdr'");

    const table = await Bun.file(join(root, "lib/ais-guard-table")).text();
    const names = table.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(names).toHaveLength(107);
    const expected = new Set(["pacman", "paru"]);
    for (const line of names) {
      const name = line.split(/\s+/, 1)[0]!;
      expected.add(name);
      const wrapper = join(tree, "usr/local/guard/bin", name);
      expect(await readlink(wrapper)).toBe("/usr/local/lib/ais-live/ais-guard");
    }
    expect(await readlink(join(tree, "usr/local/guard/bin/pacman"))).toBe("/usr/local/lib/ais-live/ais-pacman");
    expect(await readlink(join(tree, "usr/local/guard/bin/paru"))).toBe("/usr/local/lib/ais-live/ais-aur");
    const actual = new Set(await (await import("node:fs/promises")).readdir(join(tree, "usr/local/guard/bin")));
    expect([...actual].sort()).toEqual([...expected].sort());
  });
});
