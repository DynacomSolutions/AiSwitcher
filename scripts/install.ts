import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { runBackup } from "./backup.ts";
import { aisManifestPath } from "../src/shared/ais-home.ts";

// "open" (shadows macOS's /usr/bin/open) is a macOS-only concept — see
// scripts/build.ts's matching platform gate. "ais" (the management CLI)
// ships on every platform.
const BINARIES =
  process.platform === "darwin"
    ? ["claude", "codex", "grok", "kimi", "zai", "ali", "pi", "opencode", "open", "ais"]
    : ["claude", "codex", "grok", "kimi", "zai", "ali", "pi", "opencode", "ais"];

// Records the source hash (see source-hash.ts) of whatever's currently
// deployed at ~/.local/bin/<name> — lets each binary's install be gated
// independently on whether ITS OWN dependency closure changed, instead of
// treating "claude"/"codex"/"grok"/"kimi"/"zai"/"open"/"ais" as one
// all-or-nothing unit. claude/codex/grok/kimi/zai/open are thin wrappers
// that change rarely; ais (the actively-developed management CLI) changes
// often but never touches src/claude.ts's/src/codex.ts's/src/grok.ts's/
// src/kimi.ts's/src/zai.ts's dependency closure (confirmed via their
// --metafile output — none import from src/cli/*).
const MANIFEST_PATH = aisManifestPath();
const LEGACY_MANIFEST_PATH = join(homedir(), ".local", "bin", ".ais-manifest.json");

async function readManifest(): Promise<Record<string, string>> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) return {};
  return (await file.json()) as Record<string, string>;
}

// scripts/install.ts is dev-tooling only (never shipped in a compiled
// binary — see ais-home.ts), so this manifest's own move to ~/.ais doesn't
// need the general self-healing migrateLegacyAisHome() every wrapper/ais
// invocation runs; a plain one-time check here is enough.
async function migrateLegacyManifest(): Promise<void> {
  if (MANIFEST_PATH === LEGACY_MANIFEST_PATH) return;
  const legacyExists = await lstat(LEGACY_MANIFEST_PATH).then(
    () => true,
    () => false,
  );
  if (!legacyExists || (await Bun.file(MANIFEST_PATH).exists())) return;
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await rename(LEGACY_MANIFEST_PATH, MANIFEST_PATH);
  console.error(`install: migrated ${LEGACY_MANIFEST_PATH} -> ${MANIFEST_PATH}`);
}

async function runInstall(): Promise<void> {
  const shimDir = join(homedir(), ".local", "bin");
  await mkdir(shimDir, { recursive: true });

  await migrateLegacyManifest();
  const manifest = await readManifest();
  const pending: Array<{ name: string; hash: string }> = [];

  for (const name of BINARIES) {
    const src = join("dist", name);
    // Read the hash build.ts recorded right after compiling THIS dist/<name>
    // — never recompute it from whatever's currently on disk under src/,
    // which can have drifted since the last build (edited-but-not-yet-
    // rebuilt source would otherwise produce a hash that doesn't actually
    // describe the binary being installed — see build.ts's own comment).
    const hashPath = `${src}.hash`;
    if (!(await Bun.file(src).exists()) || !(await Bun.file(hashPath).exists())) {
      throw new Error(`install: ${src} (or its .hash) not found — run \`bun run build\` first`);
    }
    const hash = (await Bun.file(hashPath).text()).trim();
    const alreadyInstalled = await Bun.file(join(shimDir, name)).exists();
    if (alreadyInstalled && manifest[name] === hash) {
      console.error(`install: ${name} unchanged, skipping`);
      continue;
    }
    pending.push({ name, hash });
  }

  if (pending.length === 0) {
    console.error("install: everything already up to date, nothing to do.");
    return;
  }

  // Only "claude", "codex", "grok", "kimi", "zai", and "ali" are proxies for
  // a config directory a broken build could actually put at risk; "ais"/
  // "open" changing doesn't warrant a multi-GB directory snapshot (see
  // AGENTS.md/backup.ts's BACKUP_GROUPS).
  const backupGroups = (["claude", "codex", "grok", "kimi", "zai", "ali", "pi", "opencode"] as const).filter((name) =>
    pending.some((p) => p.name === name),
  );
  if (backupGroups.length > 0) {
    const backupDir = await runBackup(backupGroups);
    console.error(`install: backup complete: ${backupDir}`);
  } else {
    console.error("install: skipping backup — only proxies that don't own a config directory changed.");
  }

  for (const { name, hash } of pending) {
    const dest = join(shimDir, name);
    // Unlink first: copyFile follows a destination symlink and overwrites
    // whatever it points at, rather than replacing the symlink itself. This
    // matters when the REAL tool's own installer already left a symlink at
    // this exact shim path — confirmed for grok, whose installer symlinks
    // ~/.local/bin/grok -> ~/.grok/bin/grok. Without this, installing our
    // shim would silently overwrite the real grok binary instead of
    // shadowing it.
    await rm(dest, { force: true });
    await copyFile(join("dist", name), dest);
    await chmod(dest, 0o755);
    manifest[name] = hash;
    console.error(`install: dist/${name} -> ${dest}`);
  }

  await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.error(
    "install: done. Open a NEW terminal (or run `hash -r`) so PATH resolution picks up the shims.",
  );
}

if (import.meta.main) {
  await runInstall();
}
