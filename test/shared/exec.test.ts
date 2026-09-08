import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
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
