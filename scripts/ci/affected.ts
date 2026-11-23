// Selects the PR jobs and tests that a change set can affect. The repository is
// one bun package plus standalone apps, so the dependency graph is the relative
// import graph of the sources, not workspace package links.
//
// Rules (owner policy):
// - A change runs the tests whose import closure contains it, and the jobs of
//   every area that consumes it.
// - Shared inputs (root config, lockfile, toolchain, workflows, shared test
//   helpers) run everything. A version-only bump of the root package.json is
//   not a shared input: the version string changes no behaviour.
// - Pushes select like pull requests: the diff runs from the event base to the
//   head. The full suite runs only per release (release.yml).
// - Any doubt (unknown path, unreadable or all-zero base, deleted file) fails open.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");

// Mirrors pathIgnorePatterns in bunfig.toml; test/ci/affected.test.ts guards the drift.
export const BUN_TEST_IGNORES = ["mods/", "apps/host/e2e/", "apps/host/src/"];

// Shared inputs: a change to any of these runs everything.
const SHARED_FILES = new Set([
  "package.json", // version-only bumps are exempt, see filterVersionOnlyBump
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  ".bun-version",
  ".gitleaks.toml",
  "scripts/build.ts",
  "scripts/source-hash.ts",
  "scripts/identifier-allowlist.ts",
  "scripts/identifier-tlds.ts",
  "scripts/identifier-scan.ts",
  "scripts/secret-scan.ts",
  "scripts/privacy-check.ts",
  "test/setup-env.ts",
]);
const SHARED_PREFIXES = [".github/workflows/", "scripts/ci/", "test/fixtures/"];

// Known areas: a path outside every known area fails open.
const KNOWN_PREFIXES = [
  "src/", "test/", "scripts/", "image/", "docs/", "mods/", "k8s/", "vendor/", ".github/",
  "apps/host/", "apps/web/", "apps/tui/", "apps/chrome-extension/",
];
const KNOWN_ROOT_FILES = new Set([
  ".bun-version", ".dockerignore", ".gitignore", ".gitleaks.toml", "AGENTS.md", "CLAUDE.md",
  "Dockerfile", "LICENSE", "README.md", "TASKS.md", "bun.lock", "bunfig.toml", "favicon.png",
  "package.json", "tsconfig.json",
]);

// Host app inputs beyond the import graph: the native build reads the trust key
// and the licence, and the build and test scripts live in these directories.
const HOST_PREFIXES = ["apps/host/", "scripts/host/", "test/host/", "image/contract/"];
const HOST_FILES = new Set(["image/release/minisign.pub", "LICENSE"]);
const EXTENSION_PREFIXES = ["apps/chrome-extension/", "src/browser/"];
const WEB_PREFIXES = ["apps/web/"];

// The macOS job runs exactly these tests (execve, session sidecar, shim).
export const MACOS_TESTS = ["test/shim-execve.test.ts", "test/shared/execve.test.ts", "test/shared/session-sidecar.test.ts"];

