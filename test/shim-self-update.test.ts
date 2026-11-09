import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isSelfUpdateCommand, selfUpdateEnv } from "../src/shared/self-update.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("each tool's own self-update subcommand is recognised only as the first argument", () => {
  expect(isSelfUpdateCommand("claude", ["update"])).toBe(true);
  expect(isSelfUpdateCommand("claude", ["upgrade"])).toBe(true);
  expect(isSelfUpdateCommand("codex", ["update"])).toBe(true);
  expect(isSelfUpdateCommand("codex", ["upgrade"])).toBe(false);
  expect(isSelfUpdateCommand("grok", ["update"])).toBe(true);
  expect(isSelfUpdateCommand("kimi", ["upgrade"])).toBe(true);
  expect(isSelfUpdateCommand("opencode", ["upgrade"])).toBe(true);
  expect(isSelfUpdateCommand("zai", ["update"])).toBe(false);
  expect(isSelfUpdateCommand("pi", ["update"])).toBe(false);
  expect(isSelfUpdateCommand("claude", [])).toBe(false);
  expect(isSelfUpdateCommand("claude", ["-p", "update"])).toBe(false);
  expect(isSelfUpdateCommand("claude", ["fix the update script"])).toBe(false);
});

function setup(): { home: string; binDir: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), "ais-self-update-"));
  dirs.push(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "identities.json"),
    JSON.stringify({ version: 1, identities: [{ name: "acct-a", label: "A", configDir: join(home, "a") }] }),
  );
  const binDir = join(home, "real-bin");
  mkdirSync(binDir);
  const fake = join(binDir, "claude");
  writeFileSync(fake, `#!/bin/sh\necho "REAL ARGS: $*"\necho "CFG: \${CLAUDE_CONFIG_DIR:-unset}"\necho "PREFIX: \${npm_config_prefix:-unset}"\n`);
  chmodSync(fake, 0o755);
  return {
    home,
    binDir,
    env: { PATH: process.env.PATH ?? "", HOME: home, AI_PROFILE_SWITCHER_REAL_BIN_DIR: binDir },
  };
}

function runShim(args: string[], cwd: string, env: Record<string, string>) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "claude.ts"), ...args], {
    cwd,
    env,
    stdin: "ignore",
  });
}

// T3 Code runs `claude update` non-interactively from a directory bound to no
// identity. That used to fail with "no --identity given".
test("claude update runs the real binary with no identity in a non-interactive context", () => {
  const { home, env } = setup();
  const proc = runShim(["update"], home, env);
  const stdout = proc.stdout.toString();
  expect(proc.stderr.toString()).not.toContain("refusing to prompt");
  expect(stdout).toContain("REAL ARGS: update");
  expect(stdout).toContain("CFG: unset");
  expect(proc.exitCode).toBe(0);
});

// claude's updater runs `npm install -g`; without the managed prefix it
// updated an unused copy under the user's own npm prefix instead.
test("claude update installs into the managed npm prefix", () => {
  const { home, binDir, env } = setup();
  const proc = runShim(["update"], home, { ...env, npm_config_prefix: join(home, "user-npm") });
  expect(proc.stdout.toString()).toContain(`PREFIX: ${dirname(binDir)}`);
  expect(proc.exitCode).toBe(0);
});

test("selfUpdateEnv sets the prefix only for a binary in the managed bin dir", () => {
  expect(selfUpdateEnv("/m/npm/bin/claude", "/m/npm/bin")).toEqual({ npm_config_prefix: "/m/npm" });
  expect(selfUpdateEnv("/m/npm/bin/claude", "/m/npm/bin/")).toEqual({ npm_config_prefix: "/m/npm" });
  expect(selfUpdateEnv("/usr/bin/claude", "/m/npm/bin")).toEqual({});
  expect(selfUpdateEnv("/m/npm/bin-other/claude", "/m/npm/bin")).toEqual({});
});

test("claude update keeps a preset config dir", () => {
  const { home, env } = setup();
  const proc = runShim(["update"], home, { ...env, CLAUDE_CONFIG_DIR: join(home, "a") });
  expect(proc.stdout.toString()).toContain(`CFG: ${join(home, "a")}`);
  expect(proc.exitCode).toBe(0);
});

test("other non-interactive launches still require an identity", () => {
  const { home, env } = setup();
  const proc = runShim(["-p", "hello"], home, env);
  expect(proc.stderr.toString()).toContain("refusing to prompt in a non-interactive context");
  expect(proc.exitCode).toBe(1);
});
