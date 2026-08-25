import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeSharedHookScriptsPortable,
  portableProfileCommandConfig,
  portableShellText,
} from "../../src/sync/portable-config.ts";

describe("portable sync configuration", () => {
  test("rewrites foreign and local homes without embedding a username", () => {
    expect(
      portableShellText(
        '/usr/bin/env CLAUDE_CONFIG_DIR="/home/bob/.claude/identities/work" /home/bob/.ais/hooks/check.sh',
        "/Users/alice",
      ),
    ).toBe('/usr/bin/env CLAUDE_CONFIG_DIR="${HOME}/.claude/identities/work" ${HOME}/.ais/hooks/check.sh');
  });

  test("canonicalises the obsolete Claude hook tree to the shared AIS tree", () => {
    expect(portableShellText("/home/bob/.claude/hooks/check.sh", "/Users/alice")).toBe(
      "${HOME}/.ais/hooks/check.sh",
    );
    expect(portableShellText("~/.claude/hooks/check.sh", "/Users/alice")).toBe(
      "${HOME}/.ais/hooks/check.sh",
    );
  });

  test("keeps a single-quoted path expandable by the shell", () => {
    expect(portableShellText("bash '/home/bob/.codex/hook.sh'", "/Users/alice")).toBe(
      "bash ''\"${HOME}\"'/.codex/hook.sh'",
    );
  });

  test("rewrites only command values in profile JSON", () => {
    const result = portableProfileCommandConfig(
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "/home/bob/.claude/hooks/check.sh" }] }],
        },
        documentation: "/home/bob remains literal outside a shell command",
      },
      "/Users/alice",
    );
    expect(result).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "${HOME}/.ais/hooks/check.sh" }] }],
      },
      documentation: "/home/bob remains literal outside a shell command",
    });
  });

  test("rewrites home-based path fields to portable tilde paths", () => {
    expect(
      portableProfileCommandConfig(
        {
          source: { source: "directory", path: "/home/alice/.claude/skills-shared" },
          nested: { path: "/Users/bob/Projects/plugins" },
          relative: { path: "packages/marketplace" },
        },
        "/Users/local-user",
      ),
    ).toEqual({
      source: { source: "directory", path: "~/.claude/skills-shared" },
      nested: { path: "~/Projects/plugins" },
      relative: { path: "packages/marketplace" },
    });
  });

  test("rewrites shared shell hooks atomically and preserves executable mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-portable-hooks-"));
    const hooksDir = join(home, ".ais", "hooks");
    const hookPath = join(hooksDir, "check.sh");
    try {
      await mkdir(hooksDir, { recursive: true });
      await writeFile(
        hookPath,
        '#!/bin/sh\ncase "$target" in "~"*) target="${target/#\\~/$HOME}" ;; esac\nexec /home/alice/.ais/bin/check "$@"\n',
      );
      await chmod(hookPath, 0o755);

      expect(await makeSharedHookScriptsPortable(home)).toBe(1);
      expect(await readFile(hookPath, "utf8")).toBe(
        '#!/bin/sh\ncase "$target" in "~"*) target="${target/#\\~/$HOME}" ;; esac\nexec ${HOME}/.ais/bin/check "$@"\n',
      );
      expect((await stat(hookPath)).mode & 0o777).toBe(0o755);
      expect(await makeSharedHookScriptsPortable(home)).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