export function isSharedInput(path: string): boolean {
  return SHARED_FILES.has(path) || SHARED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function knownPath(path: string): boolean {
  return KNOWN_ROOT_FILES.has(path) || KNOWN_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** True when two package.json texts differ only in the version field. Unparseable text is never version-only. */
export function versionOnlyBump(baseText: string, headText: string): boolean {
  try {
    const strip = (text: string) => {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      delete parsed.version;
      return canonicalJson(parsed);
    };
    return strip(baseText) === strip(headText);
  } catch {
    return false;
  }
}

/** Drops a version-only package.json bump from the change set. Missing texts keep the file (fail open). */
export function filterVersionOnlyBump(changed: readonly string[], baseText: string | null, headText: string | null): string[] {
  if (!changed.includes("package.json") || baseText === null || headText === null) return [...changed];
  if (!versionOnlyBump(baseText, headText)) return [...changed];
  return changed.filter((path) => path !== "package.json");
}

const SPECIFIER_RE = /\b(?:from|import|require)\s*\(?["']([^"'\n]+)["']/g;

function resolveSpecifier(fromFile: string, specifier: string, root: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(join(root, fromFile)), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, join(base, "index.ts")];
  if (specifier.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate);
  }
  return null;
}

/** Relative import closure for each entry, with one shared scan cache. Entries are included in their own closure. */
export function closureMap(entries: readonly string[], root: string = ROOT): Map<string, Set<string>> {
  const dependencyCache = new Map<string, string[]>();
  const dependencies = (file: string): string[] => {
    const cached = dependencyCache.get(file);
    if (cached) return cached;
    let found: string[] = [];
    try {
      const text = readFileSync(join(root, file), "utf8");
      found = [...text.matchAll(SPECIFIER_RE)]
        .map((match) => resolveSpecifier(file, match[1]!, root))
        .filter((path): path is string => path !== null);
    } catch {
      found = [];
    }
    dependencyCache.set(file, found);
    return found;
  };
  const result = new Map<string, Set<string>>();
  for (const entry of entries) {
    const closure = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (closure.has(file)) continue;
      closure.add(file);
      queue.push(...dependencies(file));
    }
    result.set(entry, closure);
  }
  return result;
}

/** Every bun test file of the root suite, sorted. Matches bun test discovery minus the bunfig ignores. */
export function listTestFiles(root: string = ROOT): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, timeout: 30_000 });
  if (listed.exitCode !== 0) throw new Error("git ls-files failed; cannot enumerate the test suite");
  return listed.stdout.toString().split("\0")
    .filter((path) => /\.test\.(ts|tsx|js|jsx)$/.test(path))
    .filter((path) => !BUN_TEST_IGNORES.some((prefix) => path.startsWith(prefix)))
    .sort();
}

export type Selection = {
  /** Shared input or unknown consumer: run every job and the full suite. */
  full: boolean;
  host: boolean;
  macos: boolean;
  extension: boolean;
  web: boolean;
  /** Selected root test files; empty means none. full=true means the whole suite. */
  tests: string[];
};

/** Selects jobs and tests for a change set. hasDeletions forces a full run: a removed file may still be referenced. */
export function selectChanges(changed: readonly string[], options: { root?: string; hasDeletions?: boolean } = {}): Selection {
  const root = options.root ?? ROOT;
  const skip: Selection = { full: false, host: false, macos: false, extension: false, web: false, tests: [] };
  const testFiles = listTestFiles(root);
  const full = (): Selection => ({ full: true, host: true, macos: true, extension: true, web: true, tests: testFiles });
  if (options.hasDeletions) return full();
  if (changed.length === 0) return skip;
  if (changed.some((path) => !knownPath(path) || isSharedInput(path))) return full();

  const changedSet = new Set(changed);
  const intersects = (paths: Iterable<string>) => {
    for (const path of paths) if (changedSet.has(path)) return true;
    return false;
  };
  const prefixHit = (prefixes: readonly string[]) => changed.some((path) => prefixes.some((prefix) => path.startsWith(prefix)));

  const hostEntries = ["src/host/adapter.ts", ...testFiles.filter((path) => path.startsWith("test/host/"))];
  const hostGraph = closureMap(hostEntries, root);
  const hostInputs = new Set<string>([...HOST_FILES]);
  for (const closure of hostGraph.values()) for (const path of closure) hostInputs.add(path);
  const host = prefixHit(HOST_PREFIXES) || intersects(hostInputs);

  const extension = prefixHit(EXTENSION_PREFIXES);
  const web = prefixHit(WEB_PREFIXES);

  const closures = closureMap(testFiles, root);
  const tests = testFiles.filter((file) => intersects(closures.get(file)!));
  const macos = MACOS_TESTS.some((file) => tests.includes(file));

  // Fail open: a changed source or script that no test imports and no area
  // consumes may still run through a subprocess, so run everything.
  const covered = new Set<string>([...hostInputs]);
  for (const closure of closures.values()) for (const path of closure) covered.add(path);
  const orphan = changed.some((path) => (path.startsWith("src/") || path.startsWith("scripts/"))
    && !covered.has(path)
    && ![...EXTENSION_PREFIXES, ...WEB_PREFIXES, ...HOST_PREFIXES].some((prefix) => path.startsWith(prefix)));
  if (orphan) return full();

  return { full: false, host, macos, extension, web, tests };
}

