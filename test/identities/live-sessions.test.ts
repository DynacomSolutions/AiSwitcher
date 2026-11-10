import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveSessionPids, scanLiveSessions } from "../../src/identities/live-sessions.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-live-sessions-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const fake = async (pid: number, argv: string[], env: Record<string, string>, exe?: string) => {
  const dir = join(root, "proc", String(pid));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cmdline"), `${argv.join("\0")}\0`);
  await writeFile(join(dir, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0"));
  if (exe) await symlink(exe, join(dir, "exe"));
};

test("finds claude sessions by CLAUDE_CONFIG_DIR, argv[0] or executable name; skips helpers and other tools", async () => {
  const want = join(root, "id");
  await fake(11, ["/opt/npm/bin/claude", "--model", "m"], { CLAUDE_CONFIG_DIR: want });
  await fake(12, ["some-title"], { CLAUDE_CONFIG_DIR: `${want}/` }, "/x/claude-code/bin/claude.exe (deleted)");
  await fake(13, ["claude", "__session-sidecar"], { CLAUDE_CONFIG_DIR: want });
  await fake(14, ["/usr/bin/zsh", "-c", "claude"], { CLAUDE_CONFIG_DIR: want });
  await fake(15, ["claude"], { CLAUDE_CONFIG_DIR: join(root, "other") });
  await fake(16, ["codex"], { CODEX_HOME: want });
  const opts = { procRoot: join(root, "proc"), home: root };
  expect(await liveSessionPids("claude", want, opts)).toEqual([11, 12]);
  expect(await liveSessionPids("codex", want, opts)).toEqual([16]);
});

test("a process without the variable counts for the default folder in home only; no /proc finds none", async () => {
  await fake(21, ["claude"], {});
  const opts = { procRoot: join(root, "proc"), home: root };
  expect(await liveSessionPids("claude", join(root, ".claude"), opts)).toEqual([21]);
  expect(await liveSessionPids("claude", join(root, "id"), opts)).toEqual([]);
  expect(await liveSessionPids("claude", join(root, ".claude"), { procRoot: join(root, "missing") })).toEqual([]);
});

test("node cli.js launches, symlinked folders, console-pod paths and pi sessions", async () => {
  const want = join(root, "id");
  await mkdir(want, { recursive: true });
  await symlink(want, join(root, "link"));
  await fake(31, ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"], { CLAUDE_CONFIG_DIR: want });
  await fake(32, ["claude"], { CLAUDE_CONFIG_DIR: join(root, "link") });
  // a console-pod session: its home is /home/ais, mounted from the host home `root`
  await fake(33, ["claude"], { HOME: "/home/ais", AIS_HOST_HOME: root, CLAUDE_CONFIG_DIR: "/home/ais/id" });
  await fake(34, ["claude"], { HOME: "/home/ais", AIS_HOST_HOME: root });
  await fake(35, ["node", "/x/pi-coding-agent/dist/cli.js"], { PI_CODING_AGENT_DIR: want });
  await fake(36, ["pi"], { HOME: root });
  const opts = { procRoot: join(root, "proc"), home: root };
  expect(await liveSessionPids("claude", want, opts)).toEqual([31, 32, 33]);
  expect(await liveSessionPids("claude", join(root, ".claude"), opts)).toEqual([34]);
  expect(await liveSessionPids("pi", want, opts)).toEqual([35]);
  expect(await liveSessionPids("pi", join(root, ".pi", "agent"), opts)).toEqual([36]);
  expect((await scanLiveSessions("pi", null, opts)).pids).toEqual([35, 36]);
});

test("a scan that cannot run says why", async () => {
  const scan = await scanLiveSessions("claude", join(root, ".claude"), { procRoot: join(root, "missing") });
  expect(scan.pids).toEqual([]);
  expect(scan.unavailable).toContain("cannot check for running sessions");
});
