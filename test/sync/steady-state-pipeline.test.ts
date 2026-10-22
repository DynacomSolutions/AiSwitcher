import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const rsync = Bun.which("rsync");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const entry = new URL("../../src/ais.ts", import.meta.url).pathname;

/** Records /proc/self/io of every ais process (local and the fake remote) on exit. */
const PRELOAD = `
import { appendFileSync, readFileSync } from "node:fs";
process.on("exit", () => {
  const io = readFileSync("/proc/self/io", "utf8");
  const n = (k) => Number(new RegExp("^" + k + ": (\\\\d+)", "m").exec(io)[1]);
  appendFileSync(process.env.AIS_IO_LOG, JSON.stringify({ argv: process.argv.slice(2).join(" "), rchar: n("rchar"), wchar: n("wchar"), read_bytes: n("read_bytes"), write_bytes: n("write_bytes") }) + "\\n");
});
`;

interface IoEntry { argv: string; rchar: number; wchar: number; read_bytes: number; write_bytes: number }
interface RunResult { exitCode: number; text: string; entries: IoEntry[] }

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

/** Two homes joined by a fake ssh: "ssh <opts> host cmd..." runs cmd locally with the remote HOME.
 * Every ais process, and every rsync (a wrapper that reports its own /proc io), logs to one file. */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "ais-pipeline-"));
  roots.push(root);
  const [local, remote, shim] = [join(root, "local"), join(root, "remote"), join(root, "shim")];
  const log = join(root, "io.log");
  await mkdir(shim, { recursive: true });
  await mkdir(join(remote, ".local", "bin"), { recursive: true });
  await mkdir(local, { recursive: true });
  await writeFile(log, "");
  await writeFile(join(root, "preload.ts"), PRELOAD);
  await writeFile(join(shim, "ssh"), `#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2;; -*) shift;; *) break;; esac; done
shift
cd "${remote}" && HOME="${remote}" exec sh -c "$*"
`);
  await writeFile(join(shim, "rsync"), `#!/bin/sh
${rsync} "$@"; rc=$?
awk -v h="$HOME" '/^rchar/{r=$2}/^wchar/{w=$2}/^read_bytes/{rb=$2}/^write_bytes/{wb=$2}END{printf "{\\"argv\\":\\"rsync %s\\",\\"rchar\\":%s,\\"wchar\\":%s,\\"read_bytes\\":%s,\\"write_bytes\\":%s}\\n",h,r,w,rb,wb}' /proc/$$/io >> "$AIS_IO_LOG"
exit $rc
`);
  await writeFile(join(remote, ".local", "bin", "ais"), `#!/bin/sh\nexec "${process.execPath}" --preload "${join(root, "preload.ts")}" "${entry}" "$@"\n`);
  for (const file of [join(shim, "ssh"), join(shim, "rsync"), join(remote, ".local", "bin", "ais")]) await chmod(file, 0o755);
  const syncConfig = join(root, "sync.json");
  await writeFile(syncConfig, JSON.stringify({ version: 2, remotes: ["fake-host"] }));
  const env = { ...process.env, HOME: local, PATH: `${shim}:${process.env.PATH}`, AIS_SYNC_CONFIG: syncConfig, AIS_IO_LOG: log };
  const run = async (extra: Record<string, string> = {}): Promise<RunResult> => {
    await writeFile(log, "");
    const proc = Bun.spawn([process.execPath, "--preload", join(root, "preload.ts"), entry, "sync", "now"], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const entries = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as IoEntry);
    return { exitCode, text: out + err, entries };
  };
  return { root, local, remote, run };
}

