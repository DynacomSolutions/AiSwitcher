import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearServerState, consoleServerStatePath, consoleWebDir, writeServerState } from "../../src/server/state.ts";

const tempDirs: string[] = [];
const pid = process.pid;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateFileWith(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-state-"));
  tempDirs.push(dir);
  const path = join(dir, "server.json");
  await mkdir(join(dir, "web"), { recursive: true });
  await writeFile(path, JSON.stringify(content));
  return path;
}

describe("clearServerState pid guard", () => {
  test("deletes the state file when it describes this process", async () => {
    const path = await stateFileWith({ pid, port: 47129, token: "t", startedAt: "now" });
    await clearServerState(path);
    await expect(readFile(path)).rejects.toThrow();
  });

  test("leaves the state file alone when a newer daemon owns it", async () => {
    const path = await stateFileWith({ pid: pid + 999_999, port: 47129, token: "t", startedAt: "now" });
    await clearServerState(path);
    const raw = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    expect(raw.pid).toBe(pid + 999_999);
  });

  test("removes an unparsable file: nothing newer can be identified from it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-state-"));
    tempDirs.push(dir);
    const path = join(dir, "server.json");
    await writeFile(path, "not json at all");
    await clearServerState(path);
    await expect(readFile(path)).rejects.toThrow();
  });
});

/** AIS_WEB_STATE_DIR is mutated in-place per test and restored in a finally
 * position: these assertions must hold no matter what a previous test in the
 * process left behind. */
describe("consoleWebDir AIS_WEB_STATE_DIR override", () => {
  let previous: string | undefined;

  const setEnv = (value: string | undefined) => {
    if (value === undefined) delete process.env.AIS_WEB_STATE_DIR;
    else process.env.AIS_WEB_STATE_DIR = value;
  };

  beforeEach(() => {
    previous = process.env.AIS_WEB_STATE_DIR;
  });

  afterEach(() => setEnv(previous));

  test("unset keeps the historic ~/.ais/web default", () => {
    setEnv(undefined);
    expect(consoleWebDir()).toBe(join(homedir(), ".ais", "web"));
    expect(consoleServerStatePath()).toBe(join(homedir(), ".ais", "web", "server.json"));
  });

  test("a blank value is treated as unset", () => {
    setEnv("   ");
    expect(consoleWebDir()).toBe(join(homedir(), ".ais", "web"));
  });

  test("set relocates the state dir and server.json follows", () => {
    setEnv("/web/state");
    expect(consoleWebDir()).toBe(resolve("/web/state"));
    expect(consoleServerStatePath()).toBe(join(resolve("/web/state"), "server.json"));
  });

  test("writeServerState mkdir -p's the override and writes server.json there (the daemon-start write path)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ais-override-"));
    tempDirs.push(root);
    const override = join(root, "nested", "state");
    setEnv(override);
    await writeServerState({ pid, port: 4799, token: "t", startedAt: "now" });
    const raw = JSON.parse(await readFile(join(override, "server.json"), "utf8")) as {
      pid: number;
      port: number;
    };
    expect(raw).toMatchObject({ pid, port: 4799 });
  });
});
