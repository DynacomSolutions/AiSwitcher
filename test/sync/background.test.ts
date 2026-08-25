import { describe, expect, test } from "bun:test";
import {
  backgroundSyncArgs,
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
      },
    );

    expect(started).toBe(true);
    expect(calls).toEqual([{ binary: "/shims/ais", args: ["sync", "background"] }]);
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
