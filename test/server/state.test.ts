import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearServerState } from "../../src/server/state.ts";

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
