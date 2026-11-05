import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLocalStatus, installLocalGatewayService, LOCAL_GATEWAY_LEGACY_NAME, LOCAL_GATEWAY_TEMPLATE_NAME, LOCAL_GATEWAY_UNIT, localSlotUnit, type Ctl, type LocalSlot } from "../../../src/cli/gateway/local-service.ts";
import { startLocalGateway } from "../../../src/gateway/local.ts";

/** A tiny fake of systemctl --user: state in memory, every call recorded in order. */
function fakeSystemd(initial: { active?: string[]; enabled?: string[]; deactivating?: string[]; fail?: (args: string[]) => boolean } = {}) {
  const active = new Set(initial.active ?? []);
  const deactivating = new Set(initial.deactivating ?? []);
  const enabled = new Set(initial.enabled ?? []);
  const calls: string[] = [];
  const ctl: Ctl = async (args) => {
    calls.push(args.join(" "));
    const [verb, ...rest] = args;
    const unit = rest.filter((a) => !a.startsWith("--")).at(-1) ?? "";
    if (initial.fail?.(args)) return { code: 1, out: "" };
    switch (verb) {
      case "is-active":
        return { code: active.has(unit) ? 0 : 3, out: active.has(unit) ? "active" : deactivating.has(unit) ? "deactivating" : "inactive" };
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
  return { ctl, calls, active, enabled, deactivating };
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
        preflight: async () => true,
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
      // The legacy unit is stopped only after the slot answered.
      expect(sd.calls.indexOf(`stop --no-block ${LOCAL_GATEWAY_LEGACY_NAME}`)).toBeGreaterThan(sd.calls.indexOf(`start ${localSlotUnit("a")}`));
      expect(sd.calls).toContain(`disable ${LOCAL_GATEWAY_LEGACY_NAME}`);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(true);
    });
  });

  async function legacyRig(dir: string, over: { fail?: (a: string[]) => boolean; legacyOn?: boolean } = {}) {
    await writeFile(join(dir, LOCAL_GATEWAY_LEGACY_NAME), "[Service]\nExecStart=old\n");
    const on = over.legacyOn ?? true;
    return fakeSystemd({ active: on ? [LOCAL_GATEWAY_LEGACY_NAME] : [], enabled: on ? [LOCAL_GATEWAY_LEGACY_NAME] : [], ...(over.fail ? { fail: over.fail } : {}) });
  }

  test("migration: a failing start leaves the legacy unit running and never stopped", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir, { fail: (a) => a[0] === "start" && a[1] === localSlotUnit("a") });
      await expect(installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, preflight: async () => true, waitListening: async () => {} })).rejects.toThrow();
      expect(sd.active.has(LOCAL_GATEWAY_LEGACY_NAME)).toBe(true);
      expect(sd.calls.some((c) => c.startsWith("stop") && c.includes(LOCAL_GATEWAY_LEGACY_NAME))).toBe(false);
      expect(sd.calls).toContain(`stop ${localSlotUnit("a")}`);
      expect(sd.calls).toContain(`disable ${localSlotUnit("a")}`);
      expect(await exists(join(dir, LOCAL_GATEWAY_LEGACY_NAME))).toBe(true);
    });
  });

  test("migration: a slot that never answers gets the legacy unit started again and the slot stopped and disabled", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir);
      let waits = 0;
      await expect(
        installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, preflight: async () => true, waitListening: async () => { waits++; throw new Error("timeout"); } }),
      ).rejects.toThrow("timeout");
      expect(waits).toBe(2); // once beside the legacy unit, once after it released the port
      expect(sd.active.has(LOCAL_GATEWAY_LEGACY_NAME)).toBe(true); // restarted
      expect(sd.calls.filter((c) => c === `start ${LOCAL_GATEWAY_LEGACY_NAME}`)).toHaveLength(1);
      expect(sd.active.has(localSlotUnit("a"))).toBe(false);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(false);
      expect(await exists(join(dir, LOCAL_GATEWAY_LEGACY_NAME))).toBe(true);
    });
  });

  test("migration: a failed preflight never touches the legacy unit", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir);
      await expect(installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, preflight: async () => false, waitListening: async () => {} })).rejects.toThrow(/preflight/);
      expect(sd.calls.some((c) => /^(start|stop|enable|disable)/.test(c))).toBe(false);
      expect(sd.active.has(LOCAL_GATEWAY_LEGACY_NAME)).toBe(true);
      expect(await exists(join(dir, LOCAL_GATEWAY_LEGACY_NAME))).toBe(true);
    });
  });

  test("migration carries Environment= from the legacy drop-ins into a template drop-in and drops ExecStart", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir);
      await mkdir(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`));
      await writeFile(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`, "override.conf"), "[Service]\nEnvironment=AIS_GATEWAY_LOCAL_PORT=47999\nExecStart=\nExecStart=/somewhere/bun run x\n");
      const logs: string[] = [];
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, preflight: async () => true, waitListening: async () => {}, log: (l) => logs.push(l) });
      const carried = await readFile(join(dir, `${LOCAL_GATEWAY_TEMPLATE_NAME}.d`, "legacy-migrated.conf"), "utf8");
      expect(carried).toContain("Environment=AIS_GATEWAY_LOCAL_PORT=47999");
      expect(carried).not.toContain("ExecStart");
      expect(logs.filter((l) => l.includes("ExecStart override"))).toHaveLength(1);
    });
  });

  test("migration respects a disabled or stopped legacy unit: retired without starting a slot", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir, { legacyOn: false });
      const r = await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, preflight: async () => true, waitListening: async () => {}, respectDisabled: true });
      expect(r.action).toBe("retired-legacy");
      expect(sd.calls.some((c) => c.startsWith("start"))).toBe(false);
      expect(await exists(join(dir, LOCAL_GATEWAY_LEGACY_NAME))).toBe(false);
    });
  });

  test("a slot that is still draining is never the handoff target", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const sd = fakeSystemd({ active: [localSlotUnit("a")], enabled: [localSlotUnit("a")], deactivating: [localSlotUnit("b")] });
      const logs: string[] = [];
      const r = await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => {}, restartIfActive: true, log: (l) => logs.push(l) });
      expect(r.action).toBe("handoff-deferred");
      expect(sd.calls.some((c) => c.startsWith("start") || c.startsWith("stop"))).toBe(false);
      expect(sd.active.has(localSlotUnit("a"))).toBe(true);
      expect(logs.some((l) => l.includes("still draining"))).toBe(true);
    });
  });

  test("a failed enable of the new slot rolls back: new slot stopped, old one kept running and enabled", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const sd = fakeSystemd({ active: [localSlotUnit("a")], enabled: [localSlotUnit("a")], fail: (a) => a[0] === "enable" && a[1] === localSlotUnit("b") });
      await expect(installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => {}, restartIfActive: true })).rejects.toThrow();
      expect(sd.active.has(localSlotUnit("b"))).toBe(false);
      expect(sd.active.has(localSlotUnit("a"))).toBe(true);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(true);
    });
  });

  test("a handoff whose new slot never answers stops and disables it and keeps the old one", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const sd = fakeSystemd({ active: [localSlotUnit("a")], enabled: [localSlotUnit("a")] });
      await expect(installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => { throw new Error("timeout"); }, restartIfActive: true })).rejects.toThrow("timeout");
      expect(sd.active.has(localSlotUnit("b"))).toBe(false);
      expect(sd.enabled.has(localSlotUnit("b"))).toBe(false);
      expect(sd.active.has(localSlotUnit("a"))).toBe(true);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(true);
    });
  });

  test("every install converges to exactly one enabled slot, the active one", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const sd = fakeSystemd({ active: [localSlotUnit("b")], enabled: [localSlotUnit("a"), localSlotUnit("b")] });
      const r = await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => {} });
      expect(r.action).toBe("unchanged");
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(false);
      expect(sd.enabled.has(localSlotUnit("b"))).toBe(true);
    });
  });

  test("the carried drop-in is loaded (daemon-reload) before the slot starts, and the wait polls the unit's own port", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir);
      await mkdir(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`));
      await writeFile(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`, "port.conf"), "[Service]\nEnvironment=AIS_GATEWAY_LOCAL_PORT=47999\n");
      const order: string[] = [];
      const ports: Array<number | undefined> = [];
      const carriedFile = join(dir, `${LOCAL_GATEWAY_TEMPLATE_NAME}.d`, "legacy-migrated.conf");
      let carriedSeenByLastReload = false;
      await installLocalGatewayService({
        unitDirectory: dir,
        platform: "linux",
        ctl: async (args) => {
          order.push(args.join(" "));
          if (args[0] === "daemon-reload") carriedSeenByLastReload = await exists(carriedFile);
          if (args[0] === "start" && args[1] === localSlotUnit("a")) expect(carriedSeenByLastReload).toBe(true); // reloaded after the file was written
          return sd.ctl(args);
        },
        preflight: async () => true,
        waitListening: async (_s, port) => void ports.push(port),
      });
      expect(order.indexOf("daemon-reload")).toBeLessThan(order.indexOf(`start ${localSlotUnit("a")}`));
      expect(ports).toEqual([47999]);
    });
  });

  test("carrying: EnvironmentFile and UnsetEnvironment kept, continuations joined, a bare Environment= reset kept in order, others named in the log", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir);
      await mkdir(join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`));
      await writeFile(
        join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`, "a.conf"),
        "[Service]\nEnvironment=ONE=1\nEnvironment=\nEnvironment=TWO=2 \\\n  THREE=3\nEnvironmentFile=-/etc/x.env\nUnsetEnvironment=GONE\nEnvironment=TWO=2 THREE=3\nMemoryMax=1G\nRestart=on-failure\nExecStart=/bin/x\n",
      );
      const logs: string[] = [];
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, preflight: async () => true, waitListening: async () => {}, log: (l) => logs.push(l) });
      const carried = (await readFile(join(dir, `${LOCAL_GATEWAY_TEMPLATE_NAME}.d`, "legacy-migrated.conf"), "utf8")).trim().split("\n");
      expect(carried).toEqual(["[Service]", "Environment=ONE=1", "Environment=", "Environment=TWO=2 THREE=3", "EnvironmentFile=-/etc/x.env", "UnsetEnvironment=GONE", "Environment=TWO=2 THREE=3"]);
      expect(logs.filter((l) => l.includes("MemoryMax="))).toHaveLength(1);
      expect(logs.filter((l) => l.includes("Restart="))).toHaveLength(1);
      expect(logs.filter((l) => l.includes("ExecStart override"))).toHaveLength(1);
    });
  });

  test("respectDisabled never re-enables a running slot the user disabled", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const sd = fakeSystemd({ active: [localSlotUnit("a")] }); // running, but disabled by the user
      const r = await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => {}, respectDisabled: true });
      expect(r.action).toBe("unchanged");
      expect(sd.calls.some((c) => c.startsWith("enable"))).toBe(false);
      expect(sd.enabled.size).toBe(0);
    });
  });

  test("both slots active: the one that answers is kept, the other drains and is disabled; none answering changes nothing", async () => {
    await withDir(async (dir) => {
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: fakeSystemd().ctl, waitListening: async () => {} });
      const both = [localSlotUnit("a"), localSlotUnit("b")];
      const sd = fakeSystemd({ active: both, enabled: both });
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, waitListening: async () => {}, answeringInstance: async () => "b" });
      expect(sd.calls).toContain(`stop --no-block ${localSlotUnit("a")}`);
      expect(sd.enabled.has(localSlotUnit("a"))).toBe(false);
      expect(sd.enabled.has(localSlotUnit("b"))).toBe(true);
      expect(sd.active.has(localSlotUnit("b"))).toBe(true);
      const none = fakeSystemd({ active: both, enabled: both });
      const logs: string[] = [];
      await installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: none.ctl, waitListening: async () => {}, answeringInstance: async () => undefined, log: (l) => logs.push(l) });
      expect(none.calls.some((c) => c.startsWith("stop") || c.startsWith("disable") || c.startsWith("enable"))).toBe(false);
      expect(logs.some((l) => l.includes("neither answers"))).toBe(true);
    });
  });

  test("a slot that was already running before the install is never stopped by a failed migration", async () => {
    await withDir(async (dir) => {
      const sd = await legacyRig(dir, { legacyOn: false });
      sd.active.add(localSlotUnit("a")); // slot a already running
      await expect(installLocalGatewayService({ unitDirectory: dir, platform: "linux", ctl: sd.ctl, preflight: async () => true, waitListening: async () => { throw new Error("timeout"); } })).rejects.toThrow("timeout");
      expect(sd.active.has(localSlotUnit("a"))).toBe(true);
      expect(sd.calls.some((c) => c === `stop ${localSlotUnit("a")}`)).toBe(false);
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
