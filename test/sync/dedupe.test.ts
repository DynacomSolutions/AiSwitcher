import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deduplicateUsageData, mergeJsonlLineSets } from "../../src/sync/dedupe.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "ais-dedupe-"));
  tempDirs.push(home);
  return home;
}

async function writeRegistry(home: string, root: string, identities: string[]): Promise<void> {
  await mkdir(join(home, root), { recursive: true });
  await Bun.write(
    join(home, root, "identities.json"),
    `${JSON.stringify({
      version: 1,
      identities: identities.map((name) => ({
        name,
        label: name,
        configDir: join(home, root, "identities", name),
      })),
    })}\n`,
  );
}

async function writeFile(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, contents);
}

describe("mergeJsonlLineSets", () => {
  test("takes a multiset union without double-counting a copied event", () => {
    expect(mergeJsonlLineSets([["a", "same", "same", "b"], ["a", "same", "c"]])).toEqual([
      "a",
      "same",
      "same",
      "b",
      "c",
    ]);
  });
});

describe("deduplicateUsageData", () => {
  test("never treats matching session IDs in different identities as duplicate data", async () => {
    const home = await makeHome();
    await writeRegistry(home, ".codex", ["identity-b", "identity-a"]);
    const id = "019c6bae-53b5-7423-a82b-9ef199147d04";
    const fileName = `rollout-2026-07-22T01-02-03-${id}.jsonl`;
    const identityA = join(home, ".codex", "identities", "identity-a", "sessions", "2026", "07", "22", fileName);
    const team = join(home, ".codex", "identities", "identity-b", "sessions", "2026", "07", "22", fileName);
    const legacy = join(home, ".codex", "sessions", "2026", "07", "22", fileName);
    await writeFile(identityA, '{"event":"shared"}\n{"event":"identity-a"}\n');
    await writeFile(team, '{"event":"shared"}\n{"event":"team"}\n');
    await writeFile(legacy, '{"event":"shared"}\n');

    const dryRun = await deduplicateUsageData({ home, dryRun: true });
    expect(dryRun).toMatchObject({ duplicateSessions: 0, divergentSessions: 0, archivedPaths: 0 });
    expect(await Bun.file(team).exists()).toBe(true);

    const archiveRoot = join(home, ".cache", "ais", "test-archive");
    const result = await deduplicateUsageData({ home, archiveRoot });

    expect(result).toMatchObject({
      duplicateSessions: 0,
      divergentSessions: 0,
      mergedJsonlFiles: 0,
      archivedPaths: 0,
      unresolvedLegacySessions: 1,
    });
    expect(await Bun.file(identityA).text()).toBe('{"event":"shared"}\n{"event":"identity-a"}\n');
    expect(await Bun.file(team).text()).toBe('{"event":"shared"}\n{"event":"team"}\n');
    expect(await Bun.file(legacy).exists()).toBe(true);
  });

  test("merges a conflict-backup copy even when there is only one live path", async () => {
    const home = await makeHome();
    await writeRegistry(home, ".claude", ["personal"]);
    const id = "eabd3845-ed91-4929-a7ae-b172765804a7";
    const rel = join(".claude", "identities", "personal", "projects", "-Users-t-Project", `${id}.jsonl`);
    const live = join(home, rel);
    const conflictRoot = join(home, ".cache", "ais", "conflicts", "remote1");
    const previous = join(conflictRoot, rel);
    await writeFile(live, '{"uuid":"remote"}\n');
    await writeFile(previous, '{"uuid":"local"}\n');

    const result = await deduplicateUsageData({ home, supplementalRoots: [conflictRoot] });

    expect(result).toMatchObject({ divergentSessions: 1, mergedJsonlFiles: 1, archivedPaths: 0 });
    expect(await Bun.file(live).text()).toBe('{"uuid":"remote"}\n{"uuid":"local"}\n');
  });

  test("moves a unique legacy Kimi session into the only configured identity", async () => {
    const home = await makeHome();
    await writeRegistry(home, ".kimi-code", ["identity-a"]);
    const id = "124044d7-c3cc-4167-ad5f-bed40f0fb5ca";
    const legacyDir = join(home, ".kimi-code", "sessions", "wd_project_hash", `session_${id}`);
    await writeFile(join(legacyDir, "state.json"), '{"title":"legacy"}\n');
    await writeFile(join(legacyDir, "agents", "main", "wire.jsonl"), '{"type":"message"}\n');

    const archiveRoot = join(home, ".cache", "ais", "test-archive");
    const result = await deduplicateUsageData({ home, archiveRoot });
    const assigned = join(
      home,
      ".kimi-code",
      "identities",
      "identity-a",
      "sessions",
      "wd_project_hash",
      `session_${id}`,
    );

    expect(result).toMatchObject({ assignedLegacySessions: 1, duplicateSessions: 1, archivedPaths: 1 });
    expect(await Bun.file(join(assigned, "state.json")).exists()).toBe(true);
    expect(await Bun.file(join(assigned, "agents", "main", "wire.jsonl")).exists()).toBe(true);
    expect(await Bun.file(join(legacyDir, "state.json")).exists()).toBe(false);
  });
});