async function put(home: string, rel: string, content: string | Buffer, mtimeSeconds?: number): Promise<void> {
  const path = join(home, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (mtimeSeconds !== undefined) await utimes(path, mtimeSeconds, mtimeSeconds);
}

const claudeRegistry = JSON.stringify({ version: 1, identities: [{ name: "a", label: "A", configDir: "~/.claude/identities/a" }] });

test.skipIf(process.platform !== "linux" || !rsync)("a no-change ais sync moves near zero bytes end to end", async () => {
  const { local, remote, run } = await harness();

  // 5 MB of plain profile data plus a 40 MB Crush database on the local side.
  const profile = join(local, ".claude", "identities", "a");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "history.jsonl"), `${"j".repeat(1_000_000)}\n`);
  for (let i = 0; i < 4; i++) await writeFile(join(profile, `blob${i}.bin`), Buffer.alloc(1_000_000, i));
  await writeCrushFixture(local, 40_000_000);
  await writeCrushFixture(remote, 10); // the remote has its own machine-local project index
  await writeFile(join(local, ".claude", "identities.json"), claudeRegistry);

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
  const total = steady.entries.filter((e) => !e.argv.startsWith("rsync")).reduce((sum, e) => sum + e.rchar + e.wchar, 0);
  // Local and remote ais processes together. About 4 MB of each process is runtime start-up;
  // re-snapshotting the 40 MB database alone would read and write over 120 MB.
  expect(total).toBeLessThan(30_000_000);
  expect(steady.entries.some((e) => e.argv.includes("merge-zai-snapshot"))).toBe(false);
  expect((await Bun.file(join(profile, "history.jsonl")).stat()).mtimeMs).toBe(before.mtimeMs);
}, 120_000);

