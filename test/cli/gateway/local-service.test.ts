import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLocalStatus, installLocalGatewayService, LOCAL_GATEWAY_SERVICE_NAME, LOCAL_GATEWAY_UNIT } from "../../../src/cli/gateway/local-service.ts";
import { startLocalGateway } from "../../../src/gateway/local.ts";

describe("ais gateway local service", () => {
  test("unit restarts always, starts before Herdr and installs idempotently", async () => {
    expect(LOCAL_GATEWAY_UNIT).toContain("Restart=always");
    expect(LOCAL_GATEWAY_UNIT).toContain("ExecStart=%h/.local/bin/ais gateway local");
    expect(LOCAL_GATEWAY_UNIT).toContain("ExecStartPost=");
    expect(LOCAL_GATEWAY_UNIT).toMatch(/Before=.*herdr-host\.service/);
    const dir = await mkdtemp(join(tmpdir(), "ais-gw-local-"));
    try {
      const enabled: boolean[] = [];
      const opts = { unitDirectory: dir, platform: "linux" as const, reloadAndVerify: async () => {}, enableStartAndVerify: async (_n: string, restart: boolean) => void enabled.push(restart) };
      const first = await installLocalGatewayService(opts);
      expect(first.changed).toBe(true);
      expect(await readFile(join(dir, LOCAL_GATEWAY_SERVICE_NAME), "utf8")).toBe(LOCAL_GATEWAY_UNIT);
      expect((await installLocalGatewayService(opts)).changed).toBe(false);
      expect(enabled).toEqual([true, false]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("release mode never re-enables a disabled unit and restarts only an active one", async () => {
    expect(LOCAL_GATEWAY_UNIT).toContain("TimeoutStopSec=15min");
    const dir = await mkdtemp(join(tmpdir(), "ais-gw-local-"));
    try {
      const calls: string[] = [];
      const base = { unitDirectory: dir, platform: "linux" as const, reloadAndVerify: async () => {}, enableStartAndVerify: async () => void calls.push("enable"), restart: async () => void calls.push("restart") };
      await installLocalGatewayService({ ...base, respectDisabled: true, isActive: async () => false });
      expect(calls).toEqual(["enable"]); // first install enables and starts
      calls.length = 0;
      await installLocalGatewayService({ ...base, respectDisabled: true, restartIfActive: true, isActive: async () => false });
      expect(calls).toEqual([]); // disabled or stopped by the user: left alone
      await installLocalGatewayService({ ...base, respectDisabled: true, restartIfActive: true, isActive: async () => true });
      expect(calls).toEqual(["restart"]); // active: picks up the new binary
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("doctor status reads the proxy mode, undefined when down", async () => {
    const running = await startLocalGateway({ port: 0, members: async () => [], remoteBase: "http://remote.test", log: () => {}, clientToken: async () => undefined });
    try {
      expect((await fetchLocalStatus(running.port))?.mode).toBe("remote");
    } finally {
      running.stop();
    }
    expect(await fetchLocalStatus(running.port)).toBeUndefined();
  });
});
