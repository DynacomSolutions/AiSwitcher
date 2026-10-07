import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClaudeTranscriptRetention } from "../../src/identities/claude-settings.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-claude-settings-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("ensureClaudeTranscriptRetention", () => {
  test("creates settings.json with cleanupPeriodDays when absent", async () => {
    const dir = await makeConfigDir();
    await ensureClaudeTranscriptRetention(dir);
    expect(await Bun.file(join(dir, "settings.json")).json()).toEqual({ cleanupPeriodDays: 3650 });
  });

  test("adds the key while preserving other keys", async () => {
    const dir = await makeConfigDir();
    await writeFile(join(dir, "settings.json"), JSON.stringify({ model: "sonnet", env: { A: "1" } }));
    await ensureClaudeTranscriptRetention(dir);
    expect(await Bun.file(join(dir, "settings.json")).json()).toEqual({ model: "sonnet", env: { A: "1" }, cleanupPeriodDays: 3650 });
  });

  test("never overwrites an existing value", async () => {
    const dir = await makeConfigDir();
    await writeFile(join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
    await ensureClaudeTranscriptRetention(dir);
    expect(await Bun.file(join(dir, "settings.json")).json()).toEqual({ cleanupPeriodDays: 7 });
  });

  test("leaves an unparsable settings.json untouched", async () => {
    const dir = await makeConfigDir();
    await writeFile(join(dir, "settings.json"), "{ not json");
    await ensureClaudeTranscriptRetention(dir);
    expect(await Bun.file(join(dir, "settings.json")).text()).toBe("{ not json");
  });
});
