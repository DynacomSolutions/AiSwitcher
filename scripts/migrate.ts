import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import * as clack from "@clack/prompts";
import { runBackup } from "./backup.ts";
import { saveIdentitiesFile } from "../src/identities/store.ts";
import type { IdentitiesFile } from "../src/identities/types.ts";

// ============================================================================
// MACHINE-SPECIFIC CONFIG — edit this block for YOUR setup before running.
//
// This one-time migration assumes the pre-AIS layout the identities were
// originally created in:
//   - one "default" claude/codex config whose content still lives at the TOP
//     level of ~/.claude and ~/.codex (it becomes DEFAULT_IDENTITY);
//   - any number of older per-identity top-level directories named
//     ~/.claude-<name> (each becomes identities/<name> under ~/.claude).
// If your layout differs, adjust DEFAULT_IDENTITY / LEGACY_CLAUDE_IDENTITIES
// (and the move steps below) before running. A full backup is taken first
// regardless.
// ============================================================================
const DEFAULT_IDENTITY = "work";
const LEGACY_CLAUDE_IDENTITIES: Array<{ name: string; label: string }> = [
  { name: "personal", label: "Personal" },
  { name: "identity-a", label: "Identity A" },
];

async function checkNoRunningProcesses(): Promise<void> {
  for (const name of ["claude", "codex"]) {
    const proc = Bun.spawn(["pgrep", "-x", name], { stdio: ["ignore", "pipe", "ignore"] });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const pids = out.trim().split("\n").filter(Boolean);
    if (pids.length) {
      throw new Error(
        `migrate: found running '${name}' process(es) (pid ${pids.join(", ")}). ` +
          `Close every running claude/codex session first — including, if you're reading this from ` +
          `inside an active Claude Code or Codex session whose config dir is one of the directories ` +
          `being moved, this very session. Run this migration from a plain terminal instead.`,
      );
    }
  }
}

// Our own in-progress structure — never treat these as original content to
// relocate, even if a prior partial/failed run already created them (e.g. an
// earlier attempt got partway through moving entries before hitting an
// unrelated error, leaving `identities/` sitting in the source directory's
// own listing on the next run).
const OWN_STRUCTURE_NAMES = new Set(["identities", "identities.json"]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function moveTopLevelEntriesInto(
  sourceDir: string,
  targetDir: string,
  extraExcludes: string[] = [],
): Promise<void> {
  const excludes = new Set([...OWN_STRUCTURE_NAMES, ...extraExcludes]);
  const entries = (await readdir(sourceDir)).filter((entry) => !excludes.has(entry));
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const dest = join(targetDir, entry);
    if (await pathExists(dest)) {
      // Already moved by a prior partial run — skip rather than clobber.
      console.error(`migrate: ${dest} already exists, skipping (already moved by a prior run?)`);
      continue;
    }
    await rename(join(sourceDir, entry), dest);
  }
}

async function renameIfNeeded(src: string, dest: string): Promise<void> {
  if (await pathExists(dest)) {
    console.error(`migrate: ${dest} already exists, skipping rename (already moved by a prior run?)`);
    return;
  }
  await rename(src, dest);
}

async function rewriteSelfReferences(filePath: string, oldPath: string, newPath: string): Promise<void> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return;
  const content = await file.text();
  const rewritten = content.replaceAll(oldPath, newPath);
  if (rewritten !== content) {
    await Bun.write(filePath, rewritten);
    console.error(`migrate: rewrote self-references in ${filePath}`);
  }
}

export async function migrateClaude(home: string): Promise<void> {
  const claudeHome = join(home, ".claude");
  const targetDir = join(claudeHome, "identities", DEFAULT_IDENTITY);

  // Shared infrastructure directories (e.g. "orchestration" symlinks or
  // top-level "hooks") stay at the container level: settings.json's hook
  // commands reference them by absolute path assuming they live there
  // (e.g. "~/.claude/hooks/some-hook.sh"), not nested inside any one
  // identity's folder. Extend the exclude list if your setup has more.
  console.error(`migrate: moving existing ${claudeHome} contents into ${targetDir} (except orchestration/hooks, which are shared)`);
  await moveTopLevelEntriesInto(claudeHome, targetDir, ["orchestration", "hooks"]);

  for (const { name } of LEGACY_CLAUDE_IDENTITIES) {
    console.error(`migrate: moving ${home}/.claude-${name} -> ${claudeHome}/identities/${name}`);
    await renameIfNeeded(join(home, `.claude-${name}`), join(claudeHome, "identities", name));
  }

  // No compatibility symlinks at the old ~/.claude-<name> paths — those are
  // legacy and intentionally left to not exist post-migration. Unlike the
  // default identity (which only needed hooks/orchestration kept shared), a
  // legacy identity's own settings.json can embed absolute self-references
  // to its OLD top-level location (e.g. a statusLine command pointing at
  // "~/.claude-identity-a/plugins/..."), which do need rewriting — there's no
  // shared-directory exception for these.
  // Note: this only catches the absolute-path form; a "~/.claude-identity-a/..."
  // tilde-form self-reference (as opposed to "/Users/x/.claude-identity-a/...")
  // won't match and may need manual review after migration.
  for (const { name } of LEGACY_CLAUDE_IDENTITIES) {
    const oldIdentityHome = join(home, `.claude-${name}`);
    const newIdentityHome = join(claudeHome, "identities", name);
    await rewriteSelfReferences(join(newIdentityHome, "settings.json"), oldIdentityHome, newIdentityHome);
  }

  const identitiesFile: IdentitiesFile = {
    version: 1,
    identities: [
      {
        name: DEFAULT_IDENTITY,
        label: "Work",
        configDir: join(claudeHome, "identities", DEFAULT_IDENTITY),
      },
      ...LEGACY_CLAUDE_IDENTITIES.map(({ name, label }) => ({
        name,
        label,
        configDir: join(claudeHome, "identities", name),
      })),
    ],
  };
  await saveIdentitiesFile(join(claudeHome, "identities.json"), identitiesFile);
  console.error(`migrate: wrote ${claudeHome}/identities.json`);
}

