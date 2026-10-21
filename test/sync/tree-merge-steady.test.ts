import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import { mergeIncomingProfileTree, setFsOps } from "../../src/sync/tree-merge.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  setFsOps();
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

function scope(home: string) {
  const cfg: ToolConfig = {
    toolName: "codex",
    realBinaryName: "codex",
    envVarName: "CODEX_HOME",
    globalMemoryProjection: "codex-developer-instructions",
    identitiesJsonPath: join(home, ".codex", "identities.json"),
    identitiesRootDir: join(home, ".codex", "identities"),
  };
  return { kind: "identity" as const, cfg, identityName: "personal" };
}

const rchar = async () => Number(/^rchar: (\d+)/m.exec(await Bun.file("/proc/self/io").text())![1]);

describe("steady-state merge cost", () => {
  test.skipIf(process.platform !== "linux")("a no-change merge of identical large files reads near zero bytes", async () => {
    const home = await makeDir("ais-steady-home-");
    const incoming = await makeDir("ais-steady-incoming-");
    const big = "x".repeat(1_000_000);
    const when = new Date("2026-01-01T00:00:00Z");
    let treeBytes = 0;
    let jsonlBytes = 0;
    for (const name of ["a.bin", "b.bin", "c.jsonl", "d.jsonl"]) {
      const rel = join(".codex", "identities", "personal", name);
      const body = name.endsWith(".jsonl") ? `${big}\n` : big;
      treeBytes += body.length;
      if (name.endsWith(".jsonl")) jsonlBytes += body.length;
      await write(join(home, rel), body);
      await write(join(incoming, rel), body);
      await utimes(join(home, rel), when, when);
      // Same bytes, newer mtime: the case rsync stages. The merge settles it with a bounded compare.
      await utimes(join(incoming, rel), when, new Date(when.getTime() + 5000));
    }
    await mergeIncomingProfileTree(incoming, scope(home), { home });

    // Mtimes now agree, as rsync's size+mtime check would see them.
    const before = await rchar();
    const result = await mergeIncomingProfileTree(incoming, scope(home), { home });
    const read = (await rchar()) - before;
    expect(result.copiedFiles + result.mergedJsonlFiles + result.preservedConflicts).toBe(0);
    // Plain files: zero. JSONL is verified by one bounded chunked compare, never parsed whole.
    expect(read).toBeLessThan(jsonlBytes * 2 + (treeBytes - jsonlBytes) * 0.01);
  });

  test("root-owned files that cannot be re-timed or overwritten are skipped with a warning", async () => {
    const home = await makeDir("ais-eperm-home-");
    const incoming = await makeDir("ais-eperm-incoming-");
    const dir = join(".codex", "identities", "personal", "hooks");
    await write(join(home, dir, "same.sh"), "same");
    await write(join(incoming, dir, "same.sh"), "same");
    await write(join(home, dir, "diff.sh"), "old");
    await write(join(incoming, dir, "diff.sh"), "newer");
    for (const name of ["same.sh", "diff.sh"]) {
      await utimes(join(home, dir, name), new Date(1000), new Date(1000));
      await utimes(join(incoming, dir, name), new Date(1000), new Date(9000));
    }
    const denied = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => { warnings.push(message); };
    setFsOps({ utimes: denied("EPERM") as never, copyFile: denied("EACCES") as never });
    try {
      const result = await mergeIncomingProfileTree(incoming, scope(home), { home });
      expect(result.copiedFiles).toBe(0);
      // Recorded so sync excludes them from later transfers instead of re-staging them each run.
      expect([...result.deniedPaths!].sort()).toEqual([join(dir, "diff.sh"), join(dir, "same.sh")]);
    } finally {
      console.warn = warn;
    }
    expect(warnings.some((w) => w.includes("same.sh") && w.includes("EPERM"))).toBe(true);
    expect(warnings.some((w) => w.includes("diff.sh") && w.includes("EACCES"))).toBe(true);
    expect(await Bun.file(join(home, dir, "diff.sh")).text()).toBe("old");
  });
});
