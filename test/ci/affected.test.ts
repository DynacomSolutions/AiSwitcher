import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUN_TEST_IGNORES, MACOS_TESTS, ROOT, closureMap, diffChanges, filterVersionOnlyBump,
  listTestFiles, selectChanges, showFile, versionOnlyBump,
} from "../../scripts/ci/affected.ts";

const summary = (paths: string[]) => {
  const selection = selectChanges(paths);
  return {
    full: selection.full, host: selection.host, macos: selection.macos,
    extension: selection.extension, web: selection.web, tests: selection.tests,
  };
};

describe("version-only package.json bumps", () => {
  const base = JSON.stringify({ name: "ai-profile-switcher", version: "0.5.75", scripts: { test: "bun test" } });
  test("a version bump alone is not a shared input", () => {
    const head = JSON.stringify({ name: "ai-profile-switcher", version: "0.5.76", scripts: { test: "bun test" } });
    expect(versionOnlyBump(base, head)).toBe(true);
    expect(filterVersionOnlyBump(["package.json", "src/gateway/serve.ts"], base, head)).toEqual(["src/gateway/serve.ts"]);
  });
  test("key order does not matter", () => {
    const head = JSON.stringify({ scripts: { test: "bun test" }, version: "0.5.76", name: "ai-profile-switcher" });
    expect(versionOnlyBump(base, head)).toBe(true);
  });
  test("dependency, script and toolchain changes stay shared inputs", () => {
    for (const head of [
      JSON.stringify({ name: "ai-profile-switcher", version: "0.5.75", scripts: { test: "bun test --bail" } }),
      JSON.stringify({ name: "ai-profile-switcher", version: "0.5.75", scripts: { test: "bun test" }, dependencies: { hono: "^4.13.6" } }),
      "not json",
    ]) {
      expect(versionOnlyBump(base, head)).toBe(false);
      expect(filterVersionOnlyBump(["package.json"], base, head)).toEqual(["package.json"]);
    }
  });
  test("missing texts fail open", () => {
    expect(filterVersionOnlyBump(["package.json"], null, base)).toEqual(["package.json"]);
    expect(filterVersionOnlyBump(["src/gateway/serve.ts"], null, null)).toEqual(["src/gateway/serve.ts"]);
  });
});

describe("import closure", () => {
  test("follows relative, type, dynamic and JSON imports but not packages", () => {
    const closures = closureMap(["test/web/format.test.ts"], ROOT);
    const closure = closures.get("test/web/format.test.ts")!;
    expect(closure.has("apps/web/src/lib/format.ts")).toBe(true);
    expect(closure.has("test/web/format.test.ts")).toBe(true);
    for (const path of closure) expect(path.startsWith("node_modules/")).toBe(false);
  });
  test("the adapter sidecar graph reaches the gateway-managed module", () => {
    const closure = closureMap(["src/host/adapter.ts"], ROOT).get("src/host/adapter.ts")!;
    expect(closure.has("src/identities/gateway-managed.ts")).toBe(true);
    expect(closure.has("src/live/path-classes.json")).toBe(true);
  });
});

