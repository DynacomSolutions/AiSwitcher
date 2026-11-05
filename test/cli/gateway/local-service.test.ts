import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLocalStatus, installLocalGatewayService, LOCAL_GATEWAY_LEGACY_NAME, LOCAL_GATEWAY_TEMPLATE_NAME, LOCAL_GATEWAY_UNIT, localSlotUnit, type Ctl, type LocalSlot } from "../../../src/cli/gateway/local-service.ts";
import { startLocalGateway } from "../../../src/gateway/local.ts";

/** A tiny fake of systemctl --user: state in memory, every call recorded in order. */
function fakeSystemd(initial: { active?: string[]; enabled?: string[] } = {}) {
  const active = new Set(initial.active ?? []);
  const enabled = new Set(initial.enabled ?? []);
  const calls: string[] = [];
  const ctl: Ctl = async (args) => {
    calls.push(args.join(" "));
    const [verb, ...rest] = args;
    const unit = rest.filter((a) => !a.startsWith("--")).at(-1) ?? "";
    switch (verb) {
      case "is-active":
        return { code: active.has(unit) ? 0 : 3, out: active.has(unit) ? "active" : "inactive" };
      case "is-enabled":
        return { code: enabled.has(unit) ? 0 : 1, out: enabled.has(unit) ? "enabled" : "disabled" };
      case "start":
        active.add(unit);
        break;
      case "stop":
        active.delete(unit);
        break;
      case "enable":
        enabled.add(unit);
        break;
      case "disable":
        enabled.delete(unit);
        break;
    }
    return { code: 0, out: "" };
  };
  return { ctl, calls, active, enabled };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ais-gw-local-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

describe("ais-gateway-local@.service", () => {
  test("unit: restarts always, waits for the port, drains with a long kill ceiling, starts before Herdr", () => {
    expect(LOCAL_GATEWAY_UNIT).toContain("Restart=always");
    expect(LOCAL_GATEWAY_UNIT).toContain("ExecStart=%h/.local/bin/ais gateway local");
    expect(LOCAL_GATEWAY_UNIT).toContain("ExecStartPost=");
    expect(LOCAL_GATEWAY_UNIT).toContain("TimeoutStopSec=15min");
    expect(LOCAL_GATEWAY_UNIT).toContain("AIS_GATEWAY_LOCAL_INSTANCE=%i");
    expect(LOCAL_GATEWAY_UNIT).toMatch(/Before=.*herdr-host\.service/);
  });

  test("first install writes the template, enables and starts slot a", async () => {
    await withDir(async (dir) => {
      const sd = fakeSystemd();
      const waited: LocalSlot[] = [];
      const r = await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async (s) => void waited.push(s) });
      expect(r).toMatchObject({ slot: "a", action: "started", changed: true });
      expect(await readFile(join(dir, LOCAL_GATEWAY_TEMPLATE_NAME), "utf8")).toBe(LOCAL_GATEWAY_UNIT);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(true);
      expect(waited).toEqual(["a"]);
    });
  });

  test("an unchanged install with the proxy running does nothing", async () => {
    await withDir(async (dir) => {
      const first = fakeSystemd();
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: first.ctl, waitListening: async () => {} });
      const sd = fakeSystemd({ active: [localSlotUnit("a")], enabled: [localSlotUnit("a")] });
      const r = await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => {} });
      expect(r.action).toBe("unchanged");
      expect(sd.calls.some((c) => c.startsWith("start") || c.startsWith("stop"))).toBe(false);
    });
  });

  test("a release hands over: the new slot listens before the old one is told to drain", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const sd = fakeSystemd({ active: [localSlotUnit("a")], enabled: [localSlotUnit("a")] });
      const order: string[] = [];
      const r = await installLocalGatewayService({
        unitDirectory: dir,
        platform: "linux",
        ctl: async (args) => (order.push(args.join(" ")), sd.ctl(args)),
        waitListening: async (s) => void order.push(`listening:${s}`),
        restartIfActive: true,
        respectDisabled: true,
      });
      expect(r).toMatchObject({ slot: "b", action: "handed-over" });
      const iStartB = order.indexOf(`start ${localSlotUnit("b")}`);
      const iListen = order.indexOf("listening:b");
      const iStopA = order.indexOf(`stop --no-block ${localSlotUnit("a")}`);
      expect(iStartB).toBeGreaterThanOrEqual(0);
      expect(iListen).toBeGreaterThan(iStartB);
      expect(iStopA).toBeGreaterThan(iListen);
      expect(sd.enabled.has(localSlotUnit("b"))).toBe(true);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(false);
    });
  });

  test("release mode leaves a stopped or disabled proxy alone", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const sd = fakeSystemd(); // user disabled and stopped it
      const r = await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => {}, respectDisabled: true, restartIfActive: true });
      expect(r.action).toBe("left-alone");
      expect(sd.calls.some((c) => c.startsWith("start") || c.startsWith("enable"))).toBe(false);
    });
  });

  test("migration from the single unit removes it and its drop-ins only after the new slot listens", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, LOCAL_GATEWAY_LEGACY_NAME), "[Service]\nExecStart=old\n");
      await mkdir(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`));
      await writeFile(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`, "override.conf"), "[Service]\nExecStart=x\n");
      const sd = fakeSystemd({ active: [LOCAL_GATEWAY_LEGACY_NAME], enabled: [LOCAL_GATEWAY_LEGACY_NAME] });
      let legacyPresentWhenListening: boolean | undefined;
      let dropinPresentWhenListening: boolean | undefined;
      const r = await installLocalGatewayService({
        unitDirectory: dir,
        platform: "linux",
        ctl: sd.ctl,
        waitListening: async () => {
          legacyPresentWhenListening = await exists(join(dir, LOCAL_GATEWAY_LEGACY_NAME));
          dropinPresentWhenListening = await exists(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`));
        },
      });
      expect(r).toMatchObject({ slot: "a", action: "migrated" });
      expect(legacyPresentWhenListening).toBe(true);
      expect(dropinPresentWhenListening).toBe(true);
      expect(await exists(join(dir, LOCAL_GATEWAY_LEGACY_NAME))).toBe(false);
      expect(await exists(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`))).toBe(false);
      expect(sd.calls).toContain(`stop --no-block ${LOCAL_GATEWAY_LEGACY_NAME}`);
      expect(sd.calls).toContain(`disable ${LOCAL_GATEWAY_LEGACY_NAME}`);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(true);
    });
  });

  test("doctor status reads the proxy mode and instance, undefined when down", async () => {
    const running = await startLocalGateway({ port: 0, members: async () => [], remoteBase: "http://remote.test", log: () => {}, clientToken: async () => undefined, instance: "b" });
    try {
      const st = await fetchLocalStatus(running.port);
      expect(st?.mode).toBe("remote");
      expect(st?.instance).toBe("b");
    } finally {
      running.stop();
    }
    expect(await fetchLocalStatus(running.port)).toBeUndefined();
  });
});
