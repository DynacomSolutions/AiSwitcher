import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
setDefaultTimeout(60_000);

const fakeRunner = `#!/usr/bin/env bash
set -euo pipefail
scenario=$AIS_QEMU_BOOT_FLOW_SCENARIO
attempt=$AIS_QEMU_BOOT_FLOW_ATTEMPT
vendor=$AIS_QEMU_BOOT_FLOW_VENDOR_STATUS
printf 'AIS-LIVE: stage=net status=ok\\n'
if [[ $scenario == offline-* ]]; then
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
printf 'AIS-LIVE-TEST: agent-checks=ok\\n'
if [[ $vendor == ok ]]; then printf 'AIS-LIVE-TEST: vendor-shims=ok\\n'; fi
printf 'AIS-LIVE-TEST: live-checks=ok\\n'
printf 'What do you want to launch?\\n'
stty raw -echo
quit=$(dd bs=1 count=2 2>/dev/null)
[[ $quit == $'\\001x' ]]
`;

async function withRunner<T>(fn: (runner: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ais-qemu-driver-test-"));
  try {
    const runner = join(dir, "synthetic-runner.sh");
    await writeFile(runner, fakeRunner, { mode: 0o755 });
    return await fn(runner);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runDriver(runner: string, scenario: string) {
  const env = {
    ...process.env,
    ...(expectLibraryPath ? { LD_LIBRARY_PATH: expectLibraryPath } : {}),
    AIS_QEMU_BOOT_FLOW_SCENARIO: scenario,
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
    });
  });

  driverTest("drives offline model yes, no, no-model, and timeout flows", async () => {
    await withRunner(async (runner) => {
      for (const [scenario, expected] of [
        ["offline-model-yes", "AIS-LIVE-TEST: local-model=started"],
        ["offline-model-no", "AIS-LIVE: stage=launch status=ok"],
        ["offline-no-model", "AIS-LIVE: stage=launch status=ok"],
        ["offline-model-timeout", "AIS-LIVE: stage=launch status=ok"],
      ]) {
        const result = runDriver(runner, scenario);
        if (result.status !== 0) throw new Error(`${scenario}: ${result.stdout}\n${result.stderr}`);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(expected);
      }
    });
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

  it("validates scenario preparation", () => {
    const plan = spawnSync("/bin/bash", [planner, "online-retry", "43821"], { encoding: "utf8" });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain("kernel_arg=ais.vendor=stub-fail-first");
    expect(plan.stdout).toContain("network=user");
    expect(plan.stdout).toContain("runs=2");
    const invalid = spawnSync("/bin/bash", [planner, "online-first", "0"], { encoding: "utf8" });
    expect(invalid.status).not.toBe(0);
  });
});