export type DiffChanges = { paths: string[]; hasDeletions: boolean };

/** Changed paths between two commits, with rename sources included. Null when the diff cannot be read. */
export function diffChanges(base: string, head: string, root: string = ROOT): DiffChanges | null {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) return null;
  // A new branch push reports an all-zero base: there is no diff to read.
  if (/^0{40}$/.test(base)) return null;
  const diff = Bun.spawnSync(["git", "diff", "--name-status", "-z", `${base}...${head}`], { cwd: root, timeout: 30_000 });
  if (diff.exitCode !== 0) return null;
  const fields = diff.stdout.toString().split("\0").filter(Boolean);
  const paths: string[] = [];
  let hasDeletions = false;
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i]!;
    if (status.startsWith("D")) hasDeletions = true;
    if (status.startsWith("R") || status.startsWith("C")) {
      paths.push(fields[i + 1]!, fields[i + 2]!);
      i += 2;
    } else {
      paths.push(fields[i + 1]!);
      i += 1;
    }
  }
  return { paths, hasDeletions };
}

/** Reads a file at a commit; null when the commit or file cannot be read. */
export function showFile(sha: string, path: string, root: string = ROOT): string | null {
  const shown = Bun.spawnSync(["git", "show", `${sha}:${path}`], { cwd: root, timeout: 10_000 });
  return shown.exitCode === 0 ? shown.stdout.toString() : null;
}

function githubDiff(): { changed: string[]; hasDeletions: boolean } {
  const base = process.env.BASE_SHA ?? "";
  const head = process.env.HEAD_SHA ?? "";
  const diff = diffChanges(base, head);
  if (!diff) return { changed: [], hasDeletions: true }; // fail open
  const changed = filterVersionOnlyBump(diff.paths, showFile(base, "package.json"), showFile(head, "package.json"));
  return { changed, hasDeletions: diff.hasDeletions };
}

function writeOutput(name: string, value: string): void {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.includes("--shard")) {
    const shard = Number(args[args.indexOf("--shard") + 1]);
    const shards = Number(args[args.indexOf("--shards") + 1]);
    if (!Number.isInteger(shard) || !Number.isInteger(shards) || shards < 1 || shard < 1 || shard > shards) {
      throw new Error("--shard N --shards M needs integers with 1 <= N <= M.");
    }
    const files = listTestFiles().filter((_, index) => index % shards === shard - 1);
    console.log(files.join(" "));
  } else if (args.includes("--version-only")) {
    const base = process.env.BASE_SHA ?? "";
    const head = process.env.HEAD_SHA ?? "";
    const baseText = showFile(base, "package.json");
    const headText = showFile(head, "package.json");
    console.log(String(baseText !== null && headText !== null && versionOnlyBump(baseText, headText)));
  } else if (args.includes("--github")) {
    // Pushes and pull requests read the diff from BASE_SHA to HEAD_SHA. A missing,
    // all-zero (new branch) or unreadable base fails open inside githubDiff.
    const { changed, hasDeletions } = githubDiff();
    const selection = selectChanges(changed, { hasDeletions });
    writeOutput("macos", String(selection.macos));
    writeOutput("extension", String(selection.extension));
    writeOutput("web", String(selection.web));
    writeOutput("tests", selection.full ? "all" : selection.tests.length === 0 ? "none" : selection.tests.join(" "));
    console.log(`full=${selection.full} host=${selection.host} macos=${selection.macos} extension=${selection.extension} web=${selection.web} tests=${selection.full ? "all" : selection.tests.length}`);
  } else {
    const selection = selectChanges(args);
    console.log(JSON.stringify(selection, null, 2));
  }
}
