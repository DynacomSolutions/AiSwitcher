import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import { mergeIncomingProfileTree, recoverProfileArchives } from "../../src/sync/tree-merge.ts";
import { aisRemoteCacheDir } from "../../src/shared/ais-home.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, contents);
}

function codexConfig(home: string): ToolConfig {
  return {
    toolName: "codex",
    realBinaryName: "codex",
    envVarName: "CODEX_HOME",
    identitiesJsonPath: join(home, ".codex", "identities.json"),
    identitiesRootDir: join(home, ".codex", "identities"),
  };
}

async function writeRegistry(root: string, home: string): Promise<void> {
  await write(
    join(root, ".codex", "identities.json"),
    `${JSON.stringify({
      version: 1,
      identities: [
        { name: "personal", label: "Personal", configDir: join(home, ".codex", "identities", "personal") },
      ],
    })}\n`,
  );
}

describe("mergeIncomingProfileTree", () => {
  test("stages a pull and appends divergent JSONL events without replacing the live prefix", async () => {
    const home = await makeDir("ais-tree-home-");
    const incoming = await makeDir("ais-tree-incoming-");
    await writeRegistry(home, home);
    await writeRegistry(incoming, home);
    const id = "019c6bae-53b5-7423-a82b-9ef199147d04";
    const rel = join(
      ".codex",
      "identities",
      "personal",
      "sessions",
      "2026",
      "07",
      "22",
      `rollout-${id}.jsonl`,
    );
    const live = join(home, rel);
    const remote = join(incoming, rel);
    await write(live, 'shared\nlocal\n');
    await write(remote, 'shared\nremote\n');

    const result = await mergeIncomingProfileTree(incoming, {
      kind: "identity",
      cfg: codexConfig(home),
      identityName: "personal",
    }, { home });

    expect(result.mergedJsonlFiles).toBe(1);
    expect(await Bun.file(live).text()).toBe('shared\nlocal\nremote\n');
    expect(await Bun.file(remote).text()).toBe('shared\nremote\n');
  });

  test("never imports a partial JSONL record and retains its incoming bytes", async () => {
    const home = await makeDir("ais-tree-partial-home-");
    const incoming = await makeDir("ais-tree-partial-incoming-");
    const conflictRoot = join(aisRemoteCacheDir(home), "merge-conflicts", "test");
    await writeRegistry(home, home);
    await writeRegistry(incoming, home);
    const rel = join(".codex", "identities", "personal", "history.jsonl");
    await write(join(home, rel), 'complete\n');
    await write(join(incoming, rel), 'complete\n{"partial":');

    const result = await mergeIncomingProfileTree(incoming, {
      kind: "identity",
      cfg: codexConfig(home),
      identityName: "personal",
    }, { home, conflictRoot });

    expect(await Bun.file(join(home, rel)).text()).toBe('complete\n');
    expect(result.preservedConflicts).toBe(1);
    expect(await Bun.file(join(conflictRoot, "incoming", rel)).text()).toBe('complete\n{"partial":');
  });

  test("defers an incoming history while a native process still owns the live file", async () => {
    const home = await makeDir("ais-tree-open-home-");
    const incoming = await makeDir("ais-tree-open-incoming-");
    const conflictRoot = join(aisRemoteCacheDir(home), "merge-conflicts", "open-test");
    await writeRegistry(home, home);
    await writeRegistry(incoming, home);
    const rel = join(".codex", "identities", "personal", "history.jsonl");
    const live = join(home, rel);
    await write(live, 'local\n');
    await write(join(incoming, rel), 'remote\n');
    const handle = await open(live, "a");
    try {
      const result = await mergeIncomingProfileTree(incoming, {
        kind: "identity",
        cfg: codexConfig(home),
        identityName: "personal",
      }, { home, conflictRoot });
      expect(result.preservedConflicts).toBe(1);
      expect(await Bun.file(live).text()).toBe('local\n');
      expect(await Bun.file(join(conflictRoot, "incoming", rel)).text()).toBe('remote\n');
    } finally {
      await handle.close();
    }
  });
});

describe("recoverProfileArchives", () => {
  test("restores a longer cached history additively and retains its recovery copy", async () => {
    const home = await makeDir("ais-recover-home-");
    const rel = join(".codex", "identities", "personal", "sessions", "2026", "07", "22", "rollout.jsonl");
    const live = join(home, rel);
    const archived = join(aisRemoteCacheDir(home), "sync-conflicts", "run-remote1", rel);
    await write(live, 'one\ntwo\n');
    await write(archived, 'one\ntwo\nthree\nfour\n');

    const dryRun = await recoverProfileArchives({ home, dryRun: true });
    expect(dryRun).toMatchObject({ archiveRoots: 1, mergedJsonlFiles: 1 });
    expect(await Bun.file(live).text()).toBe('one\ntwo\n');

    const result = await recoverProfileArchives({ home });
    expect(result.mergedJsonlFiles).toBe(1);
    expect(await Bun.file(live).text()).toBe('one\ntwo\nthree\nfour\n');
    expect(await Bun.file(archived).text()).toBe('one\ntwo\nthree\nfour\n');
  });
});
