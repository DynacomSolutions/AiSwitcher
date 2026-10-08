import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeBinaryForNodeLauncher, resolveRealBinary, shimExecEnvVar } from "../../src/shared/resolve-binary.ts";

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

describe("nativeBinaryForNodeLauncher", () => {
  test("resolves the @openai/codex launcher layout to the vendor native binary", async () => {
    // Verbatim layout of the real managed install on this machine (written
    // 2026-09-04, when @openai/codex moved to the platform-package layout):
    // bin/codex.js is a #!/usr/bin/env node launcher around the platform
    // package's vendor binary.
    const home = await makeHome();
    const pkgRoot = join(home, "npm", "lib", "node_modules", "@openai", "codex");
    const launcher = join(pkgRoot, "bin", "codex.js");
    await Bun.write(launcher, "#!/usr/bin/env node\n");
    // npm installs bin scripts executable; Bun.which (inside
    // resolveRealBinary) requires the exec bit to find the symlink at all.
    await chmod(launcher, 0o755);
    const native = join(pkgRoot, "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex");
    await writeExecutable(native);

    // resolveRealBinary's end-to-end behavior, through the same subprocess
    // harness the legacy-fallback cases use: the managed dir holds a
    // symlink to the launcher (exactly what `ais upgrade`'s npm install
    // creates), and resolution must land on the native binary.
    const binDir = join(home, ".ais", "npm", "bin");
    await mkdir(binDir, { recursive: true });
    await symlink(launcher, join(binDir, "codex"));
    const { stdout, stderr } = await resolveInSubprocess(home, "codex");
    expect(stderr).toBe("");
    expect(stdout).toBe(native);
  });

  test("non-launcher candidates are returned untouched", () => {
    expect(nativeBinaryForNodeLauncher("/any/bin/claude")).toBeNull();
    expect(nativeBinaryForNodeLauncher("/any/bin/codex")).toBeNull();
    expect(nativeBinaryForNodeLauncher("/npm/@openai/codex/bin/codex.ts")).toBeNull();
  });

  test("a launcher whose platform package is missing yields null (fall back to the launcher)", async () => {
    const home = await makeHome();
    const launcher = join(home, "npm", "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
    await Bun.write(launcher, "#!/usr/bin/env node\n");
    expect(nativeBinaryForNodeLauncher(launcher)).toBeNull();
  });
});

describe("resolveRealBinary - shim self-recursion guards (HOME-independent)", () => {
  // Layout: <root>/shims/codex (the installed compiled shim) and
  // <root>/real/codex (the real CLI). SHIM_DIR was computed at import time
  // from the real HOME and never matches <root>, as with a relocated HOME.
  async function layout() {
    const root = await makeHome();
    const shim = join(root, "shims", "codex");
    const real = join(root, "real", "codex");
    await writeExecutable(shim);
    await writeExecutable(real);
    return { root, shim, real };
  }

  test("shim dir on PATH is skipped via the running executable's directory", async () => {
    const { root, shim, real } = await layout();
    const found = resolveRealBinary("codex", {
      execPath: shim,
      env: { PATH: `${join(root, "shims")}:${join(root, "real")}` },
      which: (_n, o) =>
        o.PATH.split(":").includes(join(root, "shims")) ? shim : o.PATH.includes(join(root, "real")) ? real : null,
    });
    expect(found).toBe(real);
  });

  test("candidate equal to own execPath is refused", async () => {
    const { root, shim } = await layout();
    const link = join(root, "link-dir", "codex");
    await mkdir(join(root, "link-dir"), { recursive: true });
    await symlink(shim, link);
    expect(() =>
      resolveRealBinary("codex", { execPath: shim, env: { PATH: "/nonexistent" }, which: () => link }),
    ).toThrow(/running shim itself/);
  });

  test("re-entry env var pointing at own realpath is refused", async () => {
    const { shim, real } = await layout();
    expect(() =>
      resolveRealBinary("codex", {
        execPath: shim,
        env: { PATH: "", [shimExecEnvVar("codex")]: shim },
        which: () => real,
      }),
    ).toThrow(/Aborting instead of recursing/);
  });

  test("legitimate nesting (env holds the real binary path) is allowed", async () => {
    const { shim, real } = await layout();
    expect(
      resolveRealBinary("codex", {
        execPath: shim,
        env: { PATH: "", [shimExecEnvVar("codex")]: real },
        which: () => real,
      }),
    ).toBe(real);
  });

  test("bun interpreter execPath disables the executable-based guards", async () => {
    const root = await makeHome();
    const bun = join(root, "bin", "bun");
    await writeExecutable(bun);
    expect(
      resolveRealBinary("codex", {
        execPath: bun,
        env: { PATH: "", [shimExecEnvVar("codex")]: bun },
        which: () => bun,
      }),
    ).toBe(bun);
  });

  test("PATH containing only the shim dir yields no candidate", async () => {
    const { root, shim } = await layout();
    expect(() =>
      resolveRealBinary("codex", {
        execPath: shim,
        env: { PATH: join(root, "shims") },
        which: (_n, o) => (o.PATH.includes(join(root, "shims")) ? shim : null),
      }),
    ).toThrow(/Could not locate/);
  });
});
