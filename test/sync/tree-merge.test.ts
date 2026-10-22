import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, readdir, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { appendFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import {
  hasOpenOwner,
  mergeIncomingProfileTree,
  recoverProfileArchives,
  setDirectOwnerProbe,
  setOpenScanner,
  setProcReader,
} from "../../src/sync/tree-merge.ts";
import { setJsonlWriter } from "../../src/sync/dedupe.ts";
import { aisRemoteCacheDir } from "../../src/shared/ais-home.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  setDirectOwnerProbe();
  setOpenScanner();
  setProcReader();
  setJsonlWriter();
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

function deferredPath(home: string, rel: string): string {
  return join(aisRemoteCacheDir(home), "merge-conflicts", "deferred", "incoming", rel);
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

function injectInaccessibleProcess(uid: number | number[], openPaths: string[] = []): void {
  const uids = typeof uid === "number" ? [uid, uid, uid, uid] : uid;
  setProcReader({
    async readdir(path) {
      if (path === "/proc") return ["2147483646", "2147483645"];
      if (path === "/proc/2147483646/fd") throw Object.assign(new Error("SYNTHETIC_FIXTURE_access"), { code: "EACCES" });
      return openPaths.map((_, index) => String(index));
    },
    async readlink(path) { return openPaths[Number(path.split("/").at(-1))]!; },
    async readFile() { return `Name:\tSYNTHETIC_FIXTURE_process\nUid:\t${uids.join("\t")}\n`; },
  });
}

describe.skipIf(process.platform !== "linux")("inaccessible /proc entries", () => {
  for (const owner of ["other", "same", "root"] as const) {
    test(`${owner}-uid fd access failure does not starve a closed file`, async () => {
      const home = await makeDir("ais-proc-owner-");
      const path = join(home, "history.jsonl");
      await write(path, "SYNTHETIC_FIXTURE_local\n");
      const uid = (await stat(path)).uid;
      injectInaccessibleProcess(owner === "other" ? uid + 1 : owner === "same" ? uid : 0);
      // Exercise the real scanner, including its /proc traversal and UID
      // decision, with only the filesystem reader injected.
      expect(await hasOpenOwner(path, { lookups: 4 })).toBe(false);
    });
  }

  test("one pid with an unreadable fd directory does not stop the other histories from merging", async () => {
    const home = await makeDir("ais-proc-eacces-home-");
    const incoming = await makeDir("ais-proc-eacces-incoming-");
    const paths = Array.from({ length: 8 }, (_, i) => join(".codex", "identities", "personal", `${i}.jsonl`));
    for (const rel of paths) {
      await write(join(home, rel), "SYNTHETIC_FIXTURE_local\n");
      await write(join(incoming, rel), "SYNTHETIC_FIXTURE_local\nSYNTHETIC_FIXTURE_remote\n");
    }
    const busy = await realpath(join(home, paths[0]!));
    setProcReader({
      async readdir(path) {
        if (path === "/proc") return ["2147483646", "2147483645"];
        if (path === "/proc/2147483646/fd") throw Object.assign(new Error("SYNTHETIC_FIXTURE_access"), { code: "EACCES" });
        return ["0"];
      },
      async readlink() { return busy; },
      async readFile() { return ""; },
    });
    // No lsof on PATH: the /proc reader alone must decide.
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const result = await mergeIncomingProfileTree(incoming, { kind: "identity", cfg: codexConfig(home), identityName: "personal" }, { home });
      expect(result.busyPaths).toEqual([paths[0]!]);
      expect(result.mergedJsonlFiles).toBe(7);
    } finally { process.env.PATH = savedPath; }
  });

  test("only an unreadable /proc itself is unknown", async () => {
    const home = await makeDir("ais-proc-unreadable-");
    const path = join(home, "history.jsonl");
    await write(path, "SYNTHETIC_FIXTURE_local\n");
    setProcReader({
      async readdir() { throw Object.assign(new Error("SYNTHETIC_FIXTURE_access"), { code: "EACCES" }); },
      async readlink() { throw new Error("SYNTHETIC_FIXTURE_unexpected_link"); },
      async readFile() { return ""; },
    });
    expect(await hasOpenOwner(path, { lookups: 4 })).toBeUndefined();
  });
});

describe("mergeIncomingProfileTree", () => {
  test.skipIf(process.platform !== "linux")("four busy logs and an unreadable unrelated process do not starve ten later closed logs", async () => {
    const home = await makeDir("ais-tree-budget-home-");
    const incoming = await makeDir("ais-tree-budget-incoming-");
    const paths = Array.from({ length: 14 }, (_, i) => join(".codex", "identities", "personal", `${i.toString().padStart(2, "0")}.jsonl`));
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    try {
      for (const [i, rel] of paths.entries()) {
        await write(join(home, rel), "SYNTHETIC_FIXTURE_local\n");
        await write(join(incoming, rel), "SYNTHETIC_FIXTURE_remote\n");
        if (i < 4) handles.push(await open(join(home, rel), "a"));
      }
      const busy = await Promise.all(paths.slice(0, 4).map((rel) => realpath(join(home, rel))));
      injectInaccessibleProcess((await stat(home)).uid + 1, busy);
      const result = await mergeIncomingProfileTree(incoming, {
        kind: "identity", cfg: codexConfig(home), identityName: "personal",
      }, { home });
      expect(result.mergedJsonlFiles).toBe(10);
      expect(result.busyPaths).toEqual(paths.slice(0, 4));
      expect(result.preservedConflictPaths).toEqual([]);
      for (const [i, rel] of paths.entries()) {
        expect(await Bun.file(join(home, rel)).text()).toBe(i < 4
          ? "SYNTHETIC_FIXTURE_local\n" : "SYNTHETIC_FIXTURE_local\nSYNTHETIC_FIXTURE_remote\n");
      }
    } finally { await Promise.all(handles.map((handle) => handle.close())); }
  }, 30_000);

  for (const existing of [false, true]) {
    test(`retains the incoming copy after a post-check ${existing ? "append" : "create"} size mismatch`, async () => {
      const home = await makeDir("ais-tree-post-write-home-");
      const incoming = await makeDir("ais-tree-post-write-incoming-");
      const rel = join(".codex", "identities", "personal", "history.jsonl");
      const live = join(home, rel);
      const remote = "SYNTHETIC_FIXTURE_imported\n";
      await write(join(incoming, rel), remote);
      if (existing) await write(live, "SYNTHETIC_FIXTURE_local\n");
      let writes = 0;
      setJsonlWriter((fd, payload) => {
        writes++;
        appendFileSync(live, "SYNTHETIC_FIXTURE_partial");
        return writeSync(fd, payload, 0, payload.length);
      });
      const result = await mergeIncomingProfileTree(incoming, {
        kind: "identity", cfg: codexConfig(home), identityName: "personal",
      }, { home });
      expect(writes).toBe(1);
      expect(result.mergedJsonlFiles).toBe(0);
      expect(result.preservedConflictPaths).toEqual([rel]);
      expect(await Bun.file(deferredPath(home, rel)).text()).toBe(remote);
    });
  }

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
    expect(await Bun.file(deferredPath(home, rel)).text()).toBe('complete\n{"partial":');
  });

  test("defers a closed destination with an incomplete native tail and reports its path", async () => {
    const home = await makeDir("ais-tree-closed-partial-home-");
    const incoming = await makeDir("ais-tree-closed-partial-incoming-");
    const conflictRoot = join(aisRemoteCacheDir(home), "merge-conflicts", "closed-partial-test");
    await writeRegistry(home, home);
    await writeRegistry(incoming, home);
    const rel = join(".codex", "identities", "personal", "history.jsonl");
    await write(join(home, rel), 'complete\nSYNTHETIC_FIXTURE_partial');
    await write(join(incoming, rel), 'complete\nSYNTHETIC_FIXTURE_remote\n');

    const result = await mergeIncomingProfileTree(incoming, {
      kind: "identity",
      cfg: codexConfig(home),
      identityName: "personal",
    }, { home, conflictRoot });

    expect(result.preservedConflicts).toBe(1);
    expect(result.preservedConflictPaths).toEqual([rel]);
    expect(await Bun.file(join(home, rel)).text()).toBe('complete\nSYNTHETIC_FIXTURE_partial');
    expect(await Bun.file(deferredPath(home, rel)).text()).toBe('complete\nSYNTHETIC_FIXTURE_remote\n');
  });

  test("defers an incoming history, without copying it, while a native process still owns the live file", async () => {
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
      expect(result.preservedConflicts).toBe(0);
      expect(result.busyPaths).toEqual([rel]);
      expect(await Bun.file(live).text()).toBe('local\n');
      expect(await Bun.file(deferredPath(home, rel)).exists()).toBe(false);
    } finally {
      await handle.close();
    }
  });

  test("repeated and growing deferrals keep one latest copy per destination across runs", async () => {
    const home = await makeDir("ais-tree-bounded-home-");
    const incoming = await makeDir("ais-tree-bounded-incoming-");
    setDirectOwnerProbe(async () => false);
    setOpenScanner(async () => new Set());
    const rel = join(".codex", "identities", "personal", "history.jsonl");
    await write(join(home, rel), "SYNTHETIC_FIXTURE_incomplete");
    const scope = { kind: "identity" as const, cfg: codexConfig(home), identityName: "personal" };
    let contents = "";
    for (let i = 0; i < 6; i++) {
      contents += `SYNTHETIC_FIXTURE_event_${i}\n`;
      await write(join(incoming, rel), contents);
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await mergeIncomingProfileTree(incoming, scope, {
          home, conflictRoot: join(aisRemoteCacheDir(home), "merge-conflicts", `run-${i}-${repeat}`),
        });
        expect(result.preservedConflictPaths).toEqual([rel]);
      }
    }
    const root = join(aisRemoteCacheDir(home), "merge-conflicts");
    const files = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".jsonl"));
    expect(files).toEqual([join("deferred", "incoming", rel)]);
    expect(await Bun.file(deferredPath(home, rel)).text()).toBe(contents);
    await write(join(home, rel), "SYNTHETIC_FIXTURE_local\n");
    const recovered = await recoverProfileArchives({ home });
    expect(recovered.mergedJsonlFiles).toBe(1);
    expect(await Bun.file(join(home, rel)).text()).toBe(`SYNTHETIC_FIXTURE_local\n${contents}`);
    expect(await Bun.file(deferredPath(home, rel)).text()).toBe(contents);
  });

  test("retains divergent deferrals once each and recovers their original paths", async () => {
    const home = await makeDir("ais-tree-unresolved-home-");
    setDirectOwnerProbe(async () => false);
    setOpenScanner(async () => new Set());
    const incoming = await makeDir("ais-tree-unresolved-incoming-");
    const rel = join(".codex", "identities", "personal", "history.jsonl");
    await write(join(home, rel), "SYNTHETIC_FIXTURE_incomplete");
    const scope = { kind: "identity" as const, cfg: codexConfig(home), identityName: "personal" };
    for (const event of ["one", "two", "one", "two", "one", "two"]) {
      await write(join(incoming, rel), `SYNTHETIC_FIXTURE_${event}\n`);
      await mergeIncomingProfileTree(incoming, scope, { home });
    }
    const root = join(aisRemoteCacheDir(home), "merge-conflicts");
    expect((await readdir(root, { recursive: true })).filter((path) => path.endsWith(".jsonl"))).toHaveLength(3);
    await write(join(home, rel), "SYNTHETIC_FIXTURE_local\n");
    await recoverProfileArchives({ home });
    expect((await Bun.file(join(home, rel)).text()).trim().split("\n").sort()).toEqual([
      "SYNTHETIC_FIXTURE_local", "SYNTHETIC_FIXTURE_one", "SYNTHETIC_FIXTURE_two",
    ]);
  });
});

