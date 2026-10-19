import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod, rename, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const script = new URL("../../image/lib/ais-outbox", import.meta.url).pathname;
const fixtureCredential = "SYNTHETIC_FIXTURE_age_probe";
const expectBin = process.env.AIS_EXPECT_BIN ?? Bun.which("expect") ?? "";

function octal(value: number, width: number): Uint8Array {
  return new TextEncoder().encode(`${value.toString(8).padStart(width - 1, "0")}\0`);
}

function tarFile(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(octal(0o600, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(content.byteLength, 12), 124);
  header.set(octal(1_798_000_000, 12), 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.set(new TextEncoder().encode("ustar\0"), 257);
  header.set(new TextEncoder().encode("00"), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ";
  header.set(new TextEncoder().encode(checksum), 148);
  const padded = new Uint8Array(Math.ceil(content.byteLength / 512) * 512);
  padded.set(content);
  const result = new Uint8Array(header.byteLength + padded.byteLength);
  result.set(header);
  result.set(padded, header.byteLength);
  return result;
}

function tarConcat(...chunks: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024);
  const all = [...chunks, end];
  const result = new Uint8Array(all.reduce((sum, item) => sum + item.byteLength, 0));
  let offset = 0;
  for (const item of all) { result.set(item, offset); offset += item.byteLength; }
  return result;
}

async function fixtureTar(seq: number, kind: "inbox" | "outbox" = "outbox"): Promise<Uint8Array> {
  const manifest = new TextEncoder().encode(JSON.stringify({
    version: 1, seq, createdAt: "2026-10-19T00:00:00.000Z", kind, entries: [], lastInboxSeq: 7,
  }));
  return tarConcat(tarFile("manifest.json", manifest));
}

async function harness(): Promise<{ root: string; path: string; tar: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "ais-exchange-probe-"));
  const path = join(root, "bin");
  await mkdir(path);
  await mkdir(join(root, "run"));
  await mkdir(join(root, "persist"));
  await mkdir(join(root, "inbox"));
  await mkdir(join(root, "outbox"));
  const tar = await fixtureTar(1);
  await writeFile(join(root, "fixture.tar"), tar);
  const helpers: Record<string, string> = {
    keyctl: `#!/bin/bash\ncase $1 in search) printf '73\\n' ;; pipe) [[ \${AIS_TEST_KEY_PIPE_FAIL:-0} == 1 ]] && exit 71; printf '${fixtureCredential}' ;; *) exit 64 ;; esac\n`,
    age: `#!/bin/bash\npassphrase=$(cat <&3) || exit 65\n[[ $passphrase == '${fixtureCredential}' ]] || exit 66\nif [[ \${AIS_TEST_AGE_PARTIAL_FAIL:-0} == 1 ]]; then head -c 512; exit 67; fi\nif [[ \${AIS_TEST_AGE_FAIL:-0} == 1 ]]; then exit 67; fi\nif [[ \${AIS_TEST_AGE_OVERFLOW:-0} == 1 ]]; then head -c 67108865 /dev/zero; else cat; fi\n`,
    sync: `#!/bin/bash\nprintf '%s\\n' "$*" >>"$AIS_TEST_SYNC_LOG"\n`,
    runuser: `#!/bin/bash\n[[ $1 == -u && $2 == agent && $3 == -- ]] || exit 68\nshift 3\nif [[ \${AIS_TEST_COLLECT_OVERFLOW:-0} == 1 ]]; then head -c 33554433 /dev/zero; else exec "$@"; fi\n`,
    ais: `#!/bin/bash\nprintf '%s\\n' "$@" >>"$AIS_TEST_ARGS"\ncase "$2" in write-outbox) cat "$AIS_TEST_FIXTURE_TAR" ;; apply-inbox) cat >"$AIS_TEST_APPLIED"; code=\${AIS_TEST_APPLY_STATUS:-0}; if [[ $code == 0 ]]; then printf 'AIS-LIVE: stage=inbox status=ok applied=1 skipped=0\\n' >&2; fi; exit "$code" ;; *) exit 69 ;; esac\n`,
  };
  for (const [name, body] of Object.entries(helpers)) {
    const file = join(path, name);
    await writeFile(file, body);
    await chmod(file, 0o700);
  }
  return { root, path, tar };
}

