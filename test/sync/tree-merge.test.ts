import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, readdir, rm, stat, utimes } from "node:fs/promises";
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
    globalMemoryProjection: "codex-developer-instructions",
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

describe("post-merge credential purge", () => {
  test("a credential copied in from the remote is purged for a retired identity only", async () => {
    const home = await makeDir("ais-tree-retired-home-");
    const incoming = await makeDir("ais-tree-retired-incoming-");
    const entry = (name: string, extra: object = {}) => ({
      name,
      label: name,
      configDir: join(home, ".codex", "identities", name),
      ...extra,
    });
    await write(
      join(home, ".codex", "identities.json"),
      JSON.stringify({
        version: 1,
        identities: [
          entry("old-team", { retired: true, retiredAt: "2026-02-01T00:00:00.000Z" }),
          entry("work"),
        ],
      }),
    );
    // The remote still believes both are active and carries their credentials.
    await write(
      join(incoming, ".codex", "identities.json"),
      JSON.stringify({ version: 1, identities: [entry("old-team"), entry("work")] }),
    );
    for (const name of ["old-team", "work"]) {
      await write(join(incoming, ".codex", "identities", name, "auth.json"), '{"secret":"x"}');
      await write(join(incoming, ".codex", "identities", name, "history.jsonl"), "event\n");
    }

    await mergeIncomingProfileTree(incoming, { kind: "all" }, { home });

    const oldDir = join(home, ".codex", "identities", "old-team");
    expect(await Bun.file(join(oldDir, "auth.json")).exists()).toBe(false);
    expect(await Bun.file(join(oldDir, "history.jsonl")).exists()).toBe(true);
    expect(await Bun.file(join(home, ".codex", "identities", "work", "auth.json")).exists()).toBe(true);
    const merged = await Bun.file(join(home, ".codex", "identities.json")).json();
    expect(merged.identities.find((i: { name: string }) => i.name === "old-team").retired).toBe(true);
  });

  // Explicit mtimes pin the newest-wins branch: either side may be newer, and
  // the registries and credentials must be handled identically in both.
  for (const newer of ["incoming", "local", "equal"] as const) {
  test(`conflict copies of a retired identity's credentials are scrubbed, other conflicts kept (${newer} newer)`, async () => {
    const home = await makeDir("ais-tree-retired-conflict-home-");
    const incoming = await makeDir("ais-tree-retired-conflict-in-");
    const conflictRoot = await makeDir("ais-tree-retired-conflicts-");
    const entry = (name: string, extra: object = {}) => ({
      name,
      label: name,
      configDir: join(home, ".codex", "identities", name),
      ...extra,
    });
    const zaiEntry = {
      name: "old-zai",
      label: "old-zai",
      configDir: join(home, ".zai", "identities", "old-zai"),
      retired: true,
      retiredAt: "2026-02-01T00:00:00.000Z",
    };
    await write(
      join(home, ".codex", "identities.json"),
      JSON.stringify({ version: 1, identities: [entry("old-team", { retired: true, retiredAt: "2026-02-01T00:00:00.000Z" }), entry("work")] }),
    );
    await write(join(home, ".zai", "identities.json"), JSON.stringify({ version: 1, identities: [zaiEntry] }));
    await write(join(incoming, ".codex", "identities.json"), JSON.stringify({ version: 1, identities: [entry("old-team"), entry("work")] }));
    await write(join(incoming, ".zai", "identities.json"), JSON.stringify({ version: 1, identities: [{ ...zaiEntry, retired: undefined, retiredAt: undefined }] }));
    // Both sides differ for every file, so each live copy is preserved or overwritten.
    for (const name of ["old-team", "work"]) {
      await write(join(home, ".codex", "identities", name, "auth.json"), '{"secret":"local"}');
      await write(join(incoming, ".codex", "identities", name, "auth.json"), '{"secret":"remote"}');
    }
    const crush = (key: string) => JSON.stringify({ providers: { zai: { api_key: key, base_url: "https://example.invalid" } } });
    await write(join(home, ".zai", "identities", "old-zai", "crush.json"), crush("local-key"));
    await write(join(incoming, ".zai", "identities", "old-zai", "crush.json"), crush("remote-key"));

    const old = new Date("2026-03-01T00:00:00Z");
    const recent = new Date("2026-03-02T00:00:00Z");
    for (const [root, isIncoming] of [[home, false], [incoming, true]] as const) {
      const when = newer === "equal" ? old : (newer === "incoming") === isIncoming ? recent : old;
      for (const file of await readdir(root, { recursive: true })) {
        const full = join(root, file);
        if ((await stat(full)).isFile()) await utimes(full, when, when);
      }
    }

    await mergeIncomingProfileTree(incoming, { kind: "all" }, { home, conflictRoot });

    const preserved: string[] = [];
    for (const side of ["local", "incoming"]) {
      const files = await readdir(join(conflictRoot, side), { recursive: true }).catch(() => [] as string[]);
      for (const f of files) if (!(await stat(join(conflictRoot, side, f))).isDirectory()) preserved.push(`${side}/${f}`);
    }
    // No retired-identity codex credential survives under the conflict dir; work's does.
    expect(preserved.filter((p) => p.includes("old-team"))).toEqual([]);
    expect(preserved.filter((p) => p.includes("work") && p.endsWith("auth.json")).length).toBe(1);
    // The retired zai crush.json copy is kept without its api key.
    const crushCopies = preserved.filter((p) => p.includes("old-zai"));
    expect(crushCopies.length).toBe(1);
    const copy = await Bun.file(join(conflictRoot, crushCopies[0]!)).json();
    expect(copy.providers.zai.api_key).toBeUndefined();
    expect(copy.providers.zai.base_url).toBe("https://example.invalid");
  });
  }

  test("uses an injected purge", async () => {
    const home = await makeDir("ais-tree-retired-inject-");
    const incoming = await makeDir("ais-tree-retired-inject-in-");
    await write(
      join(home, ".codex", "identities.json"),
      JSON.stringify({
        version: 1,
        identities: [
          {
            name: "old-team",
            label: "Old",
            configDir: join(home, ".codex", "identities", "old-team"),
            retired: true,
            retiredAt: "2026-02-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const seen: string[] = [];
    await mergeIncomingProfileTree(incoming, { kind: "identity", cfg: codexConfig(home), identityName: "old-team" }, {
      home,
      purgeRetired: async (opts) => {
        seen.push(`${opts.toolName}:${opts.identity.name}`);
        return { removed: [], warnings: [] };
      },
    });
    expect(seen).toEqual(["codex:old-team"]);
  });
});

