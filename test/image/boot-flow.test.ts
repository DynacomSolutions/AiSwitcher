import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile as readText, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const runFlow = (scenario: string) => spawnSync("/bin/bash", [
  new URL("test/image/fixtures/boot-flow-stubs.sh", root).pathname,
  new URL("image/lib/ais-live-flow", root).pathname,
  scenario,
], { encoding: "utf8" });

describe("live boot flow", () => {
  it("runs online install and launch in order and retries a failed install", async () => {
    const success = runFlow("online-first");
    expect(success.status).toBe(0);
    expect(success.stdout.trim().split("\n")).toEqual([
      "probe:initial", "stage:net:ok", "stage:net-prompt:skip", "stage:local-model-offer:skip",
      "upgrade", "stage:vendor-cli-install:ok", "stage:launch:ok", "launch",
    ]);
    const failed = runFlow("online-upgrade-fails");
    expect(failed.status).toBe(0);
    expect(failed.stdout.trim().split("\n")).toEqual([
      "probe:initial", "stage:net:ok", "stage:net-prompt:skip", "stage:local-model-offer:skip",
      "upgrade", "stage:vendor-cli-install:fail", "stage:launch:ok", "launch",
    ]);

    const tempRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ais-upgrade-once-"));
    try {
      const helper = new URL("image/lib/ais-upgrade-once.sh", root).pathname;
      const fixture = new URL("test/image/fixtures/upgrade-once-stubs.sh", root).pathname;
      const state = join(tempRoot, "live", "vendor-cli-installed");
      const counter = join(tempRoot, "success-count");
      const successful = spawnSync("/bin/bash", [fixture, helper, state, counter, "false"], { encoding: "utf8" });
      expect(successful.status).toBe(0);
      expect(successful.stdout.trim()).toBe("1");

      const retryState = join(tempRoot, "retry", "vendor-cli-installed");
      const retryCounter = join(tempRoot, "retry-count");
      const retried = spawnSync("/bin/bash", [fixture, helper, retryState, retryCounter, "true"], { encoding: "utf8" });
      expect(retried.status).toBe(0);
      expect(retried.stdout.trim()).toBe("2");
      expect(await readText(retryState, "utf8")).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("prompts offline, rechecks, and starts a selected local model", () => {
    const yes = runFlow("offline-yes");
    expect(yes.status).toBe(0);
    expect(yes.stdout.trim().split("\n")).toEqual([
      "probe:initial", "stage:net:ok", "prompt", "probe:fresh", "stage:net-prompt:ok",
      "offer:y", "local-start", "stage:local-model-offer:ok", "stage:vendor-cli-install:skip",
      "stage:launch:ok", "launch",
    ]);

    for (const scenario of ["offline-no", "offline-timeout", "offline-no-model"]) {
      const result = runFlow(scenario);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("stage:net-prompt:ok");
      expect(result.stdout.trim().split("\n").at(-1)).toBe("launch");
    }
    expect(runFlow("offline-no").stdout).not.toContain("local-start");
    expect(runFlow("offline-no-model").stdout).not.toContain("\noffer:");

    const cancelled = runFlow("offline-cancel-online");
    expect(cancelled.status).toBe(0);
    expect(cancelled.stdout.trim().split("\n")).toEqual([
      "probe:initial", "stage:net:ok", "prompt", "probe:fresh", "stage:net-prompt:ok",
      "stage:local-model-offer:skip", "upgrade", "stage:vendor-cli-install:ok", "stage:launch:ok", "launch",
    ]);
  });

  it("starts herdr only on tty1 and makes its configured shell the pane supervisor", async () => {
    const [profile, herdr] = await Promise.all([
      read("image/archiso/airootfs/etc/profile.d/ais-live-boot.sh"),
      read("image/archiso/airootfs/etc/herdr/config.toml"),
    ]);
    expect(profile).toContain("/dev/tty1) exec /usr/bin/ais herdr");
    expect(profile).toContain("/dev/ttyS*) exec /usr/local/lib/ais-live/ais-live-boot");
    expect(herdr).toContain('default_shell = "/usr/local/lib/ais-live/ais-agent-pane"');
  });
});
