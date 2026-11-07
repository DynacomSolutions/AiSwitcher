import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureUsageCollectorServiceForFullInstall,
  installUsageCollectorService,
  USAGE_COLLECTOR_SERVICE_NAME,
  USAGE_COLLECTOR_UNIT,
  usageCollectorUnit,
} from "../../../src/cli/usage/collector-service.ts";
import { finalizeInstall } from "../../../scripts/install.ts";

const tempDirs: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-usage-service-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("renders a bounded generic user unit for the installed AIS command", () => {
  expect(USAGE_COLLECTOR_UNIT).toContain("ExecStart=%h/.local/bin/ais __usage_snapshot_daemon");
  expect(USAGE_COLLECTOR_UNIT).toContain("Environment=AIS_USAGE_COLLECTOR_MODE=external");
  expect(USAGE_COLLECTOR_UNIT).not.toContain("After=default.target");
  expect(USAGE_COLLECTOR_UNIT).toContain("Restart=on-failure");
  expect(USAGE_COLLECTOR_UNIT).toContain("MemoryHigh=8G");
  expect(USAGE_COLLECTOR_UNIT).toContain("MemoryMax=12G");
  expect(USAGE_COLLECTOR_UNIT).toContain("MemorySwapMax=512M");
  expect(USAGE_COLLECTOR_UNIT).toContain("CPUQuota=400%");
  expect(USAGE_COLLECTOR_UNIT).toContain("IOReadBandwidthMax=%h 5M");
  expect(USAGE_COLLECTOR_UNIT).toContain("IOWriteBandwidthMax=%h 5M");
  expect(USAGE_COLLECTOR_UNIT).not.toContain("20M");
  expect(USAGE_COLLECTOR_UNIT).not.toContain("systemctl");
  expect(USAGE_COLLECTOR_UNIT).not.toContain("/home/");
});

test("atomically installs, verifies, and leaves an identical unit untouched on repeat", async () => {
  const root = await temporaryDirectory();
  const unitDirectory = join(root, "systemd", "user");
  const aisPath = join(root, "bin", "ais");
  const probes: string[] = [];
  const reloads: string[] = [];
  const activations: Array<{ serviceName: string; restartIfActive: boolean }> = [];
  const options = {
    unitDirectory,
    aisPath,
    platform: "linux" as NodeJS.Platform,
    checkpointSupport: async () => true,
    checkEntrypoint: async (path: string) => {
      probes.push(path);
      return true;
    },
    reloadAndVerify: async (serviceName: string) => { reloads.push(serviceName); },
    enableStartAndVerify: async (serviceName: string, restartIfActive: boolean) => {
      activations.push({ serviceName, restartIfActive });
    },
  };

  const first = await installUsageCollectorService(options);
  expect(first).toEqual({ path: join(unitDirectory, USAGE_COLLECTOR_SERVICE_NAME), changed: true, ioCap: "5M" });
  expect(await readFile(first.path, "utf8")).toBe(USAGE_COLLECTOR_UNIT);
  expect((await stat(first.path)).mode & 0o777).toBe(0o644);

  const second = await installUsageCollectorService(options);
  expect(second).toEqual({ ...first, changed: false });
  expect(probes).toEqual([aisPath, aisPath]);
  expect(reloads).toEqual([USAGE_COLLECTOR_SERVICE_NAME, USAGE_COLLECTOR_SERVICE_NAME]);
  expect(activations).toEqual([
    { serviceName: USAGE_COLLECTOR_SERVICE_NAME, restartIfActive: true },
    { serviceName: USAGE_COLLECTOR_SERVICE_NAME, restartIfActive: false },
  ]);
});

test("refuses to install when the installed AIS lacks the daemon entrypoint", async () => {
  const root = await temporaryDirectory();
  const unitDirectory = join(root, "systemd", "user");
  await expect(installUsageCollectorService({
    unitDirectory,
    aisPath: join(root, "bin", "ais"),
    platform: "linux",
    checkEntrypoint: async () => false,
  })).rejects.toThrow("does not support the usage snapshot daemon");
  await expect(readFile(join(unitDirectory, USAGE_COLLECTOR_SERVICE_NAME), "utf8")).rejects.toThrow();
});

test("full install skips unsupported hosts and starts the service only when supported", async () => {
  const calls: string[] = [];
  expect(await configureUsageCollectorServiceForFullInstall({
    platform: "darwin",
    checkEntrypoint: async () => { calls.push("probe"); return true; },
    hasManager: async () => { calls.push("manager"); return true; },
    install: async () => { calls.push("install"); return { path: "/unit", changed: true, ioCap: "5M" }; },
  })).toEqual({ status: "not-linux" });
  expect(await configureUsageCollectorServiceForFullInstall({
    platform: "linux",
    checkEntrypoint: async () => false,
    hasManager: async () => { calls.push("unexpected-manager"); return true; },
    install: async () => { calls.push("unexpected-install"); return { path: "/unit", changed: true, ioCap: "5M" }; },
  })).toEqual({ status: "unsupported-entrypoint" });
  expect(await configureUsageCollectorServiceForFullInstall({
    platform: "linux",
    checkEntrypoint: async () => true,
    hasManager: async () => false,
    install: async () => { calls.push("unexpected-install"); return { path: "/unit", changed: true, ioCap: "5M" }; },
  })).toEqual({ status: "no-user-manager" });
  const restartRequests: boolean[] = [];
  expect(await configureUsageCollectorServiceForFullInstall({
    platform: "linux",
    aisBinaryChanged: true,
    checkEntrypoint: async () => true,
    hasManager: async () => true,
    install: async (_aisPath, aisBinaryChanged) => {
      calls.push("install");
      restartRequests.push(aisBinaryChanged);
      return { path: "/unit", changed: false, ioCap: "5M" };
    },
  })).toEqual({ status: "verified", path: "/unit", changed: false, ioCap: "5M" });
  expect(calls).toEqual(["install"]);
  expect(restartRequests).toEqual([true]);
});

