import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";

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

  it("checks logind directly and verifies polkit through bounded D-Bus activation", async () => {
    const [checks, agentChecks] = await Promise.all([
      read("image/test/boot-flow-live-checks"),
      read("image/test/boot-flow-agent-checks"),
    ]);
    expect(checks).toContain("systemctl is-active --quiet systemd-logind || fail systemd-logind-readiness");
    expect(checks).toContain("timeout --foreground 5 /usr/bin/busctl --system call");
    expect(checks).toContain("org.freedesktop.DBus.Peer Ping >/dev/null || fail polkit-dbus-activation");
    expect(checks.indexOf("org.freedesktop.DBus.Peer Ping")).toBeLessThan(checks.indexOf("systemctl is-active --quiet polkit"));
    expect(agentChecks).toContain("if /usr/bin/pkexec true </dev/null >/dev/null 2>&1; then fail pkexec; fi");
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

  it("creates the clean home as agent before installing shims as that user", async () => {
    const [accounts, service, installer, qemu] = await Promise.all([
      read("image/lib/ais-live-accounts"),
      read("image/archiso/airootfs/etc/systemd/system/ais-live-agent-shims.service"),
      read("image/lib/install-agent-shims"),
      read("image/test/run-qemu.sh"),
    ]);
    expect(qemu).toContain("mode=${AIS_TEST_MODE:-clean}");
    expect(accounts).toContain('[[ "$kernel_arg" == ais.mode=clean ]]');
    expect(accounts).toContain('[[ "$clean_mode" == true && ! -e /home/agent ]]');
    expect(accounts).toContain("/usr/bin/install -d -o agent -g agent -m 0700 /home/agent");
    expect(service).toContain("Requires=ais-live-accounts.service");
    expect(service).toContain("After=local-fs.target ais-live-accounts.service");
    expect(service).toContain("User=agent\nGroup=agent");
    expect(installer).toStartWith("#!/bin/bash -p\n");
    expect(installer).toContain('[[ "$(/usr/bin/id -un)" != agent ]]');
    expect(installer).toContain('[[ -f "$source_file" && ! -L "$source_file" && -x "$source_file" ]]');
    expect(installer).toContain('[[ "$(/usr/bin/stat -c \'%u:%a\' "$source_file")" == 0:* ]]');
  });

  it("links bundled shims without copying their runtimes into the small clean overlay", async () => {
    const installer = await read("image/lib/install-agent-shims");
    expect(installer).toContain("source_dir=/usr/lib/ais-live/shims");
    expect(installer).toContain("target_dir=/home/agent/.local/bin");
    expect(installer).toContain("readonly -a shims=(claude codex grok kimi zai ali pi opencode)");
    expect(installer).toContain('/usr/bin/install -d -m 0700 "$target_dir"');
    expect(installer).toContain('/usr/bin/ln -sfnT -- "$source_dir/$shim" "$target_dir/$shim"');
    expect(installer).not.toContain('/usr/bin/install -m 0755 "$source_dir/$shim"');
    expect(installer.indexOf("image shim is not root-owned")).toBeLessThan(installer.indexOf("/usr/bin/ln"));
  });

  it("drains herdr plugin listings so pipefail cannot mistake a match for failure", async () => {
    const accounts = await read("image/lib/ais-live-accounts");
    const checks = accounts.split("\n").filter((line) => line.includes("herdr_as_live plugin list"));
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check).toContain("| /usr/bin/grep -F ais-guard >/dev/null");
      expect(check).not.toContain("grep -q");
    }
    const helper = accounts.split("herdr_as_live() {")[1]?.split("\n  }", 1)[0] ?? "";
    expect(helper).toContain("/usr/bin/setpriv --reuid=live --regid=live --init-groups");
    expect(helper).toContain("/usr/bin/env -i");
    expect(helper).toContain("HERDR_SOCKET_PATH=\"$runtime_dir/herdr.sock\"");
    expect(helper).toContain("/usr/local/bin/herdr \"$@\"");
    expect(helper).not.toContain("runuser");
  });

  it("keeps both login consoles available after shim failure without bypassing isolation", async () => {
    for (const getty of ["getty@tty1", "serial-getty@"]) {
      const dropIn = await read(`image/archiso/airootfs/etc/systemd/system/${getty}.service.d/ais-live-autologin.conf`);
      const values = (key: string) => dropIn.split("\n")
        .filter((line) => line.startsWith(`${key}=`))
        .flatMap((line) => line.slice(key.length + 1).trim().split(/\s+/));
      expect(values("Requires")).toEqual(["ais-live-accounts.service", "ais-live-hardening.service"]);
      expect(values("Wants")).toContain("ais-live-agent-shims.service");
      for (const dependency of ["ais-live-accounts.service", "ais-live-hardening.service", "ais-live-agent-shims.service"]) {
        expect(values("After")).toContain(dependency);
      }
      if (getty === "serial-getty@") {
        expect(dropIn.split("\n").filter((line) => line === "After=ais-live-accounts.service ais-live-hardening.service ais-live-agent-shims.service ais-live-models.service ais-live-test-fixtures.service ais-live-test-media.service")).toHaveLength(1);
        expect(dropIn).toContain("ConditionPathExists=!/usr/local/lib/ais-live-test/orchestrator");
      }
    }
  });

  it("retains only the ambient setuid capability for isolated exchange operations", async () => {
    for (const service of ["ais-live-inbox", "ais-live-outbox", "ais-live-outbox-shutdown"]) {
      const unit = await read(`image/archiso/airootfs/etc/systemd/system/${service}.service`);
      expect(unit.split("\n").filter((line) => line === "AmbientCapabilities=CAP_SETUID")).toHaveLength(1);
      expect(unit).toContain("NoNewPrivileges=yes");
      expect(unit).toContain("CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_SETUID CAP_SETGID");
      expect(unit).toContain("RestrictAddressFamilies=");
    }
  });

  it("sends every live service's errors to the journal and boot console", async () => {
    const unitDir = "image/archiso/airootfs/etc/systemd/system";
    const services = (await readdir(new URL(unitDir, root))).filter((name) => /^ais-live-.*\.service$/.test(name));
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      const unit = await read(`${unitDir}/${service}`);
      const serviceSection = unit.split("[Service]\n")[1]?.split(/\n\[/)[0];
      expect(serviceSection).toContain("StandardError=journal+console\n");
    }
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
    expect(clean).toContain('cd -- "$HOME"');
    expect(clean.indexOf('[[ "$(/usr/bin/id -un)" != agent ]]')).toBeLessThan(clean.indexOf('cd -- "$HOME"'));
    expect(fixture).toContain("ais.test=1");
    expect(fixture).toContain("/run/ais-live-test-media/exchange/test-fixtures");
    expect(fixture).toContain('[[ -f "$source_file" && ! -L "$source_file" && -r "$source_file" ]]');
    expect(fixture).not.toContain('-x "$source_file"');
    expect(fixture).toContain('/usr/bin/install -o root -g root -m 0755 "$source_dir/$fixture" "$target_dir/$fixture"');
    expect(service).toContain("ais-live-test-fixtures");
  });
});