describe("mtime convergence", () => {
  test("identical files take the newer mtime; contents never change", async () => {
    const home = await makeDir("ais-tree-mtime-home-");
    const incoming = await makeDir("ais-tree-mtime-incoming-");
    await writeRegistry(home, home);
    await writeRegistry(incoming, home);
    const dir = join(".codex", "identities", "personal");
    for (const name of ["a.json", "b.jsonl"]) {
      await write(join(home, dir, name), "same\n");
      await write(join(incoming, dir, name), "same\n");
      await utimes(join(home, dir, name), new Date(1_000_000), new Date(1_000_000));
      await utimes(join(incoming, dir, name), new Date(2_000_000), new Date(2_000_000));
    }
    await mergeIncomingProfileTree(incoming, { kind: "identity", cfg: codexConfig(home), identityName: "personal" }, { home });
    for (const name of ["a.json", "b.jsonl"]) {
      expect((await stat(join(home, dir, name))).mtimeMs).toBe(2_000_000);
      expect(await Bun.file(join(home, dir, name)).text()).toBe("same\n");
    }
  });
});

describe("recoverProfileArchives", () => {
  test("recovers earlier merge-conflicts side roots and UUID-suffixed histories", async () => {
    const home = await makeDir("ais-recover-merge-conflicts-");
    setDirectOwnerProbe(async () => false);
    setOpenScanner(async () => new Set());
    const rel = join(".codex", "identities", "personal", "history.jsonl");
    const root = join(aisRemoteCacheDir(home), "merge-conflicts", "earlier-run");
    await write(join(root, "incoming", rel), "SYNTHETIC_FIXTURE_incoming\n");
    await write(join(root, "incoming", `${rel}.11111111-1111-4111-8111-111111111111`), "SYNTHETIC_FIXTURE_duplicate\n");
    const interrupted = `${rel}.22222222-2222-4222-8222-222222222222.tmp`;
    await write(join(root, "incoming", interrupted), "SYNTHETIC_FIXTURE_partial");
    await write(join(root, "local", rel), "SYNTHETIC_FIXTURE_local\n");
    const result = await recoverProfileArchives({ home });
    expect(result.archiveRoots).toBe(2);
    expect((await Bun.file(join(home, rel)).text()).trim().split("\n").sort()).toEqual([
      "SYNTHETIC_FIXTURE_duplicate", "SYNTHETIC_FIXTURE_incoming", "SYNTHETIC_FIXTURE_local",
    ]);
    expect(await Bun.file(join(home, "incoming", rel)).exists()).toBe(false);
    expect(await Bun.file(join(home, interrupted)).exists()).toBe(false);
    expect(await Bun.file(join(root, "incoming", interrupted)).exists()).toBe(true);
    expect(await Bun.file(join(root, "incoming", rel)).exists()).toBe(true);
  });

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


describe("hasOpenOwner", () => {
  afterEach(() => setOpenScanner());

  test("per-file path reports a file held by a child open and a closed one not", async () => {
    const dir = await makeDir("ais-open-owner-");
    const held = join(dir, "held.jsonl");
    const closed = join(dir, "closed.jsonl");
    await Bun.write(held, "x\n");
    await Bun.write(closed, "x\n");
    const child = Bun.spawn(["sh", "-c", `exec 3<"${held}"; echo ready; sleep 30`], { stdout: "pipe" });
    try {
      await child.stdout.getReader().read();
      const pass = { lookups: 0 };
      expect(await hasOpenOwner(held, pass)).toBe(true);
      expect(await hasOpenOwner(closed, pass)).toBe(false);
      expect(await hasOpenOwner(join(dir, "missing.jsonl"), pass)).toBe(false);
    } finally {
      child.kill();
    }
  });

  test("after the per-file budget, many lookups share one snapshot scan", async () => {
    const dir = await makeDir("ais-open-owner-snap-");
    const held = join(dir, "held.jsonl");
    const closed = join(dir, "closed.jsonl");
    await Bun.write(held, "x\n");
    await Bun.write(closed, "x\n");
    let scans = 0;
    setOpenScanner(async () => {
      scans++;
      return new Set([await realpath(held)]);
    });
    const pass = { lookups: 1000 };
    expect(await hasOpenOwner(held, pass)).toBe(true);
    for (let i = 0; i < 50; i++) expect(await hasOpenOwner(closed, pass)).toBe(false);
    expect(scans).toBe(1);
    expect(await hasOpenOwner(closed, { lookups: 4 })).toBe(false);
    expect(scans).toBe(2);
  });

  test("a fresh direct check catches a writer that opened after a snapshot miss", async () => {
    const dir = await makeDir("ais-open-owner-after-snapshot-");
    const path = join(dir, "history.jsonl");
    await Bun.write(path, "SYNTHETIC_FIXTURE_line\n");
    setOpenScanner(async () => new Set());
    const cachedPass = { lookups: 1000 };
    expect(await hasOpenOwner(path, cachedPass)).toBe(false);
    const handle = await open(path, "a");
    try {
      expect(await hasOpenOwner(path, cachedPass)).toBe(false);
      expect(await hasOpenOwner(path, { lookups: 0 })).toBe(true);
    } finally { await handle.close(); }
  });

  test("an unverifiable snapshot answers undefined", async () => {
    const dir = await makeDir("ais-open-owner-unk-");
    const file = join(dir, "a.jsonl");
    await Bun.write(file, "x\n");
    setOpenScanner(async () => undefined);
    expect(await hasOpenOwner(file, { lookups: 1000 })).toBeUndefined();
  });

  test("a stalled snapshot is aborted and remains unknown for the pass", async () => {
    const dir = await makeDir("ais-open-owner-timeout-");
    const file = join(dir, "history.jsonl");
    await Bun.write(file, "SYNTHETIC_FIXTURE_line\n");
    let scans = 0;
    let signal: AbortSignal | undefined;
    setOpenScanner(async (scanSignal) => {
      scans++;
      signal = scanSignal;
      return new Promise(() => {});
    }, 20);
    const pass = { lookups: 4 };
    expect(await hasOpenOwner(file, pass)).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(await hasOpenOwner(file, pass)).toBeUndefined();
    expect(scans).toBe(1);
  });
});
