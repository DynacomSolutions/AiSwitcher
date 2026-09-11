import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConsoleDaemonCmdline, stopDaemon } from "../../src/cli/web.ts";
import { CliUsageError } from "../../src/cli/errors.ts";
import { writeServerState } from "../../src/server/state.ts";

/** `ais web stop` must never signal a pid that is not a console daemon.
 * These tests redirect the state file at a temp dir through the SAME env the
 * pod uses (AIS_WEB_STATE_DIR), so the real ~/.ais/web/server.json and any
 * real daemon pid are untouched, and fake /proc via stopDaemon's procDir
 * injection. The named pid is always a REAL `sleep` child of this test
 * process: alive enough for the pidAlive gate, and verifiably NOT signalled
 * on the refusal path. */

const tempDirs: string[] = [];
const children: Bun.Subprocess<"ignore", "ignore", "ignore">[] = [];
const originalEnv = process.env.AIS_WEB_STATE_DIR;

afterEach(async () => {
  process.env.AIS_WEB_STATE_DIR = originalEnv;
  for (const child of children.splice(0)) {
    child.kill(9);
    await child.exited;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Live pid (a sleep child) plus its fake /proc/<pid>/cmdline fixture. Pass
 * null as argv to leave the fake /proc entry missing entirely. */
async function fakeDaemonPid(procDir: string, argv: string[] | null): Promise<number> {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  if (argv) {
    await mkdir(join(procDir, String(child.pid)), { recursive: true });
    await writeFile(join(procDir, String(child.pid), "cmdline"), argv.join("\0"));
  }
  return child.pid;
}

async function stateHomeWithPid(pid: number): Promise<string> {
  const home = await tempDir("ais-web-stop-");
  process.env.AIS_WEB_STATE_DIR = home;
  await writeServerState({ pid, port: 47129, token: "t", startedAt: "now" });
  return home;
}

describe("isConsoleDaemonCmdline (the never-kill match rule)", () => {
  test("matches the setsid-wrapped daemon (setsid execs, so ais is not argv[0])", () => {
    expect(
      isConsoleDaemonCmdline(["/usr/bin/setsid", "/usr/local/bin/ais", "web", "--serve-internal", "--port=47129"]),
    ).toBe(true);
  });

  test("matches the bare compiled binary", () => {
    expect(isConsoleDaemonCmdline(["ais", "web", "--serve-internal", "--port=47129"])).toBe(true);
  });

  test("matches the dev-mode bun runtime invocation (script basename carries ais)", () => {
    expect(isConsoleDaemonCmdline(["/usr/bin/bun", "/home/user/ais/src/ais.ts", "web", "--serve-internal"])).toBe(
      true,
    );
  });

  test("refuses unrelated commands", () => {
    expect(isConsoleDaemonCmdline(["sleep", "999"])).toBe(false);
    expect(isConsoleDaemonCmdline(["bash", "-c", "echo hi"])).toBe(false);
  });

  test("refuses an ais process without the --serve-internal daemon marker", () => {
    expect(isConsoleDaemonCmdline(["/usr/local/bin/ais", "tui"])).toBe(false);
    expect(isConsoleDaemonCmdline(["/usr/local/bin/ais", "web", "stop"])).toBe(false);
  });

  test("refuses a marker-bearing argv with no ais-named binary", () => {
    expect(isConsoleDaemonCmdline(["/usr/bin/env", "other", "--serve-internal"])).toBe(false);
  });
});

describe("stopDaemon pid guard", () => {
  test("refuses to signal a pid whose cmdline is not a console daemon and leaves the state file", async () => {
    const procDir = await tempDir("ais-fake-proc-");
    const pid = await fakeDaemonPid(procDir, ["sleep", "999"]);
    const home = await stateHomeWithPid(pid);

    const err: unknown = await stopDaemon({ procDir }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliUsageError);
    expect((err as Error).message).toMatch(/refusing to kill pid/);

    // Nothing was signalled, and the state file still names the refused pid
    // so the situation stays visible for whoever looks next.
    await Bun.sleep(150);
    expect(childAlive(pid)).toBe(true);
    const raw = JSON.parse(await readFile(join(home, "server.json"), "utf8")) as { pid: number };
    expect(raw.pid).toBe(pid);
  });

  test("signals a pid whose cmdline IS a console daemon", async () => {
    const procDir = await tempDir("ais-fake-proc-");
    const pid = await fakeDaemonPid(procDir, [
      "setsid",
      "/usr/local/bin/ais",
      "web",
      "--serve-internal",
      "--port=47129",
    ]);
    await stateHomeWithPid(pid);

    await stopDaemon({ procDir });

    await Bun.sleep(150);
    expect(childAlive(pid)).toBe(false);
  });

  test("falls back to the legacy kill when /proc is unreadable (macOS)", async () => {
    // A procDir without the pid's entry: readProcCmdline returns undefined,
    // which must NOT be treated as a refusal.
    const procDir = await tempDir("ais-empty-proc-");
    const pid = await fakeDaemonPid(procDir, null);
    await stateHomeWithPid(pid);

    await stopDaemon({ procDir });

    await Bun.sleep(150);
    expect(childAlive(pid)).toBe(false);
  });
});

function childAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