describe("test enumeration", () => {
  test("matches bun test discovery minus the bunfig ignores", () => {
    const files = listTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(300);
    expect(files).toEqual([...files].sort());
    expect(files.some((path) => path.startsWith("apps/chrome-extension/test/"))).toBe(true);
    for (const prefix of BUN_TEST_IGNORES) expect(files.some((path) => path.startsWith(prefix))).toBe(false);
  });
  test("the ignore list stays in step with bunfig.toml", () => {
    const bunfig = readFileSync(join(ROOT, "bunfig.toml"), "utf8");
    const match = bunfig.match(/pathIgnorePatterns\s*=\s*\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const declared = [...match![1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!.replace(/\*\*$/, ""));
    expect(declared).toEqual(BUN_TEST_IGNORES);
  });
});

describe("change selection", () => {
  test("a gateway-only change skips every native and app job", () => {
    const selection = summary(["src/gateway/serve.ts"]);
    expect(selection.full).toBe(false);
    expect(selection.host).toBe(false);
    expect(selection.macos).toBe(false);
    expect(selection.extension).toBe(false);
    expect(selection.web).toBe(false);
    expect(selection.tests).toContain("test/gateway/serve.test.ts");
    expect(selection.tests.length).toBeGreaterThan(0);
    expect(selection.tests.length).toBeLessThan(listTestFiles(ROOT).length);
  });
  test("the trigger PR diff selects its dependents, not the untouched apps", () => {
    // PR #621 without its version-only package.json bump.
    const selection = summary([
      "src/cli/identities/route-all.ts", "src/identities/gateway-managed.ts",
      "test/cli/identities/route-all.test.ts", "test/gateway/credentials.test.ts",
      "test/identities/gateway-managed.test.ts", "test/sync/gateway-guard.test.ts",
    ]);
    expect(selection.full).toBe(false);
    expect(selection.extension).toBe(false);
    expect(selection.web).toBe(false);
    // gateway-managed.ts sits in the adapter sidecar graph, so host checks run.
    expect(selection.host).toBe(true);
    expect(selection.tests).toContain("test/gateway/credentials.test.ts");
    expect(selection.tests).toContain("test/host/adapter.test.ts");
    expect(selection.tests.length).toBeLessThan(listTestFiles(ROOT).length);
  });
  test("a web-only change runs the web job and the web logic tests", () => {
    const ui = summary(["apps/web/src/App.tsx"]);
    expect(ui.web).toBe(true);
    expect(ui.host).toBe(false);
    expect(ui.tests).toEqual([]);
    const lib = summary(["apps/web/src/lib/format.ts"]);
    expect(lib.web).toBe(true);
    expect(lib.tests).toContain("test/web/format.test.ts");
  });
  test("a host-only change runs the host jobs and no root tests", () => {
    const selection = summary(["apps/host/src/App.tsx"]);
    expect(selection.host).toBe(true);
    expect(selection.full).toBe(false);
    expect(selection.web).toBe(false);
    expect(selection.tests).toEqual([]);
  });
  test("a native build input runs the host jobs", () => {
    expect(summary(["src/live/path-classes.json"]).host).toBe(true);
    expect(summary(["image/release/minisign.pub"]).host).toBe(true);
  });
  test("an extension input runs the extension job and its tests", () => {
    const selection = summary(["src/browser/protocol.ts"]);
    expect(selection.extension).toBe(true);
    expect(selection.host).toBe(false);
    expect(selection.tests.some((path) => path.startsWith("apps/chrome-extension/test/"))).toBe(true);
  });
  test("the macOS tests run when their sources change", () => {
    expect(summary(["src/shared/execve.ts"]).macos).toBe(true);
    expect(summary(["src/shared/session-sidecar.ts"]).macos).toBe(true);
    // The shim entrypoints run through subprocesses: no static importer, fail open.
    expect(summary(["src/claude.ts"]).full).toBe(true);
    for (const file of MACOS_TESTS) expect(summary([file]).macos).toBe(true);
  });
  test("shared inputs run everything", () => {
    for (const path of [
      "package.json", "bun.lock", "bunfig.toml", "tsconfig.json", ".bun-version",
      ".github/workflows/ci.yml", "scripts/build.ts", "test/setup-env.ts",
      "test/fixtures/pool-slow-claude.ts", "scripts/ci/apt-install.sh",
    ]) {
      const selection = summary([path]);
      expect(selection.full).toBe(true);
      expect(selection.tests.length).toBe(listTestFiles(ROOT).length);
    }
  });
  test("docs-only changes skip every test and job", () => {
    const selection = summary(["docs/agents/history.md", "README.md"]);
    expect(selection.full).toBe(false);
    expect(selection.host).toBe(false);
    expect(selection.macos).toBe(false);
    expect(selection.extension).toBe(false);
    expect(selection.web).toBe(false);
    expect(selection.tests).toEqual([]);
  });
  test("unknown paths, deletions and orphan sources fail open", () => {
    expect(summary(["unknown/path.ts"]).full).toBe(true);
    expect(summary(["apps/other/unknown.txt"]).full).toBe(true);
    expect(selectChanges(["src/gateway/serve.ts"], { hasDeletions: true }).full).toBe(true);
    expect(summary(["src/live/dispatch.ts"]).full).toBe(true);
    expect(selectChanges([]).tests).toEqual([]);
  });
});

describe("diff parsing", () => {
  test("renames keep both paths and deletions force a full run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-affected-"));
    try {
      const git = (args: string[]) => {
        const run = Bun.spawnSync(["git", ...args], { cwd: dir });
        if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
        return run.stdout.toString().trim();
      };
      git(["init", "-q"]);
      git(["config", "user.email", "ci@example.invalid"]);
      git(["config", "user.name", "CI test"]);
      writeFileSync(join(dir, "keep.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "gone.ts"), "export const b = 2;\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]);
      git(["mv", "keep.ts", "moved.ts"]);
      rmSync(join(dir, "gone.ts"));
      writeFileSync(join(dir, "new.ts"), "export const c = 3;\n");
      git(["add", "."]);
      git(["commit", "-qm", "head"]);
      const head = git(["rev-parse", "HEAD"]);
      const diff = diffChanges(base, head, dir)!;
      expect(diff.hasDeletions).toBe(true);
      expect(diff.paths.sort()).toEqual(["gone.ts", "keep.ts", "moved.ts", "new.ts"]);
      expect(diffChanges("short", head, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shard split", () => {
  test("four shards cover the suite exactly once", () => {
    const shards = [1, 2, 3, 4].map((shard) => {
      const run = Bun.spawnSync(["bun", "scripts/ci/affected.ts", "--shard", String(shard), "--shards", "4"], { cwd: ROOT });
      expect(run.exitCode).toBe(0);
      return run.stdout.toString().trim().split(" ").filter(Boolean);
    });
    const union = shards.flat();
    expect(union.sort()).toEqual(listTestFiles(ROOT));
    expect(new Set(union).size).toBe(union.length);
    for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  });
});

describe("github output mode", () => {
  test("push events run everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-affected-out-"));
    try {
      const output = join(dir, "output");
      const run = Bun.spawnSync(["bun", "scripts/ci/affected.ts", "--github"], {
        cwd: ROOT,
        env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: output },
      });
      expect(run.exitCode).toBe(0);
      const text = readFileSync(output, "utf8");
      expect(text).toContain("macos=true");
      expect(text).toContain("extension=true");
      expect(text).toContain("web=true");
      expect(text).toContain("tests=all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("pull request outputs agree with the engine on the same diff", () => {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
    const parent = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "HEAD~1^{commit}"], { cwd: ROOT });
    // A shallow checkout (CI depth 1) has no parent commit, so there is no diff to compare.
    if (parent.exitCode !== 0) return;
    const base = parent.stdout.toString().trim();
    const dir = mkdtempSync(join(tmpdir(), "ci-affected-pr-"));
    try {
      const output = join(dir, "output");
      const run = Bun.spawnSync(["bun", "scripts/ci/affected.ts", "--github"], {
        cwd: ROOT,
        env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output },
      });
      expect(run.exitCode).toBe(0);
      const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }));
      const diff = diffChanges(base, head, ROOT)!;
      const changed = filterVersionOnlyBump(diff.paths, showFile(base, "package.json", ROOT), showFile(head, "package.json", ROOT));
      const expected = selectChanges(changed, { hasDeletions: diff.hasDeletions });
      expect(outputs.macos).toBe(String(expected.macos));
      expect(outputs.extension).toBe(String(expected.extension));
      expect(outputs.web).toBe(String(expected.web));
      expect(outputs.tests).toBe(expected.full ? "all" : expected.tests.length === 0 ? "none" : expected.tests.join(" "));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
