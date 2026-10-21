import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rsync = Bun.which("rsync");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const entry = new URL("../../src/ais.ts", import.meta.url).pathname;

/** Records rchar/wchar of every ais process (local and the fake remote) on exit. */
const PRELOAD = `
import { appendFileSync, readFileSync } from "node:fs";
process.on("exit", () => {
  const io = readFileSync("/proc/self/io", "utf8");
  const n = (k) => Number(new RegExp("^" + k + ": (\\\\d+)", "m").exec(io)[1]);
  appendFileSync(process.env.AIS_IO_LOG, JSON.stringify({ argv: process.argv.slice(2).join(" "), rchar: n("rchar"), wchar: n("wchar") }) + "\\n");
});
`;

async function writeCrushFixture(home: string, bytes: number): Promise<void> {
  const data = join(home, ".zai", "identities", "a", "data");
  const dbDir = join(home, "proj", ".crush");
  await mkdir(data, { recursive: true });
  await mkdir(dbDir, { recursive: true });
  await writeFile(join(home, ".zai", "identities.json"), JSON.stringify({
    version: 1, identities: [{ name: "a", label: "A", configDir: "~/.zai/identities/a" }],
  }));
  await writeFile(join(data, "projects.json"), JSON.stringify({ projects: [{ data_dir: dbDir }] }));
  const db = new Database(join(dbDir, "crush.db"));
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, summary_message_id TEXT, todos TEXT)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, provider TEXT, is_summary_message INTEGER DEFAULT 0 NOT NULL)");
  db.run("CREATE TABLE files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(path, session_id, version))");
  db.run("CREATE TABLE read_files (session_id TEXT NOT NULL, path TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY(path, session_id))");
  db.run("INSERT INTO sessions VALUES ('s1', NULL, 't', 1, 0, 0, 0, 1, 1, NULL, NULL)");
  db.run("INSERT INTO messages VALUES ('m1', 's1', 'user', ?, NULL, 1, 1, NULL, NULL, 0)", ["x".repeat(bytes)]);
  db.close();
}

test.skipIf(process.platform !== "linux" || !rsync)("a no-change ais sync moves near zero bytes end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-pipeline-"));
  roots.push(root);
  const [local, remote, shim] = [join(root, "local"), join(root, "remote"), join(root, "shim")];
  const log = join(root, "io.log");
  await mkdir(shim, { recursive: true });
  await mkdir(join(remote, ".local", "bin"), { recursive: true });
  await writeFile(log, "");
  await writeFile(join(root, "preload.ts"), PRELOAD);

  // Fake transport: "ssh <opts> host cmd..." runs cmd locally with the remote HOME.
  await writeFile(join(shim, "ssh"), `#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2;; -*) shift;; *) break;; esac; done
shift
cd "${remote}" && HOME="${remote}" exec sh -c "$*"
`);
  await chmod(join(shim, "ssh"), 0o755);
  await writeFile(join(remote, ".local", "bin", "ais"), `#!/bin/sh\nexec "${process.execPath}" --preload "${join(root, "preload.ts")}" "${entry}" "$@"\n`);
  await chmod(join(remote, ".local", "bin", "ais"), 0o755);

  // 5 MB of plain profile data plus a 40 MB Crush database on the local side.
  const profile = join(local, ".claude", "identities", "a");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "history.jsonl"), `${"j".repeat(1_000_000)}\n`);
  for (let i = 0; i < 4; i++) await writeFile(join(profile, `blob${i}.bin`), Buffer.alloc(1_000_000, i));
  await writeCrushFixture(local, 40_000_000);
  await writeCrushFixture(remote, 10); // the remote has its own machine-local project index
  await mkdir(join(local, ".claude"), { recursive: true });
  await writeFile(join(local, ".claude", "identities.json"), JSON.stringify({
    version: 1, identities: [{ name: "a", label: "A", configDir: "~/.claude/identities/a" }],
  }));
  await mkdir(local + "/.config/ais", { recursive: true });
  const syncConfig = join(root, "sync.json");
  await writeFile(syncConfig, JSON.stringify({ version: 2, remotes: ["fake-host"] }));
  await mkdir(remote, { recursive: true });

  const env = {
    ...process.env,
    HOME: local,
    PATH: `${shim}:${process.env.PATH}`,
    AIS_SYNC_CONFIG: syncConfig,
    AIS_IO_LOG: log,
  };
  const run = async (): Promise<{ exitCode: number; text: string; entries: Array<{ argv: string; rchar: number; wchar: number }> }> => {
    await writeFile(log, "");
    const proc = Bun.spawn([process.execPath, "--preload", join(root, "preload.ts"), entry, "sync", "now"], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const entries = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { exitCode, text: out + err, entries };
  };

  // Converge: the first runs legitimately copy everything, and the database merges settle.
  let first;
  for (let i = 0; i < 3; i++) {
    first = await run();
    expect({ run: i, code: first.exitCode, text: first.exitCode ? first.text : "" }).toEqual({ run: i, code: 0, text: "" });
  }

  // Steady state: nothing changed since the last run.
  const before = await Bun.file(join(profile, "history.jsonl")).stat();
  const steady = await run();
  expect({ code: steady.exitCode, text: steady.exitCode ? steady.text : "" }).toEqual({ code: 0, text: "" });
  const total = steady.entries.reduce((sum, e) => sum + e.rchar + e.wchar, 0);
  // Local and remote ais processes together (rsync children excluded, see rsync-io.test.ts). About 4 MB of
  // each process is runtime start-up; re-snapshotting the 40 MB database alone would read and write over 120 MB.
  expect(total).toBeLessThan(30_000_000);
  expect(steady.entries.some((e) => e.argv.includes("merge-zai-snapshot"))).toBe(false);
  expect((await Bun.file(join(profile, "history.jsonl")).stat()).mtimeMs).toBe(before.mtimeMs);
}, 120_000);
