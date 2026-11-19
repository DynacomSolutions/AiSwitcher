import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import { ensureUsableCwd, spawnReal, withUsableCwd } from "../../src/shared/exec.ts";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  chdir(originalCwd);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Moves the process into a fresh directory, then deletes it out from under
 * the process — the exact state a daemon ends up in when its checkout is
 * moved or pruned while it runs. */
async function enterDeletedDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-deleted-cwd-"));
  tempDirs.push(dir);
  chdir(dir);
  await rm(dir, { recursive: true, force: true });
  return dir;
}

describe("deleted-cwd resilience", () => {
  test("a deleted cwd is detectable: realpath('.') fails with ENOENT", async () => {
    const dir = await enterDeletedDirectory();
    // The detector must fail here (verified live on Linux); whether
    // Bun.spawn itself throws is Bun/platform dependent, so it is
    // deliberately not asserted.
    let detected: "threw" | "resolved" = "resolved";
    try {
      realpathSync(".");
    } catch {
      detected = "threw";
    }
    expect(detected).toBe("threw");
    expect(dir).toBeTruthy();
  });

  test("ensureUsableCwd moves a dangling process to $HOME", async () => {
    await enterDeletedDirectory();
    ensureUsableCwd();
    expect(() => realpathSync(".")).not.toThrow();
    expect(process.cwd()).toBe(realpathSync(homedir()));
  });

  test("withUsableCwd retries the failed attempt exactly once", async () => {
    await enterDeletedDirectory();
    let attempts = 0;
    const result = withUsableCwd(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("spawnSync /bin/true ENOENT");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("withUsableCwd passes a healthy cwd through untouched", () => {
    let attempts = 0;
    const marker = Symbol("marker");
    const result = withUsableCwd(() => {
      attempts += 1;
      return marker;
    });
    expect(attempts).toBe(1);
    expect(result).toBe(marker);
  });
});

describe("child environment", () => {
  async function readSelectedEnvironment(
    outputPath: string,
    extraEnv: Record<string, string> = { EXTRA_ENV: "from-extra-env" },
  ): Promise<Record<string, string | null>> {
    const script = `await Bun.write(${JSON.stringify(outputPath)}, JSON.stringify({
      grokMemory: process.env.GROK_MEMORY ?? null,
      grokOther: process.env.GROK_OTHER ?? null,
      grokSession: process.env.GROK_MEMORY_SESSION ?? null,
      claudeSession: process.env.CLAUDECODE ?? null,
      extra: process.env.EXTRA_ENV ?? null,
    }))`;
    const exitCode = await spawnReal(process.execPath, ["-e", script], extraEnv);
    expect(exitCode).toBe(0);
    return JSON.parse(await Bun.file(outputPath).text());
  }

  for (const value of ["0", "1"]) {
    test(`forwards GROK_MEMORY=${value} while stripping other session markers`, async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "ais-child-env-"));
      tempDirs.push(outputDir);
      const outputPath = join(outputDir, "result.json");
      const previous = new Map([
        ["GROK_MEMORY", process.env.GROK_MEMORY],
        ["GROK_OTHER", process.env.GROK_OTHER],
        ["GROK_MEMORY_SESSION", process.env.GROK_MEMORY_SESSION],
        ["CLAUDECODE", process.env.CLAUDECODE],
        ["EXTRA_ENV", process.env.EXTRA_ENV],
      ]);
      try {
        process.env.GROK_MEMORY = value;
        process.env.GROK_OTHER = "should-be-stripped";
        process.env.GROK_MEMORY_SESSION = "should-be-stripped";
        process.env.CLAUDECODE = "should-be-stripped";
        process.env.EXTRA_ENV = "from-parent-env";
        expect(await readSelectedEnvironment(outputPath)).toEqual({
          grokMemory: value,
          grokOther: null,
          grokSession: null,
          claudeSession: null,
          extra: "from-extra-env",
        });
      } finally {
        for (const [key, original] of previous) {
          if (original === undefined) delete process.env[key];
          else process.env[key] = original;
        }
      }
    });
  }

  test("leaves GROK_MEMORY unset when it is unset in the parent", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ais-child-env-unset-"));
    tempDirs.push(outputDir);
    const outputPath = join(outputDir, "result.json");
    const original = process.env.GROK_MEMORY;
    try {
      delete process.env.GROK_MEMORY;
      expect((await readSelectedEnvironment(outputPath)).grokMemory).toBeNull();
    } finally {
      if (original === undefined) delete process.env.GROK_MEMORY;
      else process.env.GROK_MEMORY = original;
    }
  });

  test("extraEnv GROK_MEMORY overrides inherited value", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "ais-child-env-extra-"));
    tempDirs.push(outputDir);
    const original = process.env.GROK_MEMORY;
    try {
      process.env.GROK_MEMORY = "0";
      expect((await readSelectedEnvironment(join(outputDir, "result.json"), {
        GROK_MEMORY: "1",
      })).grokMemory).toBe("1");
    } finally {
      if (original === undefined) delete process.env.GROK_MEMORY;
      else process.env.GROK_MEMORY = original;
    }
  });
});