async function run(root: string, path: string, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", script, ...args], {
    env: {
      ...process.env,
      PATH: `${path}:/usr/bin:/bin`,
      AIS_LIVE_TEST_MODE: "1",
      AIS_LIVE_TEST_ROOT: root,
      AIS_TEST_FIXTURE_TAR: join(root, "fixture.tar"),
      AIS_TEST_APPLIED: join(root, "applied.tar"),
      AIS_TEST_ARGS: join(root, "ais-args"),
      AIS_TEST_SYNC_LOG: join(root, "sync.log"),
      ...extra,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("root exchange wrapper protocol", () => {
  test("authenticates to a private temporary tar before invoking the agent apply command", async () => {
    const { root, path } = await harness();
    const inbox = await fixtureTar(4, "inbox");
    await writeFile(join(root, "inbox", "BUNDLE-4.AGE"), inbox);
    const result = await run(root, path, ["apply-inbox"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("stage=inbox status=ok applied=");
    expect(Buffer.from(await readFile(join(root, "applied.tar")))).toEqual(Buffer.from(inbox));
    expect((await readFile(join(root, "ais-args"), "utf8"))).toContain("--last-inbox-seq=0");
    expect(JSON.parse(await readFile(join(root, "persist", "ais-live-exchange", "applied-inbox-seq.json"), "utf8")).seq).toBe(4);
    expect(await readdir(join(root, "run", "ais-live-exchange"))).toEqual(["exchange.lock"]);
  });

  test("does not invoke the agent or retain plaintext when age rejects an inbox", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "inbox", "bundle-5.age"), await fixtureTar(5, "inbox"));
    const result = await run(root, path, ["apply-inbox"], { AIS_TEST_AGE_FAIL: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("status=rejected reason=authentication");
    await expect(readFile(join(root, "applied.tar"))).rejects.toThrow();
    expect(await readdir(join(root, "run", "ais-live-exchange"))).toEqual(["exchange.lock"]);
    await expect(readFile(join(root, "persist", "ais-live-exchange", "applied-inbox-seq.json"))).rejects.toThrow();
  });

  test("does not apply partially emitted plaintext when age authentication fails", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "inbox", "bundle-5.age"), await fixtureTar(5, "inbox"));
    const result = await run(root, path, ["apply-inbox"], { AIS_TEST_AGE_PARTIAL_FAIL: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("status=rejected reason=authentication");
    await expect(readFile(join(root, "applied.tar"))).rejects.toThrow();
    expect(await readdir(join(root, "run", "ais-live-exchange"))).toEqual(["exchange.lock"]);
    await expect(readFile(join(root, "persist", "ais-live-exchange", "applied-inbox-seq.json"))).rejects.toThrow();
  });

  test("bounds authenticated plaintext before invoking the agent", async () => {
    const { root, path, tar } = await harness();
    await writeFile(join(root, "inbox", "bundle-5.age"), await fixtureTar(5, "inbox"));
    const result = await run(root, path, ["apply-inbox"], { AIS_TEST_AGE_OVERFLOW: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason=size");
    await expect(readFile(join(root, "applied.tar"))).rejects.toThrow();
    expect(await readdir(join(root, "run", "ais-live-exchange"))).toEqual(["exchange.lock"]);
  });

  test("publishes only a completed encrypted file and removes older sequence files", async () => {
    const { root, path } = await harness();
    const firstTar = await fixtureTar(1);
    await writeFile(join(root, "fixture.tar"), firstTar);
    const first = await run(root, path, ["write-outbox"]);
    expect(first.exitCode, first.stderr).toBe(0);
    await rename(join(root, "outbox", "bundle-1.age"), join(root, "outbox", "BUNDLE-1.AGE"));
    const newerTar = await fixtureTar(2);
    await writeFile(join(root, "fixture.tar"), newerTar);
    const result = await run(root, path, ["write-outbox"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("status=written seq=2");
    expect(await readdir(join(root, "outbox"))).toEqual(["bundle-2.age"]);
    expect(Buffer.from(await readFile(join(root, "outbox", "bundle-2.age")))).toEqual(Buffer.from(newerTar));
  });

  test("never publishes a partial output when encryption fails", async () => {
    const { root, path } = await harness();
    const result = await run(root, path, ["write-outbox"], { AIS_TEST_AGE_FAIL: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason=encryption");
    expect(await readdir(join(root, "outbox"))).toEqual([]);
    expect(await readdir(join(root, "run", "ais-live-exchange"))).toEqual(["exchange.lock"]);
  });

  test("rejects a failed keyring pipe and leaves no outbox file", async () => {
    const { root, path } = await harness();
    const result = await run(root, path, ["write-outbox"], { AIS_TEST_KEY_PIPE_FAIL: "1" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("reason=key-unavailable");
    expect(await readdir(join(root, "outbox"))).toEqual([]);
  });

  test("bounds agent tar output during collection", async () => {
    const { root, path } = await harness();
    const result = await run(root, path, ["write-outbox"], { AIS_TEST_COLLECT_OVERFLOW: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason=size");
    expect(await readdir(join(root, "outbox"))).toEqual([]);
    expect(await readdir(join(root, "run", "ais-live-exchange"))).toEqual(["exchange.lock"]);
  });

  test("bounds encrypted output before atomically publishing it", async () => {
    const { root, path } = await harness();
    const result = await run(root, path, ["write-outbox"], { AIS_TEST_AGE_OVERFLOW: "1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason=encryption");
    expect(await readdir(join(root, "outbox"))).toEqual([]);
    expect(await readdir(join(root, "run", "ais-live-exchange"))).toEqual(["exchange.lock"]);
  });

  test("rejects a manifest sequence above the safe integer range", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "fixture.tar"), await fixtureTar(9_007_199_254_740_992));
    const result = await run(root, path, ["write-outbox"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason=manifest");
    expect(await readdir(join(root, "outbox"))).toEqual([]);
  });

  test("defers clock or console conflicts using the CLI exit contract", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "inbox", "bundle-6.age"), await fixtureTar(6, "inbox"));
    const result = await run(root, path, ["apply-inbox"], { AIS_TEST_APPLY_STATUS: "2" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("status=deferred reason=clock-or-conflict");
    await expect(readFile(join(root, "persist", "ais-live-exchange", "applied-inbox-seq.json"))).rejects.toThrow();
  });

  test("does not advance applied highwater after a failed merge", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "inbox", "bundle-8.age"), await fixtureTar(8, "inbox"));
    const result = await run(root, path, ["apply-inbox"], { AIS_TEST_APPLY_STATUS: "1" });
    expect(result.exitCode).toBe(1);
    await expect(readFile(join(root, "persist", "ais-live-exchange", "applied-inbox-seq.json"))).rejects.toThrow();
  });

  test("prevents inbox replay after restoring stale agent-home state", async () => {
    const { root, path } = await harness();
    const state = join(root, "persist", "ais-live-exchange");
    const restoredHomeState = join(root, "home", "agent", ".ais", "live");
    await mkdir(restoredHomeState, { recursive: true });
    await writeFile(join(restoredHomeState, "exchange-state.json"), '{"version":1,"lastInboxSeq":0,"hashes":{}}\n');
    await writeFile(join(root, "inbox", "bundle-9.age"), await fixtureTar(9, "inbox"));
    const first = await run(root, path, ["apply-inbox"]);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("status=ok");
    const invoked = await readFile(join(root, "ais-args"), "utf8");
    expect(invoked).toContain("--last-inbox-seq=0");
    expect(JSON.parse(await readFile(join(state, "applied-inbox-seq.json"), "utf8")).seq).toBe(9);
    // Restoring the agent snapshot cannot restore the root-owned counter.
    await writeFile(join(restoredHomeState, "exchange-state.json"), '{"version":1,"lastInboxSeq":0,"hashes":{}}\n');
    const replay = await run(root, path, ["apply-inbox"]);
    expect(replay.exitCode).toBe(0);
    expect(replay.stderr).toContain("reason=stale");
    expect(await readFile(join(root, "ais-args"), "utf8")).toBe(invoked);
    expect((await readFile(join(state, "applied-inbox-seq.json"), "utf8"))).toContain('"seq":9');
  });

  test("reserves a root outbox sequence across deletion of the visible bundle", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "fixture.tar"), await fixtureTar(1));
    expect((await run(root, path, ["write-outbox"])).exitCode).toBe(0);
    await mkdir(join(root, "home", "agent", ".ais", "live"), { recursive: true });
    await writeFile(join(root, "home", "agent", ".ais", "live", "outbox-seq.json"), '{"version":1,"seq":0}\n');
    await rename(join(root, "outbox", "bundle-1.age"), join(root, "outbox", "BUNDLE-1.AGE"));
    await writeFile(join(root, "fixture.tar"), await fixtureTar(2));
    const result = await run(root, path, ["write-outbox"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("status=written seq=2");
    expect((await readFile(join(root, "ais-args"), "utf8"))).toContain("--seq=2");
    expect(JSON.parse(await readFile(join(root, "persist", "ais-live-exchange", "outbox-seq.json"), "utf8")).seq).toBe(2);
    expect(await readdir(join(root, "outbox"))).toEqual(["bundle-2.age"]);
  });

  test("ignores an unauthenticated maximum-sequence filename on first use", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "outbox", "BUNDLE-9007199254740991.AGE"), "");
    const output = await fixtureTar(1);
    await writeFile(join(root, "fixture.tar"), output);
    const result = await run(root, path, ["write-outbox"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("status=ignored-foreign-files count=1");
    expect(result.stderr).toContain("status=written seq=1");
    expect(JSON.parse(await readFile(join(root, "persist", "ais-live-exchange", "outbox-seq.json"), "utf8")).seq).toBe(1);
    expect(await readFile(join(root, "outbox", "BUNDLE-9007199254740991.AGE"), "utf8")).toBe("");
    await unlink(join(root, "outbox", "BUNDLE-9007199254740991.AGE"));
    await writeFile(join(root, "fixture.tar"), await fixtureTar(2));
    const next = await run(root, path, ["write-outbox"]);
    expect(next.exitCode, next.stderr).toBe(0);
    expect(next.stderr).toContain("status=written seq=2");
    expect(JSON.parse(await readFile(join(root, "persist", "ais-live-exchange", "outbox-seq.json"), "utf8")).seq).toBe(2);
    expect(await readdir(join(root, "outbox"))).toEqual(["bundle-2.age"]);
  });

  test("preserves a same-sequence mixed-case outbox collision", async () => {
    const { root, path } = await harness();
    await writeFile(join(root, "outbox", "BUNDLE-1.AGE"), "SYNTHETIC_FIXTURE_FOREIGN_BUNDLE");
    await writeFile(join(root, "fixture.tar"), await fixtureTar(1));
    const result = await run(root, path, ["write-outbox"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason=collision");
    expect(await readdir(join(root, "outbox"))).toEqual(["BUNDLE-1.AGE"]);
    expect(await readFile(join(root, "outbox", "BUNDLE-1.AGE"), "utf8")).toBe("SYNTHETIC_FIXTURE_FOREIGN_BUNDLE");
  });
});

test.skipIf(!expectBin || !existsSync(expectBin))("Expect matcher accepts pass and rejects failure and EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-exchange-expect-"));
  const source = new URL("../../image/test/exchange.exp", import.meta.url).pathname;
  const driver = join(root, "expect-probe.exp");
  await writeFile(driver, `source {${source}}\nset timeout 5\nspawn -noecho bash -c {printf 'AIS-EXCHANGE-TEST: case=boot status=pass\\n'}\nset channel $spawn_id\nif {[catch {ais_exchange::wait_case $channel boot} message] || $message ne "0"} { error "pass marker failed: $message" }\nwait\nspawn -noecho bash -c {printf 'AIS-EXCHANGE-TEST: case=boot status=fail reason=SYNTHETIC_FIXTURE_expect_failure\\n'}\nset channel $spawn_id\nif {![catch {ais_exchange::wait_case $channel boot} message] || ![string match {*SYNTHETIC_FIXTURE_expect_failure*} $message]} { error "failure marker was not rejected: $message" }\nwait\nspawn -noecho bash -c {exit 0}\nset channel $spawn_id\nif {![catch {ais_exchange::wait_case $channel boot} message] || ![string match {*serial channel closed*} $message]} { error "EOF was not rejected: $message" }\nwait\nspawn -noecho bash -c {printf 'AIS-EXCHANGE-TEST: rejected reason=SYNTHETIC_FIXTURE_expect_rejected\\n'}\nset channel $spawn_id\nif {[catch {ais_exchange::assert_rejected $channel {AIS-EXCHANGE-TEST: rejected reason=SYNTHETIC_FIXTURE_expect_rejected}} message] || $message ne "0"} { error "rejected marker was not observed: $message" }\nwait\nspawn -noecho bash -c {exit 0}\nset channel $spawn_id\nif {![catch {ais_exchange::assert_rejected $channel {AIS-EXCHANGE-TEST: rejected reason=SYNTHETIC_FIXTURE_expect_rejected}} message] || ![string match {*serial channel closed*} $message]} { error "rejected-marker EOF was not rejected: $message" }\nwait\nputs "expect matcher pass/fail/eof verified"\n`);
  const result = spawnSync(expectBin, [driver], {
    encoding: "utf8",
    env: { ...process.env, ...(process.env.AIS_EXPECT_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.AIS_EXPECT_LD_LIBRARY_PATH } : {}) },
  });
  expect(result.error?.message).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("expect matcher pass/fail/eof verified");
});
