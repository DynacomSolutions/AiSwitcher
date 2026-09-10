import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MARKER = "# AIS privacy guard v1";
const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("hook installation failed");
  }
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function resolvedPath(path: string): string {
  // Resolve existing ancestors too, before creating a missing hooks directory.
  try {
    return exists(path) ? realpathSync(path) : join(resolvedPath(dirname(path)), basename(path));
  } catch {
    throw new Error("hook installation failed");
  }
}

export function hookText(kind: "pre-commit" | "pre-push", previous: string, bun: string): string {
  const command = `${quote(bun)} run scripts/privacy-check.ts --local`;
  const prelude = `#!/bin/sh\n${MARKER}\nset -u\nprevious=${quote(previous)}\n`;
  if (kind === "pre-commit") return `${prelude}
if [ -x "$previous" ]; then
  "$previous" "$@" || exit "$?"
fi
${command} --staged
`;
  return `${prelude}
umask 077
input=$(mktemp) || exit 2
trap 'rm -f "$input"' EXIT
trap 'exit 2' HUP INT TERM
cat > "$input" || exit 2
if [ -x "$previous" ]; then
  "$previous" "$@" < "$input" || exit "$?"
fi
${command} --pre-push "$@" < "$input"
`;
}

export function installHooks(root: string, bun = process.execPath): void {
  const git = (args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error("hook installation failed");
    return result.stdout.toString().trim();
  };
  // Resolve the effective path each time, including worktrees and core.hooksPath.
  const hooks = resolve(root, git(["rev-parse", "--git-path", "hooks"]));
  const common = resolve(root, git(["rev-parse", "--git-common-dir"]));
  const allowed = join(common, "hooks");
  if (!contained(allowed, hooks)
    || !contained(join(resolvedPath(common), "hooks"), resolvedPath(hooks))) {
    throw new Error("hook installation failed");
  }
  mkdirSync(hooks, { recursive: true });
  for (const kind of ["pre-commit", "pre-push"] as const) {
    const target = join(hooks, kind), previous = join(hooks, `${kind}.before-privacy`);
    const content = hookText(kind, previous, bun);
    // Refuse symlinks: moving relative symlinks can change their meaning.
    if (exists(target)) {
      if (!lstatSync(target).isFile()) throw new Error("hook installation failed");
      const existing = readFileSync(target, "utf8");
      if (existing === content) { chmodSync(target, 0o755); continue; }
      // A changed managed hook needs inspection, never a silent overwrite.
      if (existing.includes(MARKER) || exists(previous)) throw new Error("hook installation failed");
      renameSync(target, previous);
    } else if (exists(previous)) throw new Error("hook installation failed");
    writeFileSync(target, content, { mode: 0o755, flag: "wx" });
  }
}

if (import.meta.main) {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error();
    installHooks(result.stdout.toString().trim());
    console.log("Privacy hooks installed; existing hooks preserved and chained.");
  } catch {
    console.error("privacy-hooks: installation failed; inspect local hooks before retrying");
    process.exitCode = 2;
  }
}