describe("spawnCapturedBounded process groups", () => {
  // Running (non-zombie) members of a process group. A zombie waits for its
  // reaper (systemd --user), which can be slow on a loaded host.
  const alive = (pgid: number): boolean => {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue;
      }
      // Fields after the ")" of the command name: state, ppid, pgrp, ...
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) === pgid && state !== "Z" && state !== "X") return true;
    }
    return false;
  };
  // A killed process can stay a zombie for a moment on a loaded host.
  const gone = async (pgid: number): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      if (!alive(pgid)) return true;
      await Bun.sleep(50);
    }
    return false;
  };

  test("a timeout kills grandchildren too", async () => {
    const { spawnCapturedBounded } = await import("../../src/shared/exec.ts");
    const started = Date.now();
    const result = await spawnCapturedBounded("sh", ["-c", "echo $$; sleep 300 & sleep 300 & wait"], {}, 3_000);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    const pgid = Number(result.stdout.trim());
    expect(pgid).toBeGreaterThan(0);
    expect(await gone(pgid)).toBe(true);
  }, 20_000);

  test("returns promptly when a grandchild holds the pipe after the child exits, and kills it", async () => {
    const { spawnCapturedBounded } = await import("../../src/shared/exec.ts");
    const started = Date.now();
    const result = await spawnCapturedBounded("sh", ["-c", "echo $$; sleep 300 &"], {}, 30_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pgid = Number(result.stdout.trim());
    expect(await gone(pgid)).toBe(true);
  }, 20_000);

  test("SIGTERM to the caller kills the live child group too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-exec-reap-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "pgid");
    const execPath = join(import.meta.dir, "../../src/shared/exec.ts");
    const script = `const { spawnCapturedBounded } = await import(${JSON.stringify(execPath)});
await spawnCapturedBounded("sh", ["-c", "echo $$ > ${pidFile}; sleep 300 & sleep 300"], {}, 60_000);`;
    const caller = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "ignore" });
    let pgid = 0;
    for (let i = 0; i < 400 && !pgid; i++) {
      await Bun.sleep(50);
      pgid = Number((await Bun.file(pidFile).text().catch(() => "")).trim()) || 0;
    }
    expect(pgid).toBeGreaterThan(0);
    expect(alive(pgid)).toBe(true);
    caller.kill("SIGTERM");
    await caller.exited;
    expect(await gone(pgid)).toBe(true);
  }, 40_000);

  test("a normal run keeps output and exit code", async () => {
    const { spawnCapturedBounded } = await import("../../src/shared/exec.ts");
    const result = await spawnCapturedBounded("sh", ["-c", "echo out; echo err >&2; exit 3"], {}, 5_000);
    expect(result).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3, timedOut: false });
  });
});
