import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMemoryCommand } from "../src/cli/memory.ts";
import { addCommitMessage, detectGitBase, parseBaseToplevel } from "../src/shared/memory-land.ts";
import { INITIAL_MEMORY } from "../src/shared/global-memory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

interface Fixture {
  home: string;
  base: string;
  memory: string;
  argsLog: string;
  env: Record<string, string | undefined>;
}

/** HOME/.ais/memory is a symlink into a git repo laid out like a git-base base. */
async function fixture(opts: { fail?: boolean; reply?: string; seed?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ais-land-test-"));
  roots.push(root);
  const home = join(root, "home");
  const base = join(root, "repos", ".worktrees", "acme", ".base", "widgets");
  await mkdir(join(base, "memory"), { recursive: true });
  await mkdir(join(home, ".ais"), { recursive: true });
  await git(base, "init", "-q");
  if (opts.seed !== false) await writeFile(join(base, "memory", "GLOBAL.md"), INITIAL_MEMORY);
  await symlink(join(base, "memory"), join(home, ".ais", "memory"));
  const argsLog = join(root, "args.log");
  const bin = join(root, "git-base");
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > "${argsLog}"
if [ -n "$FAKE_FAIL" ]; then echo "boom: push rejected" >&2; exit 3; fi
# simulate the fast-forward: copy the --file tempfile over the target
for a in "$@"; do case "$a" in *=*) rel="\${a%%=*}"; tmp="\${a#*=}"; cat "$tmp" > "${base}/$rel";; esac; done
echo "noise"
echo "\${FAKE_REPLY:-${"a".repeat(40)}}"
`,
  );
  await chmod(bin, 0o755);
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, AIS_GIT_BASE_BIN: bin };
  if (opts.fail) env.FAKE_FAIL = "1";
  if (opts.reply) env.FAKE_REPLY = opts.reply;
  return { home, base, memory: join(base, "memory", "GLOBAL.md"), argsLog, env };
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("git-base detection", () => {
  test("matches only <x>/.worktrees/<org>/.base/<repo>", () => {
    expect(parseBaseToplevel("/r/.worktrees/acme/.base/widgets")).toEqual({ org: "acme", repo: "widgets" });
    expect(parseBaseToplevel("/r/.worktrees/acme/.base/widgets/")).toEqual({ org: "acme", repo: "widgets" });
    expect(parseBaseToplevel("/r/.worktrees/acme/task/widgets")).toBeNull();
    expect(parseBaseToplevel("/r/acme/.base/widgets")).toBeNull();
    expect(parseBaseToplevel("/r/.worktrees/acme/.base/widgets/sub")).toBeNull();
    expect(parseBaseToplevel("/r/.worktrees/.base/widgets")).toBeNull();
    expect(parseBaseToplevel("/r/x.worktrees/acme/.base/widgets")).toBeNull();
  });

  test("detects through the symlink and requires an executable git-base", async () => {
    const f = await fixture();
    const memory = join(f.home, ".ais", "memory", "GLOBAL.md");
    const t = await detectGitBase(memory, f.env);
    expect(t?.org).toBe("acme");
    expect(t?.repo).toBe("widgets");
    expect(t?.relpath).toBe("memory/GLOBAL.md");
    expect(await detectGitBase(memory, { PATH: "/nonexistent" })).toBeNull();
    expect(await detectGitBase(memory, { ...f.env, AIS_MEMORY_LAND: "0" })).toBeNull();
  });

  test("a plain directory is not a base", async () => {
    const f = await fixture();
    const plain = await mkdtemp(join(tmpdir(), "ais-plain-"));
    roots.push(plain);
    expect(await detectGitBase(join(plain, "GLOBAL.md"), f.env)).toBeNull();
  });
});

describe("ais memory landing", () => {
  test("add lands via git-base with the right args and prints the sha", async () => {
    const f = await fixture();
    const out = await capture(() => runMemoryCommand(["add", "## Fact one\n\nbody"], {}, f.env, f.home));
    const args = (await readFile(f.argsLog, "utf8")).trim().split("\n");
    expect(args.slice(0, 5)).toEqual(["land", "acme/widgets", "-m", "docs(memory): Fact one", "--file"]);
    expect(args[5]).toStartWith("memory/GLOBAL.md=");
    expect(await readFile(f.memory, "utf8")).toBe(`${INITIAL_MEMORY}\n## Fact one\n\nbody\n`);
    expect(out.split("\n").pop()).toBe("a".repeat(40));
    expect(args[5]!.split("=")[1]).not.toBe("");
  });

  test("unchanged is passed through", async () => {
    const f = await fixture({ reply: "unchanged" });
    const out = await capture(() => runMemoryCommand(["add", "x"], {}, f.env, f.home));
    expect(out.split("\n").pop()).toBe("unchanged");
  });

  test("init lands the initial content when the file is missing", async () => {
    const f = await fixture({ seed: false });
    await capture(() => runMemoryCommand(["init"], {}, f.env, f.home));
    const args = (await readFile(f.argsLog, "utf8")).split("\n");
    expect(args[3]).toBe("docs(memory): initialise global memory");
    expect(await readFile(f.memory, "utf8")).toBe(INITIAL_MEMORY);
  });

  test("failure propagates stderr and never writes in place", async () => {
    const f = await fixture({ fail: true });
    await expect(runMemoryCommand(["add", "x"], {}, f.env, f.home)).rejects.toThrow(/push rejected/);
    expect(await readFile(f.memory, "utf8")).toBe(INITIAL_MEMORY);
  });

  test("AIS_MEMORY_LAND=0 forces in-place", async () => {
    const f = await fixture();
    await capture(() => runMemoryCommand(["add", "inplace"], {}, { ...f.env, AIS_MEMORY_LAND: "0" }, f.home));
    expect(await readFile(f.memory, "utf8")).toBe(`${INITIAL_MEMORY}\ninplace\n`);
    expect(await Bun.file(f.argsLog).exists()).toBe(false);
  });

  test("no git-base on PATH keeps in-place behaviour", async () => {
    const f = await fixture();
    await capture(() => runMemoryCommand(["add", "inplace"], {}, { PATH: "/nonexistent" }, f.home));
    expect(await readFile(f.memory, "utf8")).toBe(`${INITIAL_MEMORY}\ninplace\n`);
  });

  test("commit message summary is truncated", () => {
    expect(addCommitMessage("# Title here\nmore")).toBe("docs(memory): Title here");
    expect(addCommitMessage("x".repeat(100))).toBe(`docs(memory): ${"x".repeat(60)}`);
  });
});
