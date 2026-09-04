import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { BinaryResolutionError } from "../identities/errors.ts";
import { aisNpmDir } from "./ais-home.ts";

const SHIM_DIR = process.env.AI_PROFILE_SWITCHER_SHIM_DIR ?? join(homedir(), ".local", "bin");

// `ais upgrade` installs the real vendor CLIs here, deliberately outside
// SHIM_DIR (which contains this project's wrappers). Looking here before
// inherited PATH makes a managed upgrade take effect immediately in the
// current shell and avoids repeatedly falling back to an older system-wide
// binary such as /usr/bin/codex.
export const MANAGED_REAL_BIN_DIR = process.env.AI_PROFILE_SWITCHER_REAL_BIN_DIR ?? join(aisNpmDir(), "bin");

// The npm prefix used to default to ~/.local/share/ais/npm — see
// migrate-ais-home.ts. That migration deliberately DEFERS (rather than
// migrates) while anything has an open file handle underneath it, which in
// practice means "a currently-running claude/codex/crush process" — i.e.
// exactly the moment resolveRealBinary() itself is most likely to be
// called. Without this fallback, the very first invocation after deploying
// this change (before the deferred migration completes) would find NOTHING
// at the new location and silently fall through to whatever unmanaged
// system binary happens to be on PATH (confirmed live: nvm's `claude`,
// bun's global `codex`, Homebrew's `crush` — none of them the actually-
// configured managed install) instead of erroring loudly or finding the
// real one. Checked unconditionally (a nonexistent legacy dir is a no-op
// for Bun.which) except when AI_PROFILE_SWITCHER_REAL_BIN_DIR is an
// explicit override, matching migrateLegacyAisHome()'s own skip rule.
const LEGACY_MANAGED_REAL_BIN_DIR = process.env.AI_PROFILE_SWITCHER_REAL_BIN_DIR
  ? undefined
  : join(homedir(), ".local", "share", "ais", "npm", "bin");

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** npm-published CLIs whose bin entry is a `#!/usr/bin/env node` launcher
 * around a platform-native binary (codex, since @openai/codex moved to the
 * optional-platform-package layout) can't be exec'd directly by this
 * project: every spawn site here runs the resolved path raw, and the
 * console daemon image deliberately ships no Node at all (bun only — see
 * Dockerfile). Confirmed live 2026-09-04: the managed `ais upgrade` install
 * switched to this launcher layout and every codex limits/doctor/resume
 * call inside the pod began dying with "env: 'node': No such file or
 * directory" while the host (which has Node) kept working.
 *
 * nativeBinaryForNodeLauncher re-implements the exact resolution
 * @openai/codex/bin/codex.js performs: its platform-package table plus the
 * vendor/<triple>/bin/codex layout, keyed off THIS process's platform/arch
 * (the same thing the launcher itself uses). Returns null for anything that
 * isn't that launcher shape, so callers fall back to the candidate as-is —
 * a host with Node keeps exec'ing the launcher exactly like before. */
