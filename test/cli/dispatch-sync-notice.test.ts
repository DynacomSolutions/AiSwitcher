import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as backgroundSync from "../../src/sync/background.ts";
import * as migration from "../../src/shared/migrate-ais-home.ts";
import * as usage from "../../src/cli/usage/dispatch.ts";
import * as limits from "../../src/cli/limits/dispatch.ts";
import * as identities from "../../src/cli/identities/dispatch.ts";
import * as doctor from "../../src/cli/doctor/dispatch.ts";
import * as syncService from "../../src/sync/service.ts";
import * as cli from "../../src/cli/dispatch.ts";

afterEach(() => {
  // Restore every spy even if an assertion fails, keeping global state clean.
  for (const restore of restorers.splice(0)) restore();
});

const restorers: Array<() => void> = [];

function stub<T extends object, K extends keyof T>(object: T, key: K, implementation: T[K]): void {
  const spy = spyOn(object, key).mockImplementation(implementation as never);
  restorers.push(() => spy.mockRestore());
}

describe("CLI automatic sync reporting", () => {
  test.each([
    ["limits", async () => stub(limits, "runLimitsCommand", async () => {})],
    ["usage", async () => stub(usage, "runUsageCommand", async () => {})],
    ["identities", async () => stub(identities, "runIdentitiesCommand", async () => {})],
    ["doctor", async () => stub(doctor, "runDoctorCommand", async () => {})],
  ] as const)("starts detached sync quietly for %s", async (command, stubHandler) => {
    let startedWith: unknown;
    const stderr: string[] = [];
    stub(migration, "migrateLegacyAisHome", async () => {});
    await stubHandler();
    stub(backgroundSync, "startBackgroundProfileSync", ((options: unknown) => {
      startedWith = options;
      return true;
    }) as typeof backgroundSync.startBackgroundProfileSync);
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
    restorers.push(() => error.mockRestore());

    await cli.runCli([command]);

    expect(startedWith).toEqual({ direction: "both", scope: { kind: "all" } });
    expect(stderr).toEqual([]);
  });

  test("explicit sync still reports its result", async () => {
    const stdout: string[] = [];
    stub(migration, "migrateLegacyAisHome", async () => {});
    stub(syncService, "syncConfiguredProfiles", async () => ({
      remotes: ["fixture"],
      pulled: ["fixture"],
      pushed: [],
      skipped: false,
      preservedConflicts: 0,
      preservedConflictPaths: [],
      busyPaths: [],
    }));
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void stdout.push(args.join(" ")));
    restorers.push(() => log.mockRestore());
    const startSync = spyOn(backgroundSync, "startBackgroundProfileSync");
    restorers.push(() => startSync.mockRestore());

    await cli.runCli(["sync", "now"]);

    expect(stdout).toEqual(["✔ AIS profiles synced: pulled from fixture."]);
    expect(startSync).not.toHaveBeenCalled();
  });
});
