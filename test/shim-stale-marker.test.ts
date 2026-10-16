import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeParentSession } from "../src/shared/cli-args.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a session marker without its source tool config env var is stale", () => {
  expect(activeParentSession("claude", { AI_PROFILE_SWITCHER_SESSION: "acct-a" })).toBeUndefined();
  expect(activeParentSession("claude", { AI_PROFILE_SWITCHER_SESSION: "acct-a", CLAUDE_CONFIG_DIR: "" })).toBeUndefined();
});

test("a marker paired with the source tool config env var is a genuine nested launch", () => {
  expect(
    activeParentSession("claude", { AI_PROFILE_SWITCHER_SESSION: "acct-a", CLAUDE_CONFIG_DIR: "/synthetic/claude/acct-a" }),
  ).toEqual({ toolName: "claude", identity: "acct-a" });
  expect(activeParentSession("claude", {})).toBeUndefined();
});

test("a tool-scoped marker remains a nested session across providers", () => {
  expect(activeParentSession("codex", {
    AI_PROFILE_SWITCHER_SESSION: "acct-a",
    AI_PROFILE_SWITCHER_TOOL: "claude",
    CLAUDE_CONFIG_DIR: "/synthetic/claude/acct-a",
  })).toEqual({ toolName: "claude", identity: "acct-a" });
});

// Same entry path as the release binary (src/claude.ts -> runWrapper), run in
// a subprocess with a synthetic home. A stale marker used to be inherited as
// an explicit identity; now it falls through to normal resolution, which in a
// non-interactive context refuses to prompt.
test("claude entrypoint ignores a stale session marker and resolves from scratch", () => {
  const home = mkdtempSync(join(tmpdir(), "ais-stale-marker-"));
  dirs.push(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "identities.json"),
    JSON.stringify({ version: 1, identities: [{ name: "acct-a", label: "A", configDir: join(home, "a") }] }),
  );
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    AI_PROFILE_SWITCHER_SESSION: "acct-z",
  };
  const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "claude.ts")], {
    cwd: home,
    env,
    stdin: "ignore",
  });
  const stderr = proc.stderr.toString();
  expect(stderr).toContain("refusing to prompt in a non-interactive context");
  expect(stderr).not.toContain("acct-z");
  expect(proc.exitCode).toBe(1);
});
