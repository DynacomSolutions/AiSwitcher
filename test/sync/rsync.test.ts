import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALI_CONFIG, CODEX_CONFIG, ZAI_CONFIG } from "../../src/identities/tool-configs.ts";
import { buildCrushSnapshotFilterArgs, buildRsyncArgs, buildSyncFilterArgs } from "../../src/sync/rsync.ts";

describe("AIS rsync construction", () => {
  test("all-profile filters include every registry/profile root and exclude volatile state", () => {
    const filters = buildSyncFilterArgs({ kind: "all" }, ["Projects/AiProfileSwitcher/.crush"], homedir());
    expect(filters).toContain("--include=/.claude/identities/***");
    expect(filters).toContain("--include=/.codex/identities.json");
    expect(filters).toContain("--include=/.zai/identities/***");
    expect(filters).toContain("--exclude=/.zai/identities/*/data/projects.json");
    expect(filters).toContain("--include=/.ali/identities/***");
    expect(filters).toContain("--exclude=/.ali/identities/*/data/projects.json");
    expect(filters).toContain("--exclude=*.sqlite-wal");
    expect(filters).toContain("--exclude=*.sqlite");
    expect(filters).not.toContain("--exclude=*.tmp");
    expect(filters).toContain("--exclude=chrome-profile/");
    expect(filters).toContain("--exclude=cache/");
    expect(filters).toContain("--exclude=logs_*.sqlite*");
    expect(filters).toContain("--include=/Projects/AiProfileSwitcher/.crush/***");
    expect(filters).not.toContain("--include=/Projects/AiProfileSwitcher/.crush/crush.db");
    expect(filters).toContain("--include=/.claude/projects/***");
    expect(filters).toContain("--include=/.codex/sessions/***");
    expect(filters).toContain("--include=/.ais/hooks/***");
    expect(filters.at(-1)).toBe("--exclude=*");
  });

  test("identity filters do not scan sibling identities", () => {
    const filters = buildSyncFilterArgs(
      { kind: "identity", cfg: CODEX_CONFIG, identityName: "identity-a" },
      [],
      homedir(),
    );
    expect(filters).toContain("--include=/.codex/identities/identity-a/***");
    expect(filters).not.toContain("--include=/.codex/identities/***");
    expect(filters).not.toContain("--include=/.zai/identities/***");
  });

  test("Zai identity sync can include its project-local data directory", () => {
    const filters = buildSyncFilterArgs(
      { kind: "identity", cfg: ZAI_CONFIG, identityName: "identity-a" },
      ["Projects/AiProfileSwitcher/.crush"],
      homedir(),
    );
    expect(filters).toContain("--include=/Projects/");
    expect(filters).toContain("--include=/Projects/AiProfileSwitcher/");
    expect(filters).toContain("--include=/Projects/AiProfileSwitcher/.crush/***");
  });

  test("Ali identity sync can include its project-local data directory (same shape as zai)", () => {
    const filters = buildSyncFilterArgs(
      { kind: "identity", cfg: ALI_CONFIG, identityName: "identity-a" },
      ["Projects/AiProfileSwitcher/.crush"],
      homedir(),
    );
    expect(filters).toContain("--include=/Projects/AiProfileSwitcher/.crush/***");
    expect(filters).toContain("--include=/.ali/identities/identity-a/***");
  });

  test("SSH is non-interactive and pull/push use each host's home", () => {
    const pull = buildRsyncArgs("remote1", "pull", [], homedir());
    const push = buildRsyncArgs("remote1", "push", [], homedir());
    expect(
      pull.some(
        (arg) =>
          arg.includes("BatchMode=yes") &&
          arg.includes("ServerAliveInterval=15") &&
          arg.includes("ControlPersist=300"),
      ),
    ).toBe(true);
    expect(pull.slice(-2)).toEqual(["remote1:./", `${homedir()}/`]);
    expect(push.slice(-2)).toEqual([`${homedir()}/`, "remote1:./"]);
    expect(pull).toContain("--no-owner");
    expect(pull).toContain("--no-group");
    expect(pull).toContain("--no-perms");
  });

  test("pull conflict mode preserves the overwritten local version instead of using newest-file-wins", () => {
    const backupDir = join(homedir(), ".cache", "ais", "conflicts", "run");
    const args = buildRsyncArgs("remote1", "pull", [], homedir(), {
      backupDir,
    });
    expect(args).toContain("--backup");
    expect(args).toContain(`--backup-dir=${backupDir}`);
    expect(args).not.toContain("--update");
  });

  test("staged transfers checksum against the receiver's live home instead of copying identical profiles", () => {
    const args = buildRsyncArgs("remote1", "push", [], homedir(), {
      remoteRoot: ".cache/ais/profile-incoming/snapshot",
      compareDest: "../../../..",
    });
    expect(args).toContain("--checksum");
    expect(args).toContain("--compare-dest=../../../..");
    expect(args.slice(-2)).toEqual([`${homedir()}/`, "remote1:.cache/ais/profile-incoming/snapshot/"]);
  });

  test("Crush snapshot filters include only verified snapshot databases and their manifest", () => {
    const filters = buildCrushSnapshotFilterArgs(["Projects/App/.crush/crush.db"]);
    expect(filters).toContain("--include=/.ais-crush-snapshot.json");
    expect(filters).toContain("--include=/Projects/App/.crush/crush.db");
    expect(filters.at(-1)).toBe("--exclude=*");
  });
});