test.skipIf(process.platform !== "linux" || !rsync)("conflict-prone trees converge and a no-change run stays cheap on both sides", async () => {
  const { local, remote, run } = await harness();
  const MB = 1_000_000;
  const T = 1_700_000_000;
  const a = ".claude/identities/a";
  const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `{"t":"${tag}${i}","pad":"${"p".repeat(1000)}"}\n`).join("");
  await put(local, ".claude/identities.json", claudeRegistry);
  await put(remote, ".claude/identities.json", claudeRegistry);
  await writeCrushFixture(local, 2 * MB);
  await writeCrushFixture(remote, 10);

  // Histories appended on both hosts: the union holds the same lines in a different order on each.
  await put(local, `${a}/projects/p/s1.jsonl`, lines("c", 2000) + lines("l", 1000), T + 10);
  await put(remote, `${a}/projects/p/s1.jsonl`, lines("c", 2000) + lines("r", 1000), T + 20);
  // Identical bytes with different mtimes, and files that exist on one host only.
  await put(local, `${a}/projects/p/s2.jsonl`, lines("s", 6000), T + 10);
  await put(remote, `${a}/projects/p/s2.jsonl`, lines("s", 6000), T + 20);
  await put(local, `${a}/only-local.bin`, Buffer.alloc(8 * MB, 1), T + 5);
  await put(remote, `${a}/only-remote.bin`, Buffer.alloc(8 * MB, 2), T + 5);
  // Per-identity state that both hosts rewrite, in both mtime orders.
  await put(local, `${a}/.claude.json`, JSON.stringify({ n: 1, onlyLocal: true, numStartups: 5, projects: { "/l": 1, "/both": "local" } }), T + 30);
  await put(remote, `${a}/.claude.json`, JSON.stringify({ n: 2, onlyRemote: true, cachedFlags: { f: 1 }, projects: { "/r": 1, "/both": "remote" } }), T + 20);
  await put(local, `${a}/.last-cleanup`, "local", T + 30);
  await put(remote, `${a}/.last-cleanup`, "remote", T + 20);
  // A shared hook that differs between hosts yet carries the very same mtime: a true conflict that must still keep both versions.
  await put(local, ".ais/hooks/x.sh", "#!/bin/sh\necho local\n", T + 10);
  await put(remote, ".ais/hooks/x.sh", "#!/bin/sh\necho remote\n", T + 10);
  // The same unterminated tail on both hosts is not a conflict.
  await put(local, ".grok/identities/g/memtrace/1-2.jsonl", '{"a":1}\n{"b":', T + 10);
  await put(remote, ".grok/identities/g/memtrace/1-2.jsonl", '{"a":1}\n{"b":', T + 10);
  // Per-host process markers and regenerated system skills never travel.
  await put(local, `${a}/sessions/100.json`, "{}", T);
  await put(local, ".codex/identities/c/skills/.system/m.md", "x", T);
  for (let i = 0; i < 200; i++) {
    await put(local, `${a}/small/f${i}.txt`, `file ${i}`, T + 1);
    await put(remote, `${a}/small/f${i}.txt`, `file ${i}`, T + 2 + (i % 2));
  }

  const first = await run({ AIS_SYNC_IO_TRACE: "1" });
  expect(first.exitCode).toBe(0);
  // The per-phase accounting names local and relayed remote phases.
  expect(first.text).toMatch(/AIS sync io local pull-rsync: rchar=\S+ wchar=\S+ read_bytes=\S+ write_bytes=\S+ \d+ms staged=\d+ files/);
  expect(first.text).toMatch(/AIS sync io remote fake-host:profile-merge: /);
  for (const home of [local, remote]) {
    // Both sides keep every line of the diverged history.
    const history = await readFile(join(home, a, "projects/p/s1.jsonl"), "utf8");
    expect(history).toContain('"l999"');
    expect(history).toContain('"r999"');
    expect((await Bun.file(join(home, a, "only-local.bin")).stat()).size).toBe(8 * MB);
    expect((await Bun.file(join(home, a, "only-remote.bin")).stat()).size).toBe(8 * MB);
  }
  // Equal size and mtime on both hosts: rsync's quick check stops re-staging the history.
  const seconds = async (home: string) => Math.floor((await Bun.file(join(home, a, "projects/p/s1.jsonl")).stat()).mtimeMs / 1000);
  expect(await seconds(local)).toBe(await seconds(remote));
  expect(await readFile(join(local, ".ais/hooks/x.sh"), "utf8")).toBe(await readFile(join(remote, ".ais/hooks/x.sh"), "utf8"));
  expect(JSON.parse(await readFile(join(remote, a, ".claude.json"), "utf8"))).toEqual({ n: 1, onlyLocal: true, numStartups: 5, cachedFlags: { f: 1 }, projects: { "/l": 1, "/both": "local" } });
  expect(await readFile(join(remote, a, ".claude.json"), "utf8")).toBe(await readFile(join(local, a, ".claude.json"), "utf8"));
  expect(await readFile(join(remote, a, ".last-cleanup"), "utf8")).toBe("local");
  expect(await Bun.file(join(remote, a, "sessions/100.json")).exists()).toBe(false);
  expect(await Bun.file(join(remote, ".codex/identities/c/skills/.system/m.md")).exists()).toBe(false);
  // The real conflict is preserved: the losing hook version survives under merge-conflicts on the host that lost it.
  const preserved = [];
  for (const home of [local, remote]) {
    preserved.push(...(await Array.fromAsync(new Bun.Glob("merge-conflicts/**/.ais/hooks/x.sh").scan({ cwd: join(home, ".ais", "remote-cache"), absolute: true, dot: true }))));
  }
  expect(preserved.length).toBe(1);

  // Conflicts converge to zero by the third run.
  const second = await run();
  const third = await run();
  expect([second.exitCode, third.exitCode]).toEqual([0, 0]);
  expect(third.text).not.toContain("preserved");

  // A no-change run reads and writes only metadata on BOTH sides (tracing off: no io lines).
  const steady = await run();
  expect(steady.exitCode).toBe(0);
  expect(steady.text).not.toContain("preserved");
  expect(steady.text).not.toContain("AIS sync io");
  const bytes = (e: IoEntry) => e.rchar + e.wchar;
  // The local `sync now` entry already includes its reaped children (rsync, ssh); each remote ais process
  // costs about 4 MB of runtime start-up. The ~40 MB of history this fixture used to re-stage would show here.
  const localEntry = steady.entries.find((e) => e.argv === "sync now")!;
  const remoteAis = steady.entries.filter((e) => e.argv.startsWith("sync ") && e.argv !== "sync now");
  // The fake ssh runs the remote tail-plan and merge as children, so their start-up (about 5 MB each) lands here too.
  expect(bytes(localEntry)).toBeLessThan(50_000_000);
  expect(localEntry.write_bytes).toBeLessThan(1_000_000);
  expect(remoteAis.length).toBeGreaterThan(0);
  for (const e of remoteAis) {
    expect(bytes(e)).toBeLessThan(10_000_000);
    expect(e.write_bytes).toBeLessThan(1_000_000);
  }
  for (const e of steady.entries.filter((e) => e.argv.startsWith("rsync"))) expect(bytes(e)).toBeLessThan(1_000_000);
}, 300_000);