test("full-install manifest marker is written after service setup and withheld on failure", async () => {
  const order: string[] = [];
  await finalizeInstall(
    async () => { order.push("service"); },
    async () => { order.push("manifest"); },
  );
  expect(order).toEqual(["service", "manifest"]);

  order.length = 0;
  await expect(finalizeInstall(
    async () => { order.push("service"); throw new Error("start failed"); },
    async () => { order.push("manifest"); },
  )).rejects.toThrow("start failed");
  expect(order).toEqual(["service"]);
});

test("replaces a stale unit atomically with the canonical bounded unit", async () => {
  const root = await temporaryDirectory();
  const unitDirectory = join(root, "systemd", "user");
  const path = join(unitDirectory, USAGE_COLLECTOR_SERVICE_NAME);
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(path, "[Service]\nExecStart=/old/ais\n");

  const result = await installUsageCollectorService({
    unitDirectory,
    platform: "linux",
    checkpointSupport: async () => true,
    checkEntrypoint: async () => true,
    reloadAndVerify: async (serviceName) => {
      expect(serviceName).toBe(USAGE_COLLECTOR_SERVICE_NAME);
    },
    enableStartAndVerify: async (serviceName, restartIfActive) => {
      expect(serviceName).toBe(USAGE_COLLECTOR_SERVICE_NAME);
      expect(restartIfActive).toBe(true);
    },
  });
  expect(result.changed).toBe(true);
  expect(await readFile(path, "utf8")).toBe(USAGE_COLLECTOR_UNIT);
});

test("an installed unit with the old 20M disk cap is rewritten and the service restarted", async () => {
  const root = await temporaryDirectory();
  const unitDirectory = join(root, "systemd", "user");
  const path = join(unitDirectory, USAGE_COLLECTOR_SERVICE_NAME);
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(path, USAGE_COLLECTOR_UNIT.replaceAll("%h 5M", "%h 20M"), { mode: 0o644 });

  const restarts: boolean[] = [];
  const result = await installUsageCollectorService({
    unitDirectory,
    platform: "linux",
    checkpointSupport: async () => true,
    checkEntrypoint: async () => true,
    reloadAndVerify: async () => {},
    enableStartAndVerify: async (_serviceName, restartIfActive) => { restarts.push(restartIfActive); },
  });
  expect(result.changed).toBe(true);
  expect(restarts).toEqual([true]);
  const installed = await readFile(path, "utf8");
  expect(installed).toContain("IOReadBandwidthMax=%h 5M");
  expect(installed).toContain("IOWriteBandwidthMax=%h 5M");
});

test("keeps the 20M cap, and moves to 5M only once the installed Tokscale checkpoints", async () => {
  const root = await temporaryDirectory();
  const unitDirectory = join(root, "systemd", "user");
  const path = join(unitDirectory, USAGE_COLLECTOR_SERVICE_NAME);
  const restarts: boolean[] = [];
  let checkpoints = false;
  const options = {
    unitDirectory,
    platform: "linux" as NodeJS.Platform,
    checkpointSupport: async () => checkpoints,
    checkEntrypoint: async () => true,
    reloadAndVerify: async () => {},
    enableStartAndVerify: async (_serviceName: string, restartIfActive: boolean) => { restarts.push(restartIfActive); },
  };

  expect(await installUsageCollectorService(options)).toMatchObject({ changed: true, ioCap: "20M" });
  expect(await readFile(path, "utf8")).toBe(usageCollectorUnit("20M"));
  expect(await readFile(path, "utf8")).toContain("IOReadBandwidthMax=%h 20M");

  expect(await installUsageCollectorService(options)).toMatchObject({ changed: false, ioCap: "20M" });

  checkpoints = true;
  expect(await installUsageCollectorService(options)).toMatchObject({ changed: true, ioCap: "5M" });
  expect(await readFile(path, "utf8")).toBe(USAGE_COLLECTOR_UNIT);
  expect(restarts).toEqual([true, false, true]);
});

test("a failing checkpoint probe keeps the 20M cap", async () => {
  const root = await temporaryDirectory();
  const unitDirectory = join(root, "systemd", "user");
  const result = await installUsageCollectorService({
    unitDirectory,
    platform: "linux",
    checkpointSupport: async () => { throw new Error("stamp unreadable"); },
    checkEntrypoint: async () => true,
    reloadAndVerify: async () => {},
    enableStartAndVerify: async () => {},
  });
  expect(result.ioCap).toBe("20M");
});
