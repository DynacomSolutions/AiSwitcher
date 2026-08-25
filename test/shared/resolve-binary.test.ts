import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// resolveRealBinary()'s MANAGED_REAL_BIN_DIR/LEGACY_MANAGED_REAL_BIN_DIR are
// module-level consts computed once at import time from HOME/env vars —
// changing those env vars after this test file's own first (real-HOME)
// import wouldn't affect an already-loaded module. Each case below spawns a
// fresh `bun` subprocess instead, so every scenario gets its own clean
// module evaluation against a controlled HOME/PATH.
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "ais-resolve-home-"));
  tempDirs.push(home);
  return home;
}

async function writeExecutable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, "#!/bin/sh\necho fake\n");
  await chmod(path, 0o755);
}

async function resolveInSubprocess(home: string, name: string): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = join(home, "resolve.ts");
  await Bun.write(
    scriptPath,
    `import { resolveRealBinary } from ${JSON.stringify(
      join(import.meta.dirname, "..", "..", "src", "shared", "resolve-binary.ts"),
    )};\ntry {\n  console.log(resolveRealBinary(${JSON.stringify(name)}));\n} catch (err) {\n  console.error(String(err));\n  process.exitCode = 1;\n}\n`,
  );
  // An empty PATH dir keeps these cases hermetic — a machine with a system
  // /usr/bin/claude (e.g. an Arch package) must not satisfy the lookup.
  const emptyPathDir = join(home, "empty-path");
  await mkdir(emptyPathDir, { recursive: true });
  const proc = Bun.spawn([process.execPath, "run", scriptPath], {
    env: { HOME: home, PATH: emptyPathDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

describe("resolveRealBinary — legacy npm-prefix fallback", () => {
  test("finds the managed binary at the CURRENT ~/.ais/npm/bin location when migration has completed", async () => {
    const home = await makeHome();
    await writeExecutable(join(home, ".ais", "npm", "bin", "claude"));

    const { stdout, stderr } = await resolveInSubprocess(home, "claude");

    expect(stderr).toBe("");
    expect(stdout).toBe(join(home, ".ais", "npm", "bin", "claude"));
  });

  test("falls back to the LEGACY ~/.local/share/ais/npm/bin location while migration is deferred", async () => {
    const home = await makeHome();
    await writeExecutable(join(home, ".local", "share", "ais", "npm", "bin", "claude"));

    const { stdout, stderr } = await resolveInSubprocess(home, "claude");

    expect(stderr).toBe("");
    expect(stdout).toBe(join(home, ".local", "share", "ais", "npm", "bin", "claude"));
  });

  test("prefers the CURRENT location over the legacy one when both exist", async () => {
    const home = await makeHome();
    await writeExecutable(join(home, ".ais", "npm", "bin", "claude"));
    await writeExecutable(join(home, ".local", "share", "ais", "npm", "bin", "claude"));

    const { stdout } = await resolveInSubprocess(home, "claude");

    expect(stdout).toBe(join(home, ".ais", "npm", "bin", "claude"));
  });

  test("errors with a clear message when neither location (nor PATH) has the binary", async () => {
    const home = await makeHome();

    const { stdout, stderr } = await resolveInSubprocess(home, "claude");

    expect(stdout).toBe("");
    expect(stderr).toContain("Could not locate the real 'claude' binary");
  });
});
