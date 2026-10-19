import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const dispatchModule = new URL("../../src/cli/sync/dispatch.ts", import.meta.url).pathname;

async function receiverScenario(script: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ais-sync-receiver-"));
  homes.push(home);
  // Isolate HOME and filesystem instrumentation from every other sync test.
  const child = Bun.spawn([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { join, dirname } from "node:path";
    const filesystem = { ...await import("node:fs/promises") };
    const home = process.env.HOME;
    const state = join(home, ".ais", "remote-cache");
    const rel = ".codex/identities/SYNTHETIC_FIXTURE_identity/history.jsonl";
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const first = join(state, "profile-incoming", firstId);
    const second = join(state, "profile-incoming", secondId);
    const deferred = join(state, "merge-conflicts", "deferred", "incoming", rel);
    const firstBytes = "SYNTHETIC_FIXTURE_first_partial";
    const secondBytes = "SYNTHETIC_FIXTURE_second_partial";
    const flags = { tool: "codex", identity: "SYNTHETIC_FIXTURE_identity" };
    async function stage(root, bytes) {
      await filesystem.mkdir(dirname(join(root, rel)), { recursive: true });
      await Bun.write(join(root, rel), bytes);
    }
    ${script}
  `], {
    env: { ...process.env, HOME: home, AIS_SYNC_CONFIG: join(home, "sync.json") },
    stdout: "pipe", stderr: "pipe", timeout: 20_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr, stdout: exitCode ? stdout : "" }).toEqual({ exitCode: 0, stderr: "", stdout: "" });
}

test("concurrent receivers retain both deferrals and hold flock until durable staging deletion", async () => {
  await receiverScenario(`
    await stage(first, firstBytes);
    await stage(second, secondBytes);
    const flushing = Promise.withResolvers();
    const allowFlush = Promise.withResolvers();
    const secondLockAttempt = Promise.withResolvers();
    const deleting = Promise.withResolvers();
    const allowDelete = Promise.withResolvers();
    let lockAttempts = 0;
    let archiveWrites = 0;
    let fileFlushes = 0;
    let directoryFlushes = 0;
    const removed = [];
    mock.module("node:fs/promises", () => ({
      ...filesystem,
      async open(path, ...args) {
        const handle = await filesystem.open(path, ...args);
        if (path === join(state, "profile-merge.lock")) {
          if (++lockAttempts === 2) secondLockAttempt.resolve();
        }
        const temporary = path.endsWith(".tmp");
        if (temporary) archiveWrites++;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (temporary && archiveWrites === 1) {
            flushing.resolve();
            await allowFlush.promise;
          }
          await sync();
          if (temporary) fileFlushes++;
          if (path === home) directoryFlushes++;
        };
        return handle;
      },
      async rm(path, options) {
        if (path === first) {
          assert.equal(fileFlushes, 1);
          assert.equal(directoryFlushes, 1);
          assert.equal(await Bun.file(deferred).text(), firstBytes);
          deleting.resolve();
          await allowDelete.promise;
        } else if (path === second) {
          // Both the displaced first version and the new second version have
          // been flushed, including their directory entries, before deletion.
          assert.equal(fileFlushes, 3);
          assert.equal(directoryFlushes, 3);
          assert.equal(await Bun.file(deferred).text(), secondBytes);
        }
        removed.push(path);
        return filesystem.rm(path, options);
      },
    }));
    const { runSyncCommand } = await import(${JSON.stringify(dispatchModule)});
    const firstMerge = runSyncCommand(["merge-profile-snapshot", firstId], flags);
    await flushing.promise;
    const secondMerge = runSyncCommand(["merge-profile-snapshot", secondId], flags);
    await secondLockAttempt.promise;
    assert.equal(archiveWrites, 1);
    assert.deepEqual(removed, []);
    assert(await Bun.file(join(first, rel)).exists());
    assert(await Bun.file(join(second, rel)).exists());
    allowFlush.resolve();
    await deleting.promise;
    assert.equal(archiveWrites, 1);
    assert.deepEqual(removed, []);

    // A separate process must also fail to take the real kernel flock while
    // the receiver is paused at staging deletion.
    const probe = Bun.spawn([process.execPath, "--eval", \`
      import { dlopen, FFIType } from "bun:ffi";
      import { openSync, closeSync } from "node:fs";
      const symbols = { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } };
      const candidates = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"]
        : [["libc", "so", "6"].join("."), ["libc", "so"].join(".")];
      let library;
      try { library = dlopen(candidates[0], symbols); }
      catch { library = dlopen(candidates[1], symbols); }
      const fd = openSync(process.env.SYNTHETIC_FIXTURE_LOCK, "a");
      const result = library.symbols.flock(fd, 2 | 4);
      closeSync(fd);
      library.close();
      process.exit(result === 0 ? 1 : 0);
    \`], {
      env: { ...process.env, SYNTHETIC_FIXTURE_LOCK: join(state, "profile-merge.lock") },
      stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    assert.equal(await probe.exited, 0, await new Response(probe.stderr).text());
    allowDelete.resolve();
    await Promise.all([firstMerge, secondMerge]);
    assert.deepEqual(removed, [first, second]);
    assert.equal(await Bun.file(join(first, rel)).exists(), false);
    assert.equal(await Bun.file(join(second, rel)).exists(), false);
    const unresolved = join(state, "merge-conflicts", "unresolved");
    const hashes = await filesystem.readdir(unresolved);
    assert.equal(hashes.length, 1);
    assert.equal(await Bun.file(join(unresolved, hashes[0], "incoming", rel)).text(), firstBytes);
    assert.equal(await Bun.file(deferred).text(), secondBytes);
  `);
}, 25_000);

for (const failedFlush of ["file", "directory"]) {
  test(`a failed archive ${failedFlush} flush retains receiver staging and releases the lock for retry`, async () => {
    await receiverScenario(`
      await stage(first, firstBytes);
      let failed = false;
      let directoryFlushed = false;
      mock.module("node:fs/promises", () => ({
        ...filesystem,
        async open(path, ...args) {
          const handle = await filesystem.open(path, ...args);
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (!failed && (${JSON.stringify(failedFlush)} === "file" ? path.endsWith(".tmp") : path === home)) {
              failed = true;
              throw new Error("SYNTHETIC_FIXTURE_flush_failure");
            }
            await sync();
            if (path === home) directoryFlushed = true;
          };
          return handle;
        },
        async rm(path, options) {
          assert(directoryFlushed);
          return filesystem.rm(path, options);
        },
      }));
      const { runSyncCommand } = await import(${JSON.stringify(dispatchModule)});
      await assert.rejects(runSyncCommand(["merge-profile-snapshot", firstId], flags), /SYNTHETIC_FIXTURE_flush_failure/);
      assert(failed);
      assert(await Bun.file(join(first, rel)).exists());
      await runSyncCommand(["merge-profile-snapshot", firstId], flags);
      assert.equal(await Bun.file(join(first, rel)).exists(), false);
      assert.equal(await Bun.file(deferred).text(), firstBytes);
    `);
  }, 25_000);
}
