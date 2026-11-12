import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInBaseCheckout } from "../../src/shared/memory-land.ts";
import { makeSharedHookScriptsPortable } from "../../src/sync/portable-config.ts";
import { mergeIncomingProfileTree } from "../../src/sync/tree-merge.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Layout {
  tmp: string;
  home: string;
  hooks: string;
}

/** A home whose `.ais/hooks` is a symlink into a fake base checkout, or a plain directory. */
async function layout(kind: "base" | "plain"): Promise<Layout> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ais-base-hooks-")));
  roots.push(tmp);
  const home = join(tmp, "home");
  await mkdir(join(home, ".ais"), { recursive: true });
  if (kind === "base") {
    const hooks = join(tmp, "root", ".worktrees", "acme", ".base", "dotfiles", "hooks");
    await mkdir(hooks, { recursive: true });
    await symlink(hooks, join(home, ".ais", "hooks"));
    return { tmp, home, hooks };
  }
  const hooks = join(home, ".ais", "hooks");
  await mkdir(hooks, { recursive: true });
  return { tmp, home, hooks };
}

async function incomingTree(tmp: string): Promise<string> {
  const incoming = join(tmp, "incoming");
  await mkdir(join(incoming, ".ais", "hooks"), { recursive: true });
  await writeFile(join(incoming, ".ais", "hooks", "new-hook.sh"), "#!/bin/sh\necho new\n");
  await writeFile(join(incoming, ".ais", "hooks", "existing.sh"), "#!/bin/sh\necho changed\n");
  await writeFile(join(incoming, ".ais", "other.txt"), "other\n");
  const future = new Date(Date.now() + 60_000);
  await utimes(join(incoming, ".ais", "hooks", "existing.sh"), future, future);
  return incoming;
}

describe("isInBaseCheckout", () => {
  test("matches the checkout root and a subdirectory reached through a symlink", async () => {
    const { tmp, home, hooks } = await layout("base");
    expect(await isInBaseCheckout(join(tmp, "root", ".worktrees", "acme", ".base", "dotfiles"))).toBe(true);
    expect(await isInBaseCheckout(join(home, ".ais", "hooks"))).toBe(true);
    expect(await isInBaseCheckout(hooks)).toBe(true);
  });

  test("rejects a task worktree and a missing path", async () => {
    const { tmp } = await layout("plain");
    const task = join(tmp, "root", ".worktrees", "acme", "task1", "dotfiles", "hooks");
    await mkdir(task, { recursive: true });
    expect(await isInBaseCheckout(task)).toBe(false);
    expect(await isInBaseCheckout(join(tmp, "missing"))).toBe(false);
  });
});

describe("shared hooks in a base checkout", () => {
  test("makeSharedHookScriptsPortable leaves base scripts untouched and still rewrites a plain directory", async () => {
    for (const kind of ["base", "plain"] as const) {
      const { home, hooks } = await layout(kind);
      const script = join(hooks, "check.sh");
      const original = `#!/bin/sh\nexec ${home}/.ais/bin/check "$@"\n`;
      await writeFile(script, original);
      const changed = await makeSharedHookScriptsPortable(home);
      if (kind === "base") {
        expect(changed).toBe(0);
        expect(await readFile(script, "utf8")).toBe(original);
      } else {
        expect(changed).toBe(1);
        expect(await readFile(script, "utf8")).not.toBe(original);
      }
    }
  });

  test("the profile merge skips incoming hooks in a base checkout but applies other files", async () => {
    const { tmp, home, hooks } = await layout("base");
    const existing = join(hooks, "existing.sh");
    await writeFile(existing, "#!/bin/sh\necho local\n");
    const past = new Date(Date.now() - 600_000);
    await utimes(existing, past, past);
    const before = (await stat(existing)).mtimeMs;
    const incoming = await incomingTree(tmp);

    const result = await mergeIncomingProfileTree(incoming, { kind: "all" }, { home });

    expect(await Bun.file(join(hooks, "new-hook.sh")).exists()).toBe(false);
    expect(await readFile(existing, "utf8")).toBe("#!/bin/sh\necho local\n");
    expect((await stat(existing)).mtimeMs).toBe(before);
    expect(await readFile(join(home, ".ais", "other.txt"), "utf8")).toBe("other\n");
    expect([...(result.skippedPaths ?? [])].sort()).toEqual([".ais/hooks/existing.sh", ".ais/hooks/new-hook.sh"]);
    expect(result.preservedConflicts).toBe(0);
    expect(result.deniedPaths).toEqual([]);
  });

  test("the same incoming tree still applies hooks to a plain directory", async () => {
    const { tmp, home, hooks } = await layout("plain");
    await writeFile(join(hooks, "existing.sh"), "#!/bin/sh\necho local\n");
    const past = new Date(Date.now() - 600_000);
    await utimes(join(hooks, "existing.sh"), past, past);
    const incoming = await incomingTree(tmp);

    const result = await mergeIncomingProfileTree(incoming, { kind: "all" }, { home });

    expect(await readFile(join(hooks, "new-hook.sh"), "utf8")).toBe("#!/bin/sh\necho new\n");
    expect(await readFile(join(hooks, "existing.sh"), "utf8")).toBe("#!/bin/sh\necho changed\n");
    expect(result.skippedPaths).toEqual([]);
  });
});