export async function migrateCodex(home: string): Promise<void> {
  const codexHome = join(home, ".codex");
  const targetDir = join(codexHome, "identities", DEFAULT_IDENTITY);

  console.error(`migrate: moving existing ${codexHome} contents into ${targetDir}`);
  await moveTopLevelEntriesInto(codexHome, targetDir);

  console.error("migrate: rewriting self-referencing absolute paths in the moved config");
  await rewriteSelfReferences(join(targetDir, "config.toml"), codexHome, targetDir);
  await rewriteSelfReferences(join(targetDir, "hooks.json"), codexHome, targetDir);

  const identitiesFile: IdentitiesFile = {
    version: 1,
    identities: [
      {
        name: DEFAULT_IDENTITY,
        label: "Work",
        configDir: targetDir,
      },
    ],
  };
  await saveIdentitiesFile(join(codexHome, "identities.json"), identitiesFile);
  console.error(`migrate: wrote ${codexHome}/identities.json`);
}

const CLAUDE_GUARDRAIL_AGENTS_MD = `# AI Profile/Identity Switcher — container directory

This directory (`+ "`~/.claude`" + `) is a CONTAINER managed by the AiProfileSwitcher
tool. It is NOT itself a Claude Code identity.

- `+ "`identities.json`" + ` is the registry of every identity (name, label, description,
  configDir, directories).
- Each real identity's full config (settings, auth, history, projects, plugins,
  sessions) lives in `+ "`identities/<name>/`" + ` — never at this top level.
- If you are an agent operating with cwd inside this directory: do NOT create
  or write identity-specific files here at the top level. Read
  `+ "`identities.json`" + ` and use the right `+ "`identities/<name>/`" + ` subdirectory instead.
- Shared top-level directories (e.g. `+ "`orchestration`" + `, `+ "`hooks`" + `) are shared
  infrastructure, not identity-specific data — they deliberately stay outside
  `+ "`identities/<name>/`" + `. Any identity's `+ "`settings.json`" + ` that references their
  scripts by absolute path expects them here, at the container level. Don't
  move them into an identity folder without updating every `+ "`settings.json`" + `
  that references them.
`;

const CODEX_GUARDRAIL_AGENTS_MD = `# AI Profile/Identity Switcher — container directory

This directory (`+ "`~/.codex`" + `) is a CONTAINER managed by the AiProfileSwitcher
tool. It is NOT itself a Codex identity.

- `+ "`identities.json`" + ` is the registry of every identity (name, label, description,
  configDir, directories).
- Each real identity's full config (auth, config.toml, sessions, skills) lives
  in `+ "`identities/<name>/`" + ` — never at this top level.
- If you are an agent operating with cwd inside this directory: do NOT create
  or write identity-specific files here at the top level. Read
  `+ "`identities.json`" + ` and use the right `+ "`identities/<name>/`" + ` subdirectory instead.
`;

export async function writeGuardrailDocs(home: string): Promise<void> {
  const claudeHome = join(home, ".claude");
  const codexHome = join(home, ".codex");
  await Bun.write(join(claudeHome, "CLAUDE.md"), "@AGENTS.md\n");
  await Bun.write(join(claudeHome, "AGENTS.md"), CLAUDE_GUARDRAIL_AGENTS_MD);
  await Bun.write(join(codexHome, "AGENTS.md"), CODEX_GUARDRAIL_AGENTS_MD);
  console.error("migrate: wrote container-level CLAUDE.md/AGENTS.md guardrail docs");
}

async function main(): Promise<void> {
  const home = homedir();

  clack.intro("AiProfileSwitcher: one-time migration");
  clack.log.warn(
    "This will restructure your LIVE ~/.claude and ~/.codex directories:\n" +
      `  - ${home}/.claude/* (existing content, except orchestration/hooks) -> ${home}/.claude/identities/${DEFAULT_IDENTITY}/\n` +
      `  - ${home}/.claude/orchestration and ${home}/.claude/hooks stay put (shared, not identity-specific)\n` +
      LEGACY_CLAUDE_IDENTITIES.map(
        ({ name }) =>
          `  - ${home}/.claude-${name} -> ${home}/.claude/identities/${name} (no compatibility symlink left behind — legacy path)`,
      ).join("\n") +
      "\n" +
      `  - ${home}/.codex/* (existing content) -> ${home}/.codex/identities/${DEFAULT_IDENTITY}/\n` +
      "A full backup is taken first regardless.\n" +
      "NOTE: edit the CONFIG block at the top of scripts/migrate.ts if your pre-migration layout differs.",
  );

  await checkNoRunningProcesses();

  const proceed = await clack.confirm({
    message: "Proceed with backup + migration?",
    initialValue: false,
  });
  if (clack.isCancel(proceed) || !proceed) {
    clack.cancel("Migration cancelled, nothing was touched.");
    process.exit(1);
  }

  const backupDir = await runBackup();
  clack.log.info(`Backup complete: ${backupDir}`);

  await migrateClaude(home);
  await migrateCodex(home);
  await writeGuardrailDocs(home);

  clack.outro(
    "Migration complete. Open a NEW terminal (or run `hash -r`) before using claude/codex again.",
  );
}

if (import.meta.main) {
  await main();
}
