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

  test("doctor status reads the proxy mode, undefined when down", async () => {
    const running = await startLocalGateway({ port: 0, members: async () => [], remoteBase: "http://127.0.0.1:9", log: () => {} });
    try {
      expect((await fetchLocalStatus(running.port))?.mode).toBe("remote");
    } finally {
      running.stop();
    }
    expect(await fetchLocalStatus(running.port)).toBeUndefined();
  });
});