export function nativeBinaryForNodeLauncher(realCandidate: string): string | null {
  const LAUNCHER_SUFFIX = "/bin/codex.js";
  if (!realCandidate.endsWith(LAUNCHER_SUFFIX)) return null;
  const pkgRoot = realCandidate.slice(0, -LAUNCHER_SUFFIX.length);

  const target = process.platform === "linux" || process.platform === "android"
    ? process.arch === "x64"
      ? { platformPackage: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" }
      : process.arch === "arm64"
        ? { platformPackage: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" }
        : null
    : process.platform === "darwin"
      ? process.arch === "x64"
        ? { platformPackage: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" }
        : process.arch === "arm64"
          ? { platformPackage: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" }
          : null
      : null;
  if (!target) return null;

  // The launcher checks <platformPackage>/vendor/<triple>/bin/codex, falling
  // back to <codexPkg>/vendor/<triple>/bin/codex when the platform package
  // didn't install (bundled installs). Mirror both, same order.
  const candidates = [
    join(pkgRoot, "node_modules", target.platformPackage, "vendor", target.triple, "bin", "codex"),
    join(pkgRoot, "vendor", target.triple, "bin", "codex"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Locate the REAL claude/codex/grok/kimi/crush/open binary, robust to our own
 * shim shadowing it on PATH. AIS-managed vendor binaries are preferred first
 * (current ~/.ais/npm/bin location, then the legacy ~/.local/share/ais/npm/bin
 * location in case migrateLegacyAisHome() hasn't relocated it yet); the
 * dedicated Grok/Kimi installer directories are next; inherited PATH
 * (with SHIM_DIR removed by realpath) is the final compatibility fallback.
 *
 * This doesn't rely on introspecting our own on-disk path (unreliable inside
 * `bun build --compile` binaries — argv[0] is always "bun", import.meta paths
 * are virtual). The self-recursion guard still compares the final candidate's
 * realpath with the installed shim as defence in depth.
 *
 * Note for grok specifically: its own installer prepends `~/.grok/bin`
 * (where the real binary lives) to PATH ahead of `~/.local/bin` — see
 * AGENTS.md's "Adding a third wrapped tool later" section for why this means
 * installing our shim alone is NOT sufficient for it to actually intercept
 * `grok` invocations, unlike claude/codex.
 */
export function resolveRealBinary(name: "claude" | "codex" | "grok" | "kimi" | "crush" | "pi" | "opencode" | "open"): string {
  const shimDirReal = safeRealpath(SHIM_DIR) ?? SHIM_DIR;
  const rawPath = process.env.PATH ?? "";

  const filteredPath = rawPath
    .split(":")
    .filter(Boolean)
    .filter((dir) => (safeRealpath(dir) ?? dir) !== shimDirReal)
    .join(delimiter);

  const preferredDirs = [
    MANAGED_REAL_BIN_DIR,
    ...(LEGACY_MANAGED_REAL_BIN_DIR ? [LEGACY_MANAGED_REAL_BIN_DIR] : []),
    ...(name === "grok" ? [join(homedir(), ".grok", "bin")] : []),
    ...(name === "kimi" ? [join(homedir(), ".kimi-code", "bin")] : []),
  ];

  const candidate =
    Bun.which(name, { PATH: preferredDirs.join(delimiter) }) ?? Bun.which(name, { PATH: filteredPath });

  if (!candidate) {
    const hint =
      name === "codex"
        ? `Run 'ais upgrade' to install the managed @openai/codex instance, or check the active Node/npm installation.`
        : name === "open"
          ? `'/usr/bin/open' ships with macOS — this should never happen outside of a broken PATH.`
          : name === "grok"
            ? `Is the Grok CLI installed? Check '~/.grok/bin/grok' exists and that its installer's PATH export is present in your shell rc.`
          : name === "kimi"
            ? `Run 'ais upgrade' to install the managed Kimi Code instance, or check '~/.kimi-code/bin/kimi'.`
            : name === "crush"
              ? `Run 'ais upgrade' to install the managed @charmland/crush instance.`
              : name === "pi"
                ? `Run 'ais upgrade' to install the managed @earendil-works/pi-coding-agent instance.`
                : name === "opencode"
                  ? `Run 'ais upgrade' to install the managed opencode-ai instance.`
                : `Run 'ais upgrade' to install the managed Claude Code instance.`;
    throw new BinaryResolutionError(
      `Could not locate the real '${name}' binary on PATH (after excluding our own shim dir ${SHIM_DIR}).\n${hint}`,
    );
  }

  // Defense in depth: refuse to exec anything that IS (by realpath identity)
  // our own installed shim, even if the directory-level filter above somehow
  // missed a duplicate/symlinked PATH entry.
  const ownShimReal = safeRealpath(join(SHIM_DIR, name));
  const candidateReal = safeRealpath(candidate);
  if (ownShimReal && candidateReal && ownShimReal === candidateReal) {
    throw new BinaryResolutionError(
      `Refusing to exec: resolved '${name}' (${candidate}) is our own shim. PATH looks ` +
        `misconfigured (duplicate/reordered entries?). Aborting instead of recursing into myself.`,
    );
  }

  // A `#!/usr/bin/env node` launcher can't be exec'd where Node is absent
  // (the console daemon image). When the candidate is one, return the
  // native binary the launcher itself would spawn; otherwise unchanged.
  if (candidateReal) {
    const native = nativeBinaryForNodeLauncher(candidateReal);
    if (native) return native;
  }

  return candidate;
}

/** Resolve the .app bundle's real Mach-O binary for --desktop launches. */
export function resolveAppBundleBinary(appName: "Claude" | "Codex" | "Grok" | "Kimi" | "Crush" | "Pi" | "OpenCode"): string {
  return `/Applications/${appName}.app/Contents/MacOS/${appName}`;
}
