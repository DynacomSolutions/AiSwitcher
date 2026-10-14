import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End to end: a real shim entrypoint (bun run AND bun build --compile) against
// a fake "real" CLI. After execve the fake must be a direct child of whoever
// started the shim (no Bun parent), keep the shim's PID, and be unaffected by
// the detached sidecar being killed.

const REPO = join(import.meta.dir, "..");
const dirs: string[] = [];
const killers: number[] = [];
const linuxOnly = process.platform === "linux" ? test : test.skip;

afterEach(() => {
  for (const pid of killers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let compiledDir: string;
let compiledShim: string;
beforeAll(async () => {
  compiledDir = mkdtempSync(join(tmpdir(), "ais-execve-bin-"));
  compiledShim = join(compiledDir, "claude");
  const proc = Bun.spawn(["bun", "build", "--compile", join(REPO, "src", "claude.ts"), "--outfile", compiledShim], {
    cwd: REPO,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}, 120_000);
afterAll(() => rmSync(compiledDir, { recursive: true, force: true }));

function setup(options: { pool?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ais-execve-"));
  dirs.push(home);
  const realBin = join(home, "real-bin");
  const shimDir = join(home, "shim-bin");
  mkdirSync(realBin, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const member = (name: string) => ({ name, label: name, configDir: join(home, name) });
  writeFileSync(
    join(home, ".claude", "identities.json"),
    JSON.stringify({
      version: 1,
      identities: options.pool
        ? [member("a"), member("b"), { ...member("pool"), swapPool: { accounts: ["a", "b"], active: "a", auto: true } }]
        : [{ name: "acct-a", label: "A", configDir: join(home, "a") }],
    }),
  );
  const out = join(home, "fake.out");
  const release = join(home, "release");
  const syncLog = join(home, "sync.log");
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  script(
    join(realBin, "claude"),
    `{
echo "pid=$$"; echo "ppid=$PPID"; echo "session=$AI_PROFILE_SWITCHER_SESSION"; echo "args=$*"
grep -E '^Sig(Ign|Blk)' /proc/$$/status | tr -d '\\t' | tr ':' '='
fds=; for fd in 3 4 5 6 7 8 9; do [ -e /proc/$$/fd/$fd ] && fds="$fds$fd,"; done; echo "fds=$fds"
} > "$FAKE_OUT.tmp"
mv "$FAKE_OUT.tmp" "$FAKE_OUT"
while [ ! -e "$FAKE_RELEASE" ]; do sleep 0.05; done
exit 7`,
  );
  script(join(shimDir, "ais"), `echo "$*" >> "${syncLog}"`);
  const env = {
    PATH: `${realBin}:${process.env.PATH ?? ""}`,
    HOME: home,
    AI_PROFILE_SWITCHER_REAL_BIN_DIR: realBin,
    AI_PROFILE_SWITCHER_SHIM_DIR: shimDir,
    FAKE_OUT: out,
    FAKE_RELEASE: release,
    FAKE_MARK_DIR: home,
  };
  return { home, env, out, release, syncLog };
}

async function waitFor<T>(probe: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = probe();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for condition");
}

function findSidecar(home: string): number | undefined {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.includes("__session-sidecar") && readFileSync(`/proc/${entry}/environ`, "utf8").includes(`HOME=${home}\0`)) {
        return Number(entry);
      }
    } catch {}
  }
  return undefined;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};

const sessionOf = (pid: number) => {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[3]);
};

const parse = (path: string) =>
  Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe.each([
  ["bun run src/claude.ts", () => [process.execPath, join(REPO, "src", "claude.ts")]],
  ["compiled shim", () => [compiledShim]],
])("shim execve (%s)", (_name, command) => {
  linuxOnly("the real tool replaces the shim: same PID, caller as parent, clean process state", async () => {
    const { home, env, out, release } = setup();
    const shim = Bun.spawn([...command(), "--identity=acct-a", "hello", "world"], {
      cwd: home,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    killers.push(shim.pid);
    const fake = await waitFor(() => existsSync(out) && parse(out));

    expect(Number(fake.pid)).toBe(shim.pid); // execve kept the PID
    expect(Number(fake.ppid)).toBe(process.pid); // no Bun parent in between
    expect(fake.session).toBe("acct-a");
    expect(fake.args).toContain(" hello world ");
    // Nothing Bun-specific leaks across exec: no ignored SIGPIPE/SIGXFSZ (Bun ignores both)
    // and no stray descriptors. (bash itself ignores SIGQUIT and blocks SIGCHLD, so the
    // full masks are not compared.)
    expect(BigInt(`0x${fake.SigIgn}`) & 0x1001000n).toBe(0n);
    expect((fake.fds ?? "").split(",").filter(Boolean).map(Number).filter((fd) => fd >= 3)).toEqual([]);

    writeFileSync(release, "");
    expect(await shim.exited).toBe(7);
  }, 60_000);

  linuxOnly("the sidecar is detached, never touches the real tool when killed, and runs the post-exit sync", async () => {
    const { home, env, out, release } = setup();
    const shim = Bun.spawn([...command(), "--identity=acct-a"], { cwd: home, env, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    killers.push(shim.pid);
    await waitFor(() => existsSync(out));
    const sidecar = await waitFor(() => findSidecar(home));
    killers.push(sidecar);

    const raw = readFileSync(`/proc/${sidecar}/stat`, "utf8");
    const [, ppid, , session, tty] = raw.slice(raw.lastIndexOf(")") + 2).split(" ").map(Number);
    expect(ppid).not.toBe(shim.pid); // double-forked: not a child (zombie, signal target) of the tool
    expect(session).not.toBe(sessionOf(shim.pid)); // own session, away from the caller's terminal
    expect(tty).toBe(0); // no controlling terminal
    for (const fd of [0, 1, 2]) expect(readlinkSync(`/proc/${sidecar}/fd/${fd}`)).toBe("/dev/null");

    process.kill(sidecar, "SIGKILL");
    await waitFor(() => !alive(sidecar));
    await Bun.sleep(300);
    expect(alive(shim.pid)).toBe(true);

    writeFileSync(release, "");
    expect(await shim.exited).toBe(7);
  }, 60_000);

  linuxOnly("a live sidecar runs the launch and post-exit sync when the tool exits", async () => {
    const { home, env, out, release, syncLog } = setup();
    const shim = Bun.spawn([...command(), "--identity=acct-a"], { cwd: home, env, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    killers.push(shim.pid);
    await waitFor(() => existsSync(out));
    await waitFor(() => existsSync(syncLog)); // launch-time sync
    writeFileSync(release, "");
    await shim.exited;
    const lines = await waitFor(() => {
      const text = existsSync(syncLog) ? readFileSync(syncLog, "utf8").trim().split("\n") : [];
      return text.some((l) => l.includes("--wait")) && text;
    });
    expect(lines.every((l) => l.startsWith("sync background"))).toBe(true);
    expect(lines.at(-1)).toContain("--identity=acct-a");
  }, 60_000);
});

describe("shim execve and swap pools", () => {
  linuxOnly("a pool swap that outlives the launch-check budget finishes before the exec cuts the process", async () => {
    const { home, env, out, release } = setup({ pool: true });
    const shim = Bun.spawn([process.execPath, join(REPO, "test", "fixtures", "pool-slow-claude.ts"), "--identity=pool"], {
      cwd: home,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    killers.push(shim.pid);
    await waitFor(() => existsSync(out), 40_000); // the fake tool only starts once the swap is done
    expect(existsSync(join(home, "swap-1"))).toBe(true);
    expect(existsSync(join(home, "swap-2"))).toBe(true);
    const registry = JSON.parse(readFileSync(join(home, ".claude", "identities.json"), "utf8"));
    expect(registry.identities.find((i: { name: string }) => i.name === "pool").swapPool.active).toBe("b");
    writeFileSync(release, "");
    expect(await shim.exited).toBe(7);
  }, 60_000);
});

describe("shim execve and Herdr title ownership", () => {
  // The pi extension disables titles when AIS_HERDR_TITLE_OWNER_PID is set to
  // a PID other than its own. After execve the real tool has the shim's PID,
  // so a nested launch must not hand it its own PID as the owner.
  linuxOnly("a nested pi never receives its own PID as the title owner", async () => {
    const { home, env, out, release } = setup();
    mkdirSync(join(home, ".pi"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "identities.json"),
      JSON.stringify({ version: 1, identities: [{ name: "acct-a", label: "A", configDir: join(home, "a") }] }),
    );
    const fakePi = join(home, "real-bin", "pi");
    writeFileSync(
      fakePi,
      `#!/bin/sh\n{ echo "pid=$$"; echo "owner=$AIS_HERDR_TITLE_OWNER_PID"; } > "$FAKE_OUT.tmp"\nmv "$FAKE_OUT.tmp" "$FAKE_OUT"\nwhile [ ! -e "$FAKE_RELEASE" ]; do sleep 0.05; done\n`,
    );
    chmodSync(fakePi, 0o755);
    const shim = Bun.spawn([process.execPath, join(REPO, "src", "pi.ts")], {
      cwd: home,
      env: { ...env, AI_PROFILE_SWITCHER_SESSION: "acct-a", PI_CODING_AGENT_DIR: join(home, "a") },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    killers.push(shim.pid);
    const fake = await waitFor(() => existsSync(out) && parse(out));
    expect(Number(fake.pid)).toBe(shim.pid);
    expect(fake.owner).toMatch(/^\d+$/);
    expect(fake.owner).not.toBe(fake.pid);
    writeFileSync(release, "");
    await shim.exited;
  }, 60_000);
});
