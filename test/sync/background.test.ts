import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundSyncArgs,
  configuredRemoteCount,
  lowPriorityPrefix,
  launchThenStartBackgroundSync,
  startBackgroundProfileSync,
} from "../../src/sync/background.ts";
import { CODEX_CONFIG } from "../../src/identities/tool-configs.ts";

describe("background profile sync", () => {
  test("encodes an explicitly scoped push-only worker when requested", () => {
    expect(
      backgroundSyncArgs({
        direction: "push",
        scope: { kind: "identity", cfg: CODEX_CONFIG, identityName: "identity-a", cwd: "/tmp/project" },
        waitForLock: true,
        includeDatabases: false,
      }),
    ).toEqual([
      "sync",
      "background",
      "--push-only",
      "--wait",
      "--no-databases",
      "--tool=codex",
      "--identity=identity-a",
      "--cwd=/tmp/project",
    ]);
  });

  test("spawns and unreferences the installed AIS worker", () => {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const started = startBackgroundProfileSync(
      { direction: "both" },
      {
        resolveBinary: () => "/shims/ais",
        spawnDetached: (binary, args) => calls.push({ binary, args }),
        remoteCount: () => 1,
      },
    );

    expect(started).toBe(true);
    expect(calls).toEqual([{ binary: "/shims/ais", args: ["sync", "background"] }]);
  });

  test("does not spawn a worker when no remotes are configured", () => {
    const calls: string[][] = [];
    const started = startBackgroundProfileSync(
      {},
      { resolveBinary: () => "/shims/ais", spawnDetached: (_b, args) => calls.push(args), remoteCount: () => 0 },
    );
    expect(started).toBe(false);
    expect(calls).toEqual([]);
  });

  test("counts remotes from the config file: missing is none, invalid still spawns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-bg-"));
    try {
      expect(configuredRemoteCount(join(dir, "none.json"))).toBe(0);
      await Bun.write(join(dir, "empty.json"), JSON.stringify({ version: 2, remotes: [] }));
      expect(configuredRemoteCount(join(dir, "empty.json"))).toBe(0);
      await Bun.write(join(dir, "one.json"), JSON.stringify({ version: 2, remotes: ["my-host"] }));
      expect(configuredRemoteCount(join(dir, "one.json"))).toBe(1);
      await Bun.write(join(dir, "bad.json"), "{");
      expect(configuredRemoteCount(join(dir, "bad.json"))).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("launches the agent before starting sync and returns immediately", () => {
    const order: string[] = [];
    const childExit = new Promise<number>(() => {});
    const result = launchThenStartBackgroundSync(
      () => {
        order.push("agent");
        return childExit;
      },
      () => order.push("sync"),
    );

    expect(order).toEqual(["agent", "sync"]);
    expect(result).toBe(childExit);
  });
});

describe("lowPriorityPrefix", () => {
  const which = (name: string) => `/bin/${name}`;
  test("nice plus an ionice-probing sh wrapper on Linux", () => {
    const prefix = lowPriorityPrefix(which, "linux");
    expect(prefix.slice(0, 5)).toEqual(["/bin/nice", "-n", "19", "/bin/sh", "-c"]);
    expect(prefix.at(-1)).toBe("sh");
  });
  test("only nice off Linux or without ionice", () => {
    expect(lowPriorityPrefix(which, "darwin")).toEqual(["/bin/nice", "-n", "19"]);
    expect(lowPriorityPrefix((n) => (n === "ionice" ? null : `/bin/${n}`), "linux")).toEqual(["/bin/nice", "-n", "19"]);
  });
  test("the real prefix still runs the command", async () => {
    const proc = Bun.spawn([...lowPriorityPrefix(), "echo", "ok"], { stdout: "pipe" });
    expect((await new Response(proc.stdout).text()).trim()).toBe("ok");
  });
});
