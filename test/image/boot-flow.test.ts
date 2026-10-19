import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile as readText, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const runFlow = (scenario: string) => spawnSync("/bin/bash", [
  new URL("test/image/fixtures/boot-flow-stubs.sh", root).pathname,
  new URL("image/lib/ais-live-flow", root).pathname,
  scenario,
], { encoding: "utf8" });

describe("live boot flow", () => {
  it("keeps systemd dependency and ordering keys in Unit sections throughout the archiso tree", async () => {
    const base = new URL("image/archiso", root).pathname;
    const files: string[] = [];
    const collect = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else files.push(path);
      }
    };
    await collect(base);
    const dependency = /^(?:Requires|Wants|BindsTo|PartOf|After|Before|Conflicts|Requisite|Upholds|OnFailure)\s*=/;
    for (const file of files.filter(path => /(?:^|\/)(?:[^/]+\.service(?:\.d)?|[^/]+\.socket(?:\.d)?|[^/]+\.target(?:\.d)?|[^/]+\.timer(?:\.d)?|[^/]+\.mount(?:\.d)?|[^/]+\.path(?:\.d)?|[^/]+\.slice(?:\.d)?|[^/]+\.device(?:\.d)?)(?:\/[^/]+\.conf)?$/.test(path))) {
      let section = "";
      for (const line of (await readText(file, "utf8")).split(/\r?\n/)) {
        const header = line.match(/^\[([^\]]+)\]$/);
        if (header) section = header[1]!;
        else if (dependency.test(line.trim())) expect(section, file).toBe("Unit");
      }
    }
  });

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

      const invalidParent = join(tempRoot, "not-a-directory");
      await writeFile(invalidParent, "synthetic blocker");
      const blocked = spawnSync("/bin/bash", [fixture, helper, join(invalidParent, "state"), join(tempRoot, "must-not-install"), "false"], { encoding: "utf8" });
      expect(blocked.status).not.toBe(0);
      await expect(readText(join(tempRoot, "must-not-install"), "utf8")).rejects.toThrow();
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

  it("runs tty1 supervisor once inside Herdr and keeps later default panes as agent", async () => {
    const [profile, herdr, pane] = await Promise.all([
      read("image/archiso/airootfs/etc/profile.d/ais-live-boot.sh"),
      read("image/archiso/airootfs/etc/herdr/config.toml"),
      read("image/lib/ais-agent-pane"),
    ]);
    expect(profile).toContain("/dev/tty1) export AIS_LIVE_TTY1_BOOT=1; exec /usr/bin/ais herdr");
    expect(profile).toContain("/dev/ttyS*) exec /usr/local/lib/ais-live/ais-live-boot");
    expect(herdr).toContain('default_shell = "/usr/local/lib/ais-live/ais-agent-pane"');
    expect(pane).toContain('operation=pane');
    expect(pane).toContain('sudo -n -u agent');
    expect(pane).toContain('ais-live-tty1-claim');
    expect(pane).toContain('exec /usr/local/lib/ais-live/ais-live-boot');
    expect(pane).toContain('exec /usr/bin/sudo -n -u agent');
  });

  it("claims tty1 boot once only from a protected live runtime directory", async () => {
    const claim = new URL("image/lib/ais-live-tty1-claim", root).pathname;
    const base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ais-tty1-claim-"));
    const runtime = join(base, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    try {
      const invoke = (marker?: string) => spawnSync("/bin/bash", [claim, runtime], {
        encoding: "utf8", env: { ...process.env, AIS_LIVE_TTY1_BOOT: marker },
      });
      expect(invoke().status).not.toBe(0);
      expect(invoke("1").status).toBe(0);
      expect(invoke("1").status).not.toBe(0);
      const wrongMode = join(base, "wrong-mode");
      await mkdir(wrongMode, { mode: 0o755 });
      expect(spawnSync("/bin/bash", [claim, wrongMode], {
        encoding: "utf8", env: { ...process.env, AIS_LIVE_TTY1_BOOT: "1" },
      }).status).not.toBe(0);
      const linked = join(base, "linked");
      await symlink(runtime, linked);
      expect(spawnSync("/bin/bash", [claim, linked], {
        encoding: "utf8", env: { ...process.env, AIS_LIVE_TTY1_BOOT: "1" },
      }).status).not.toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("serialises real concurrent upgrade-once callers and retries after failure", async () => {
    const tempRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ais-upgrade-concurrent-"));
    try {
      const helper = new URL("image/lib/ais-upgrade-once.sh", root).pathname;
      const fixture = new URL("test/image/fixtures/upgrade-once-stubs.sh", root).pathname;
      const state = join(tempRoot, "live", "vendor-cli-installed");
      const counter = join(tempRoot, "install-count");
      const invoke = () => new Promise<number>((resolve, reject) => {
        const child = spawn("/bin/bash", [fixture, helper, state, counter, "concurrent"], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
      expect(await Promise.all([invoke(), invoke(), invoke(), invoke()])).toEqual([0, 0, 0, 0]);
      expect((await readText(counter, "utf8")).trim()).toBe("1");
      expect(await readText(state, "utf8")).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
