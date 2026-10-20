import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("../../", import.meta.url);
const expectBin = process.env.AIS_TEST_EXPECT_BIN ?? "expect";
const expectLibraryPath = process.env.AIS_TEST_EXPECT_LIBRARY_PATH;
const expectAvailable = spawnSync(expectBin, ["-v"], {
  encoding: "utf8",
  env: {
    ...process.env,
    ...(expectLibraryPath ? { LD_LIBRARY_PATH: expectLibraryPath } : {}),
  },
}).status === 0;
const driverTest = expectAvailable ? it : it.skip;
const driver = new URL("image/test/boot-flow.exp", root).pathname;
const planner = new URL("image/test/boot-flow-scenario.sh", root).pathname;
const bootFlowExpect = new URL("image/test/boot-flow.exp", root).pathname;
setDefaultTimeout(60_000);

const fakeRunner = `#!/usr/bin/env bash
set -euo pipefail
scenario=$AIS_QEMU_BOOT_FLOW_SCENARIO
attempt=$AIS_QEMU_BOOT_FLOW_ATTEMPT
vendor=$AIS_QEMU_BOOT_FLOW_VENDOR_STATUS
if [[ $scenario == online-second || $scenario == online-retry ]]; then
  if [[ $attempt == 1 ]]; then
    printf 'Create encrypted persistence. Enter a passphrase (at least 12 characters): '
    IFS= read -r -s passphrase
    printf '\\nConfirm passphrase: '
    IFS= read -r -s confirmation
    [[ $passphrase == "$confirmation" ]]
  else
    printf 'AIS persistence passphrase: '
    IFS= read -r -s passphrase
  fi
  printf '\\nAIS-LIVE: stage=persist status=ok mode=latest\\n'
fi
printf 'AIS-LIVE: stage=net status=ok\\n'
if [[ $scenario == offline-* ]]; then
  printf 'NetworkManager TUI\\n'
  stty raw -echo
  IFS= read -r -n 1 escape
  printf 'AIS-LIVE: stage=net-prompt status=ok\\n'
  if [[ $scenario != offline-no-model ]]; then
    printf 'Launch the local model for help? [y/N] '
    if [[ $scenario == offline-model-timeout ]]; then
      sleep 3
      printf '\\nAIS-LIVE: stage=local-model-offer status=ok\\n'
    else
      IFS= read -r -n 1 answer
      IFS= read -r -n 1 carriage_return
      if [[ $answer == y ]]; then
        printf 'AIS-LIVE-TEST: local-model=started\\n'
      fi
      printf '\\nAIS-LIVE: stage=local-model-offer status=ok\\n'
    fi
  else
    printf 'AIS-LIVE: stage=local-model-offer status=skip\\n'
  fi
  vendor=skip
  printf 'AIS-LIVE: stage=vendor-cli-install status=%s\\n' "$vendor"
else
  printf 'AIS-LIVE: stage=net-prompt status=skip\\nAIS-LIVE: stage=local-model-offer status=skip\\n'
  printf 'AIS-LIVE: stage=vendor-cli-install status=%s\\n' "$vendor"
fi
printf 'AIS-LIVE: stage=launch status=ok\\n'
if [[ \${AIS_TEST_AGENT_CHECK_FAIL:-0} == 1 ]]; then
  stty -opost
  printf 'AIS-LIVE-TEST: agent-checks=fail reason=console-start\\r\\r\\n'
  exit 1
fi
printf 'AIS-LIVE-TEST: agent-checks=ok\\n'
if [[ $vendor == ok ]]; then printf 'AIS-LIVE-TEST: vendor-shims=ok\\n'; fi
printf 'AIS-LIVE-TEST: live-checks=ok\\n'
if [[ $scenario == offline-no-model || $scenario == online-* || $scenario == accounts || $scenario == vendor || $scenario == c7 ]]; then
  printf 'Nothing to launch: no installed tool has an active identity and no local model is ready.\\n'
else
  printf 'What do you want to launch?\\n'
fi
stty raw -echo
quit=$(dd bs=1 count=2 2>/dev/null)
[[ $quit == $'\\001x' ]]
`;

