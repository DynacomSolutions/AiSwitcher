import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single consolidated root for every directory THIS project's own tooling
 * creates and manages — the git-managed backup repo, SSH sync's local
 * cache/staging trees, the npm prefix `ais upgrade` installs real vendor
 * CLIs into, and this project's own sync config. Distinct from each wrapped
 * tool's own identity data (`~/.claude`, `~/.codex`, ...), and from
 * `~/.ais/hooks` / `~/.ais/skills-shared` / `~/.ais/AGENTS.md` /
 * `~/.ais/STANDING-DEFAULTS.md` — pre-existing, separately-managed shared
 * cross-tool infrastructure this project's tooling reads but never creates
 * or writes. Before this consolidation these lived scattered across
 * `~/.ai-switcher-backups`, `~/.cache/ais`, `~/.config/ais`, and
 * `~/.local/share/ais` — four unrelated top-level directories for one
 * project's own data. `~/.local/bin` (the shim binaries themselves, plus
 * `ais`) deliberately stays OUTSIDE `~/.ais`: those need to be on `PATH`
 * with zero shell-rc edits (see AGENTS.md's "Shims install to ~/.local/bin"
 * design decision) — this module is only about this project's own *data*,
 * not the installed program.
 */
export function aisHome(home: string = homedir()): string {
  return join(home, ".ais");
}

/** Git-managed backup repo — see scripts/backup.ts. */
export function aisBackupsDir(home: string = homedir()): string {
  return join(aisHome(home), "backups");
}

/** Home-relative form of aisRemoteCacheDir(), for building the equivalent
 * path on a remote host reached over SSH (sync/service.ts constructs both a
 * local absolute path and a remote home-relative path for the same
 * snapshot staging tree — this constant is the one source of truth for the
 * relative half, so the two can never drift apart). */
export const AIS_REMOTE_CACHE_REL = ".ais/remote-cache";

/** SSH sync's local cache/staging trees: the sync lock, incoming/outgoing
 * snapshot staging, and conflict/dedupe archives. Formerly `~/.cache/ais`. */
export function aisRemoteCacheDir(home: string = homedir()): string {
  return join(aisHome(home), "remote-cache");
}

/** This project's own config (currently just sync-v2.json). Formerly
 * `~/.config/ais`. */
export function aisConfigDir(home: string = homedir()): string {
  return join(aisHome(home), "config");
}

/** Explicit corrections for sessions whose immutable transcript metadata was
 * created from the wrong working directory. Kept outside the transcript so a
 * live writer never has its open rollout file replaced underneath it. */
export function aisResumeCwdOverridesPath(home: string = homedir()): string {
  return join(aisConfigDir(home), "resume-cwd-overrides.json");
}

/** npm prefix `ais upgrade` installs/upgrades real vendor CLIs into
 * (Claude Code, Codex, Kimi Code, Crush) — see cli/upgrade.ts. Formerly
 * `~/.local/share/ais/npm`. */
export function aisNpmDir(home: string = homedir()): string {
  return join(aisHome(home), "npm");
}

/** scripts/install.ts's own idempotent-install manifest. Formerly
 * `~/.local/bin/.ais-manifest.json` — dev-tooling-only, never read by any
 * compiled wrapper/ais binary. */
export function aisManifestPath(home: string = homedir()): string {
  return join(aisHome(home), "manifest.json");
}