const sizeOf = async (path: string) => (await Bun.file(path).stat()).size;
const human = (text: string) => {
  const m = /^(\d+(?:\.\d+)?)([KMG]?)$/.exec(text)!;
  return Number(m[1]) * ({ "": 1, K: 1e3, M: 1e6, G: 1e9 } as Record<string, number>)[m[2]!]!;
};
/** Bytes the bulk transfer staged for the named phase, from the AIS_SYNC_IO_TRACE line. */
const stagedBytes = (text: string, phase: string) => human(new RegExp(`${phase}: .*staged=\\d+ files (\\S+)`).exec(text)![1]!);

test.skipIf(process.platform !== "linux" || !rsync)("an appended 50 MB history moves and writes only its new bytes in both directions; diverged histories keep every line", async () => {
  const { local, remote, run } = await harness();
  const MB = 1_000_000;
  const T = 1_700_000_000;
  const a = ".claude/identities/a";
  const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `{"t":"${tag}${i}","pad":"${"p".repeat(990)}"}\n`).join("");
  await put(local, ".claude/identities.json", claudeRegistry);
  await put(remote, ".claude/identities.json", claudeRegistry);
  const big = `${a}/projects/p/big.jsonl`;
  const forked = `${a}/projects/p/forked.jsonl`;
  await put(local, big, lines("b", 50_000), T);
  await put(local, forked, lines("f", 3000), T);

  // Run 1 copies the 50 MB history whole (the remote has none); run 2 settles mtimes.
  for (let i = 0; i < 2; i++) expect((await run()).exitCode).toBe(0);
  const first = await sizeOf(join(local, big));
  expect(await sizeOf(join(remote, big))).toBe(first);

  // Local appends 4 MB: the remote must receive and write about that much, not 54 MB.
  await appendFile(join(local, big), lines("local", 4000));
  // Both hosts append different lines to the other history: a diverged prefix falls back to full staging.
  await appendFile(join(local, forked), lines("fl", 500));
  await appendFile(join(remote, forked), lines("fr", 400));
  const push = await run({ AIS_SYNC_IO_TRACE: "1" });
  expect(push.exitCode).toBe(0);
  expect(await sizeOf(join(remote, big))).toBe(await sizeOf(join(local, big)));
  expect(await sizeOf(join(local, big))).toBeGreaterThan(first + 3 * MB);
  expect(await readFile(join(remote, big), "utf8")).toBe(await readFile(join(local, big), "utf8"));
  // Every rsync wrote about the appended bytes (plus the diverged 4 MB history, staged whole), never the 54 MB.
  // ais processes are not bounded: the open-file ownership lookup (lsof, a reaped child) adds machine-dependent I/O.
  for (const e of push.entries.filter((e) => e.argv.startsWith("rsync"))) expect({ argv: e.argv, wchar: e.wchar < 12 * MB }).toEqual({ argv: e.argv, wchar: true });
  expect(stagedBytes(push.text, "pull-rsync")).toBeLessThan(8 * MB);
  for (const home of [local, remote]) {
    const text = await readFile(join(home, forked), "utf8");
    const set = new Set(text.split("\n").filter(Boolean));
    expect(set.size).toBe(3900);
    expect(text).toContain('"fl499"');
    expect(text).toContain('"fr399"');
  }

  // Remote appends 3 MB: pulled as a tail the same way.
  await appendFile(join(remote, big), lines("remote", 3000));
  const pull = await run({ AIS_SYNC_IO_TRACE: "1" });
  expect(pull.exitCode).toBe(0);
  expect(await sizeOf(join(local, big))).toBe(await sizeOf(join(remote, big)));
  expect(await readFile(join(local, big), "utf8")).toBe(await readFile(join(remote, big), "utf8"));
  expect(stagedBytes(pull.text, "pull-rsync")).toBeLessThan(8 * MB);
  for (const e of pull.entries.filter((e) => e.argv.startsWith("rsync"))) expect({ argv: e.argv, wchar: e.wchar < 12 * MB }).toEqual({ argv: e.argv, wchar: true });

  // Nothing changed since: the next run moves almost nothing and keeps both copies byte-identical.
  const steady = await run();
  expect(steady.exitCode).toBe(0);
  expect(steady.text).not.toContain("preserved");
  for (const e of steady.entries) expect(e.wchar).toBeLessThan(10 * MB);
  expect(await sizeOf(join(remote, big))).toBe(await sizeOf(join(local, big)));
}, 600_000);
