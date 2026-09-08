import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";

/** The files endpoints are exercised through synthetic ToolConfigs whose
 * registries live in a temp dir (the same injection pattern
 * collectLimitTargets uses), so nothing here can touch the real home. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-files-"));
  tempDirs.push(dir);
  return dir;
}

function fakeConfig(configDir: string): ToolConfig {
  return {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    identitiesJsonPath: join(configDir, "identities.json"),
    identitiesRootDir: join(configDir, "identities"),
    globalMemoryProjection: "claude-append-file",
  };
}

describe("console files endpoints", () => {
  /** Every test needs at least one registered identity or there are no
   * identity-derived roots to address. */
  async function makeSeeded(): Promise<{ dir: string; configs: ToolConfig[] }> {
    const dir = await makeRoot();
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, "..", `${dir.split("/").pop()}-registry`, "identities.json");
    await mkdir(join(registryPath, ".."), { recursive: true });
    await Bun.write(
      registryPath,
      JSON.stringify({ version: 1, identities: [{ name: "test", label: "Test", configDir: dir }] }),
    );
    return { dir, configs: [fakeConfig(join(registryPath, ".."))] };
  }

  test("lists roots and navigates a tree", async () => {
    const { dir, configs } = await makeSeeded();
    const sub = join(dir, "skills");
    await mkdir(sub);
    await writeFile(join(sub, "demo.md"), "# demo");
    const { listRoots, tree } = await import("../../src/server/files.ts");

    const roots = await listRoots(configs);
    const identityRoot = roots.find((r) => r.root === "id:claude:test");
    expect(identityRoot).toBeDefined();
    expect(identityRoot?.exists).toBe(true);

    const top = await tree("id:claude:test", undefined, configs);
    expect(top.entries.map((e) => e.name)).toContain("skills");

    const nested = await tree("id:claude:test", "skills", configs);
    expect(nested.entries[0]).toMatchObject({ name: "demo.md", kind: "file" });
  });

  test("rejects traversal outside the whitelisted root", async () => {
    const { configs } = await makeSeeded();
    const { readTextFile } = await import("../../src/server/files.ts");
    await expect(readTextFile("id:claude:test", "../../etc/passwd", configs)).rejects.toThrow(/escapes/);
  });

  test("rejects a symlink pointing outside the root", async () => {
    const { dir, configs } = await makeSeeded();
    const outside = await makeRoot();
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(join(outside, "secret.txt"), join(dir, "leak.txt"));
    const { readTextFile } = await import("../../src/server/files.ts");
    await expect(readTextFile("id:claude:test", "leak.txt", configs)).rejects.toThrow(/escapes/);
  });

  test("round-trips a text edit and backs up the previous bytes", async () => {
    const { dir, configs } = await makeSeeded();
    await writeFile(join(dir, "AGENTS.md"), "original");
    const { writeTextFile, readTextFile } = await import("../../src/server/files.ts");

    const written = await writeTextFile("id:claude:test", "AGENTS.md", "updated", configs);
    expect(written.ok).toBe(true);
    expect(written.backedUpTo).toMatch(/file-backups\/.+AGENTS\.md$/);

    const reread = await readTextFile("id:claude:test", "AGENTS.md", configs);
    expect(reread.content).toBe("updated");
    expect(reread.binary).toBe(false);
  });

  test("flags binary content instead of returning mojibake", async () => {
    const { dir, configs } = await makeSeeded();
    await writeFile(join(dir, "blob.bin"), new Uint8Array([0x89, 0x50, 0x00, 0x4e]));
    const { readTextFile } = await import("../../src/server/files.ts");
    const result = await readTextFile("id:claude:test", "blob.bin", configs);
    expect(result.binary).toBe(true);
    expect(result.content).toBe("");
  });

  /** Regression for the 2026-09 live junk: `personal.lock/` and
   * `phoenix-court-group.lock/` sat under ~/.claude/identities (claude's own
   * config-lock leftovers) and a consumer that enumerated the root treated
   * them as identities. The identities-root listing is the one place
   * subdirectory names are identity candidates, so it filters through
   * isIdentityDirName; every other listing shows real contents. */
  test("hides lock dirs and non-identity names only at a container's identities root", async () => {
    const home = await makeRoot();
    const identitiesDir = join(home, ".claude", "identities");
    await mkdir(join(identitiesDir, "personal"), { recursive: true });
    await mkdir(join(identitiesDir, "personal.lock"), { recursive: true });
    await mkdir(join(identitiesDir, "Bad Name"), { recursive: true });
    // A marker inside the real identity whose own name would fail the
    // grammar: nested listings must NOT be filtered.
    await mkdir(join(identitiesDir, "personal", "inner.lock"), { recursive: true });
    // Files are never identity candidates; they must pass through untouched.
    await writeFile(join(identitiesDir, "notes.md"), "hi");
    const { tree } = await import("../../src/server/files.ts");

    const rootListing = await tree("claude", "identities", [], home);
    const names = rootListing.entries.map((e) => e.name);
    expect(names).toContain("personal");
    expect(names).toContain("notes.md");
    expect(names).not.toContain("personal.lock");
    expect(names).not.toContain("Bad Name");

    const nested = await tree("claude", "identities/personal", [], home);
    expect(nested.entries.map((e) => e.name)).toContain("inner.lock");
  });
});
