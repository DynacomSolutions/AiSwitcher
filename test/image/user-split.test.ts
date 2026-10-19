import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("image account split", () => {
  it("has exactly one constrained sudo operation", async () => {
    const [sudoers, launcher, clean] = await Promise.all([
      read("image/lib/sudoers-ais-live"),
      read("image/lib/ais-agent-pane"),
      read("image/lib/agent-exec-clean"),
    ]);
    expect(sudoers.trim().split("\n")).toEqual(["live ALL=(agent) NOPASSWD: /usr/local/lib/ais-live/agent-exec"]);
    expect(launcher).toContain("probe|probe-fresh|upgrade|local-start|launch|pane");
    expect(launcher).not.toContain('"$@"');
    expect(clean).toContain("id -un)\" != agent");
  });

  it("clears inherited environment before fixed agent dispatch", async () => {
    const exec = await read("image/lib/agent-exec");
    expect(exec).toContain("env -i");
    expect(exec).toContain("HOME=/home/agent");
    expect(exec).toContain("AIS_LIVE=1");
    expect(exec).not.toContain("HERDR_");
  });

  it("applies process and polkit isolation", async () => {
    const [sysctl, polkit, units] = await Promise.all([
      read("image/archiso/airootfs/etc/sysctl.d/90-ais-live-hardening.conf"),
      read("image/archiso/airootfs/etc/polkit-1/rules.d/00-ais-live-agent.rules"),
      read("image/archiso/airootfs/etc/systemd/system/ais-live-hardening.service"),
    ]);
    expect(sysctl).toContain("kernel.yama.ptrace_scope = 2");
    expect(polkit).toContain('subject.user === "agent"');
    expect(polkit).toContain("polkit.Result.NO");
    expect(units).toContain("hidepid=2");
  });

  it("resets and verifies live and agent supplementary groups", async () => {
    const accounts = await read("image/lib/ais-live-accounts");
    expect(accounts).toContain("usermod --groups proc live");
    expect(accounts).toContain("usermod --groups '' agent");
    expect(accounts).toContain("$live_groups \" == *' proc '*");
    expect(accounts).toContain("$live_groups \" != *' disk '*");
    expect(accounts).toContain("$agent_groups \" != *' disk '*");
    expect(accounts).toContain("$agent_groups \" != *' proc '*");
  });

  it("gates fixed test fixture operations on the exact kernel token", async () => {
    const [clean, fixture, service] = await Promise.all([
      read("image/lib/agent-exec-clean"),
      read("image/lib/ais-live-test-fixtures"),
      read("image/archiso/airootfs/etc/systemd/system/ais-live-test-fixtures.service"),
    ]);
    expect(clean).toContain("ais.test=1");
    expect(clean).toContain("ais.vendor=stub-fail-first");
    expect(clean).toContain("AIS_TEST_VENDOR_MODE=\"$vendor_mode\"");
    expect(clean).toContain("AIS_TEST_VENDOR_COUNTER=/home/agent/.ais/live/vendor-stub.calls");
    expect(clean).toContain("test assertion operation requires ais.test=1");
    expect(fixture).toContain("ais.test=1");
    expect(fixture).toContain("/mnt/aisx/test-fixtures");
    expect(fixture).toContain('[[ -f "$source_file" && ! -L "$source_file" && -r "$source_file" ]]');
    expect(fixture).not.toContain('-x "$source_file"');
    expect(fixture).toContain('/usr/bin/install -o root -g root -m 0755 "$source_dir/$fixture" "$target_dir/$fixture"');
    expect(service).toContain("ais-live-test-fixtures");
  });
});