async function withRunner<T>(fn: (runner: string) => Promise<T>): Promise<T> {
  const testTempRoot = process.env.AIS_TEST_SCRATCH_DIR ?? tmpdir();
  await mkdir(testTempRoot, { recursive: true });
  const dir = await mkdtemp(join(testTempRoot, "ais-qemu-driver-test-"));
  try {
    const runner = join(dir, "synthetic-runner.sh");
    await writeFile(runner, fakeRunner, { mode: 0o755 });
    return await fn(runner);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runDriver(runner: string, scenario: string, extra: Record<string, string> = {}) {
  const env = {
    ...process.env,
    ...(expectLibraryPath ? { LD_LIBRARY_PATH: expectLibraryPath } : {}),
    AIS_QEMU_BOOT_FLOW_SCENARIO: scenario,
    ...extra,
  };
  return spawnSync(expectBin, [driver, "12", runner], {
    encoding: "utf8",
    timeout: 30_000,
    env,
  });
}

describe("QEMU boot flow driver", () => {
  driverTest("executes the actual expect driver against a synthetic runner and checks stage order", async () => {
    await withRunner(async (runner) => {
      const result = runDriver(runner, "online-first");
      if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
      expect(result.status).toBe(0);
      const markers = result.stdout.split(/\r?\n/).filter((line) => line.includes("AIS-LIVE"));
      expect(markers).toEqual([
        "AIS-LIVE: stage=net status=ok",
        "AIS-LIVE: stage=net-prompt status=skip",
        "AIS-LIVE: stage=local-model-offer status=skip",
        "AIS-LIVE: stage=vendor-cli-install status=ok",
        "AIS-LIVE: stage=launch status=ok",
        "AIS-LIVE-TEST: agent-checks=ok",
        "AIS-LIVE-TEST: vendor-shims=ok",
        "AIS-LIVE-TEST: live-checks=ok",
      ]);
      expect(result.stdout).toContain("Nothing to launch: no installed tool has an active identity");
      expect(result.stdout).not.toContain("What do you want to launch?");
    });
  });

  driverTest("drives offline model yes, no, no-model, and timeout flows", async () => {
    await withRunner(async (runner) => {
      for (const [scenario, expected] of [
        ["offline-model-yes", "AIS-LIVE-TEST: local-model=started"],
        ["offline-model-no", "AIS-LIVE: stage=launch status=ok"],
        ["offline-no-model", "Nothing to launch: no installed tool has an active identity"],
        ["offline-model-timeout", "AIS-LIVE: stage=launch status=ok"],
      ]) {
        const result = runDriver(runner, scenario);
        if (result.status !== 0) throw new Error(`${scenario}: ${result.stdout}\n${result.stderr}`);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(expected);
      }
    });
  });

  driverTest("waits for the NetworkManager TUI before sending Escape", async () => {
    const source = await readFile(bootFlowExpect, "utf8");
    expect(source).toMatch(/waitFor \{NetworkManager TUI\} "NetworkManager TUI readiness"[\s\S]*?send -- "\\033"/);
  });

  driverTest("reuses one QEMU command for both boots in second-boot and retry cases", async () => {
    await withRunner(async (runner) => {
      for (const scenario of ["online-second", "online-retry"]) {
        const result = runDriver(runner, scenario);
        expect(result.status).toBe(0);
        expect(result.stdout.match(/AIS-LIVE: stage=net status=ok/g)).toHaveLength(2);
        expect(result.stdout.match(/AIS-LIVE-TEST: live-checks=ok/g)).toHaveLength(2);
      }
    });
  });

  driverTest("fails on a missing guest marker and validates scenario preparation", async () => {
    await withRunner(async (runner) => {
      const broken = await readFile(runner, "utf8");
      await writeFile(runner, broken.replace("AIS-LIVE: stage=launch status=ok\\n", "AIS-LIVE: stage=launch status=fail\\n"));
      const result = runDriver(runner, "online-first");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("guest reported failure while waiting for launch stage");
    });
  });

  driverTest("fails immediately on a CRCRLF agent-check failure and keeps its full reason", async () => {
    await withRunner(async (runner) => {
      const result = runDriver(runner, "online-first", { AIS_TEST_AGENT_CHECK_FAIL: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("agent-checks=fail reason=console-start");
    });
  });

  it("retains bounded console status diagnostics on startup failure", async () => {
    const checks = await readFile(new URL("../../image/test/boot-flow-agent-checks", import.meta.url), "utf8");
    expect(checks).toContain("/usr/bin/ais web status >&2 || true");
    expect(checks).not.toContain("/usr/bin/ais web --foreground");
    expect(checks).not.toContain("server.json");
  });

  driverTest("fails immediately on guest password expiry or login failure", async () => {
    await withRunner(async (runner) => {
      const original = await readFile(runner, "utf8");
      for (const [prompt, expected] of [
        ["You are required to change your password immediately (administrator enforced).", "guest account is blocked by forced password expiry"],
        ["Login incorrect", "guest account login failed"],
      ]) {
        await writeFile(runner, original.replace(
          "printf 'AIS-LIVE: stage=net status=ok\\n'",
          `printf '${prompt}\\n'\nprintf 'AIS-LIVE: stage=net status=ok\\n'`,
        ));
        const result = runDriver(runner, "online-first");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expected);
      }
    });
  });

  driverTest("fails immediately when a validated boot identity falls back to ephemeral storage", async () => {
    await withRunner(async (runner) => {
      const original = await readFile(runner, "utf8");
      const cases = [
        ["online-first", "printf 'AIS-LIVE: stage=net status=ok\\n'", "printf 'AIS-LIVE: stage=persist status=ephemeral reason=wrong-drive mode=clean\\n'\\nprintf 'AIS-LIVE: stage=net status=ok\\n'", "clean"],
        ["online-second", "AIS-LIVE: stage=persist status=ok mode=latest", "AIS-LIVE: stage=persist status=ephemeral reason=wrong-drive mode=latest", "latest"],
      ] as const;
      for (const [scenario, needle, replacement, mode] of cases) {
        await writeFile(runner, original.replace(needle, replacement));
        const result = runDriver(runner, scenario);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`guest lost validated persistence identity in ${mode} mode`);
      }
    });
  });

  it("validates scenario preparation", () => {
    const plan = spawnSync("/bin/bash", [planner, "online-retry", "43821"], { encoding: "utf8" });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain("kernel_arg=ais.vendor=stub-fail-first");
    expect(plan.stdout).toContain("network=user");
    expect(plan.stdout).toContain("runs=2");
    expect(plan.stdout).not.toMatch(/kernel_arg=(ais\.test|ais\.mode)=/);
    const invalid = spawnSync("/bin/bash", [planner, "online-first", "0"], { encoding: "utf8" });
    expect(invalid.status).not.toBe(0);
  });

  it("keeps scenario identity and boot mode out of appended kernel arguments", () => {
    for (const scenario of ["offline-model-yes", "offline-no-model"]) {
      const plan = spawnSync("/bin/bash", [planner, scenario], { encoding: "utf8" });
      expect(plan.status).toBe(0);
      expect(plan.stdout).not.toMatch(/kernel_arg=(ais\.test|ais\.mode|ais\.exchange)=/);
    }
    const harness = readFileSync("image/test/run-scenario.sh", "utf8");
    const qemu = readFileSync("image/test/run-qemu.sh", "utf8");
    expect(harness).not.toContain("AIS_TEST_ARGS=\"ais.exchange=");
    expect(harness).toContain("AIS_QMP_EXPECT_BOOTS=${boots:-1}");
    expect(qemu).toContain("prepare-persist-drive.sh");
    expect(qemu).toContain("cow_*");
    expect(qemu).toContain("ais.mode=*");
    expect(readFileSync("image/test/run-scenario.sh", "utf8")).toContain("online-second|online-retry) export AIS_TEST_MODE=latest");
    expect(readFileSync("image/test/boot-flow.exp", "utf8")).toContain("unix:boot-flow.qmp,server=on,wait=off");
  });

  it("uses latest persistence for exchange fixtures and answers encrypted-drive prompts", () => {
    const scenario = readFileSync("image/test/run-scenario.sh", "utf8");
    const driver = readFileSync("image/test/exchange-driver.exp", "utf8");
    const orchestrator = readFileSync("image/test/exchange-orchestrator", "utf8");
    const scenarios = readFileSync("image/test/exchange-scenarios.sh", "utf8");
    const outboxSequence = readFileSync("image/test/exchange-highest-outbox.mjs", "utf8");
    const mediaBuilder = readFileSync("image/test/make-test-media.sh", "utf8");
    const capabilityProbe = readFileSync("image/test/exchange-capability-probe", "utf8");
    const exchangeExpect = readFileSync("image/test/exchange.exp", "utf8");
    const checks = readFileSync("image/test/boot-flow-live-checks", "utf8");
    const agentChecks = readFileSync("image/test/boot-flow-agent-checks", "utf8");
    expect(scenario).toContain("export AIS_TEST_MODE=latest");
    expect(driver).toContain("SYNTHETIC_FIXTURE_ais_live_persist_passphrase");
    expect(driver).toContain("Create encrypted persistence");
    expect(driver).toContain("AIS persistence passphrase");
    expect(driver).toContain("AIS-LIVE: stage=persist status=ok mode=latest");
    expect(driver).toContain("wait_agent_capability");
    expect(exchangeExpect).toContain("case=agent-capability status=pass\\r*\\n");
    expect(exchangeExpect).toContain("exchange orchestrator failed before case");
    expect(exchangeExpect).toContain("exchange orchestrator failed before capability probe");
    expect(orchestrator).toContain('"$tests/exchange-capability-probe" launch || finish agent-capability-probe-failed');
    expect(mediaBuilder).toContain('"$here/exchange-capability-probe"');
    expect(mediaBuilder).toContain('"$here/exchange-highest-outbox.mjs"');
    expect(scenarios).toContain('node "$HERE/exchange-highest-outbox.mjs" /mnt/aisx/outbox');
    expect(outboxSequence).toContain('if (error?.code === "ENOENT")');
    expect(capabilityProbe).toContain("--property=AmbientCapabilities=CAP_SETUID");
    expect(capabilityProbe).toContain("--property=NoNewPrivileges=yes");
    expect(capabilityProbe).toContain("--property='CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_SETUID CAP_SETGID'");
    expect(capabilityProbe).toContain("/usr/bin/setpriv --reuid=agent --regid=agent --init-groups");
    expect(capabilityProbe).toContain('effective == "0000000000000000" && permitted == "0000000000000000" && ambient == "0000000000000000"');
    expect(driver).toContain('ais_exchange::wait_orchestrator_done $spawn_id');
    expect(exchangeExpect).toContain('serial channel closed before exchange orchestrator completion');
    expect(driver).toContain("set timeout $bootTimeout");
    expect(driver).toContain("set ::ais_exchange::timeout_seconds $bootTimeout");
    expect(driver).not.toMatch(/set timeout (?:600|240)\b/);
    expect(driver).toContain("set cases {boot replay tamper crafted symlink periodic outbox shutdown exfat-readback}");
    const basicCaseOrder = ["run_case periodic", "marker outbox pass", "run_case shutdown", "marker exfat-readback pass"]
      .map((marker) => orchestrator.indexOf(marker));
    expect(basicCaseOrder.every((index) => index >= 0)).toBe(true);
    expect(basicCaseOrder).toEqual([...basicCaseOrder].sort((a, b) => a - b));
    expect(orchestrator).toContain("findmnt -nro SOURCE --target /mnt/aisx");
    expect(orchestrator).toContain('exfat-readback "$exchange_device" "$latest"');
    expect(orchestrator).not.toContain("probe_service_privileges");
    expect(scenarios).toContain("stage=inbox status=skip reason=stale");
    expect(scenarios).not.toContain("stage=inbox status=ok applied=0 skipped=");
    expect(orchestrator).not.toContain("by-label/AISX");
    const bootFlowMedia = mediaBuilder.split("  boot-flow)")[1]?.split("  guard)")[0] ?? "";
    expect(bootFlowMedia).not.toContain("orchestrator");
    expect(bootFlowMedia).not.toContain("exchange-orchestrator");
    expect(checks).toContain("for _ in {1..120}");
    expect(agentChecks).toContain("web_started=true\nif ! /usr/bin/ais web start >/dev/null; then");
    expect(agentChecks).toContain("/usr/bin/ais web status >&2 || true");
    expect(agentChecks).not.toContain("/usr/bin/ais web --foreground");
    expect(agentChecks).not.toContain("/usr/bin/ais web start >/dev/null 2>&1");
    expect(checks).toContain("fail herdr-socket-timeout");
    expect(checks).toContain("stat.S_IMODE(info.st_mode) == 0o600");
    expect(checks).toContain("stat -c '%u:%a' \"$runtime_dir\"");
    expect(checks).toContain("$herdr pane split --direction right --ratio 0.5 --no-focus");
    expect(checks).not.toContain("$herdr pane split --current");
    expect(checks).toContain("outside any Herdr pane");
    expect(checks).toContain("agent_uid=$(/usr/bin/id -u agent)");
    expect(checks).toContain("descendants = {root}");
    expect(checks).toContain("for pid in descendants");
    expect(checks).not.toContain("ps -o user= -p \"$shell_pid\"");
  });

  it("rejects malformed QEMU boot timeout overrides before preparing an image", async () => {
    const testTempRoot = process.env.AIS_TEST_SCRATCH_DIR ?? tmpdir();
    await mkdir(testTempRoot, { recursive: true });
    const dir = await mkdtemp(join(testTempRoot, "ais-qemu-timeout-test-"));
    try {
      const image = join(dir, "synthetic-image.img");
      await writeFile(image, "synthetic fixture");
      for (const value of ["0", "-1", "abc", "100000"]) {
        const result = spawnSync("/bin/bash", ["image/test/run-qemu.sh", image, "bios"], {
          encoding: "utf8",
          env: { ...process.env, AIS_QEMU_TIMEOUT: value, AIS_QEMU_WORK_ROOT: dir },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("AIS_QEMU_TIMEOUT must be a positive integer");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
