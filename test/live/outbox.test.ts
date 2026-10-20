import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBundleTar } from "../../src/live/bundle.ts";
import { writeOutbox } from "../../src/live/outbox.ts";

describe("outbox writer", () => {
  test("records actual configuration hashes, excludes their contents, and reports skipped symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    const outside = await mkdtemp(join(tmpdir(), "ais-live-external-"));
    try {
      await mkdir(join(home, ".claude"), { recursive: true });
      const config = '{"theme":"SYNTHETIC_FIXTURE_THEME"}\n';
      await writeFile(join(home, ".claude", "settings.json"), config);
      await writeFile(join(outside, "session.jsonl"), '{"message":"SYNTHETIC_FIXTURE_LINE"}\n');
      await symlink(outside, join(home, ".claude", "projects"));
      const result = await writeOutbox({ home, now: new Date("2026-10-19T00:00:00Z") });
      const bundle = parseBundleTar(result.tarBytes, "outbox");
      const entry = bundle.manifest.entries.find((item) => item.path === ".claude/settings.json");
      expect(entry?.sha256).not.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      expect(bundle.files.has(".claude/settings.json")).toBe(false);
      expect(result.skippedSymlinks).toBeGreaterThan(0);
      expect([...bundle.files.values()].some((bytes) => new TextDecoder().decode(bytes).includes("SYNTHETIC_FIXTURE_THEME"))).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  test("selects newest logs first under the ceiling and marks omitted logs truncated", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    try {
      const directory = join(home, ".claude", "projects", "sample", "sessions");
      await mkdir(directory, { recursive: true });
      const names = ["oldest", "old", "middle", "new", "newest"];
      for (const name of names) await writeFile(join(directory, `${name}.jsonl`), name[0]!.repeat(8 * 1024 * 1024));
      const now = Date.now();
      await import("node:fs/promises").then(({ utimes }) => Promise.all(names.map((name, index) => {
        const stamp = now / 1000 - (names.length - index) * 10;
        return utimes(join(directory, `${name}.jsonl`), stamp, stamp);
      })));
      const result = await writeOutbox({ home });
      const bundle = parseBundleTar(result.tarBytes, "outbox");
      expect(bundle.manifest.truncated).toBe(true);
      expect(bundle.manifest.entries.some((entry) => entry.path.endsWith("newest.jsonl"))).toBe(true);
      expect(bundle.manifest.entries.some((entry) => entry.path.endsWith("oldest.jsonl"))).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("rejects a symlinked state ancestor and publishes nothing after encryption failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    const outside = await mkdtemp(join(tmpdir(), "ais-live-external-"));
    const exchange = await mkdtemp(join(tmpdir(), "ais-live-exchange-"));
    try {
      await symlink(outside, join(home, ".ais"));
      await expect(writeOutbox({ home })).rejects.toThrow();
      await rm(join(home, ".ais"));
      await expect(writeOutbox({ home, exchangeDir: exchange, encrypt: async () => { throw new Error("fixture encryption failure"); } })).rejects.toThrow();
      expect(await Bun.file(join(exchange, "outbox", "bundle-1.age")).exists()).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); await rm(exchange, { recursive: true, force: true }); }
  });

  test("recovers from a stale lock file left by an interrupted outbox writer", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    try {
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      await writeFile(join(home, ".ais", "live", ".outbox.lock"), "");
      const result = await writeOutbox({ home });
      expect(result.seq).toBe(1);
      expect(await Bun.file(join(home, ".ais", "live", ".outbox.lock")).exists()).toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("keeps the advisory sequence lock until the owning descriptor closes", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    try {
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      const path = join(home, ".ais", "live", ".outbox.lock");
      const first = await open(path, constants.O_CREAT | constants.O_RDWR, 0o600);
      const second = await open(path, constants.O_RDWR);
      try {
        const flock = Bun.which("flock");
        if (!flock) throw new Error("flock is required for outbox sequence locking");
        const acquire = (fd: number) => Bun.spawnSync([flock, "-n", "-x", "3"], { stdio: ["ignore", "ignore", "ignore", fd] }).exitCode;
        expect(acquire(first.fd)).toBe(0);
        expect(acquire(second.fd)).not.toBe(0);
        await first.close();
        expect(acquire(second.fd)).toBe(0);
      } finally { await first.close().catch(() => undefined); await second.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("reads persisted lastInboxSeq when the caller does not override it", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    try {
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      await writeFile(join(home, ".ais", "live", "exchange-state.json"), JSON.stringify({ version: 1, lastInboxSeq: 27, hashes: {} }));
      const result = await writeOutbox({ home });
      expect(result.manifest.lastInboxSeq).toBe(27);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("uses a supplied root sequence without consulting the home cache and prunes mixed-case bundles", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    const exchange = await mkdtemp(join(tmpdir(), "ais-live-exchange-"));
    try {
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      await writeFile(join(home, ".ais", "live", "outbox-seq.json"), '{"version":1,"seq":99}\n');
      await mkdir(join(exchange, "outbox"));
      await writeFile(join(exchange, "outbox", "BUNDLE-1.AGE"), "old");
      const result = await writeOutbox({
        home, exchangeDir: exchange, seq: 2, lastInboxSeq: 17,
        encrypt: async (tar) => tar,
      });
      expect(result.seq).toBe(2);
      expect(result.manifest.lastInboxSeq).toBe(17);
      expect(await readdir(join(exchange, "outbox"))).toEqual(["bundle-2.age"]);
      expect(JSON.parse(await readFile(join(home, ".ais", "live", "outbox-seq.json"), "utf8")).seq).toBe(99);
    } finally { await rm(home, { recursive: true, force: true }); await rm(exchange, { recursive: true, force: true }); }
  });

  test("rejects supplied outbox sequences outside the positive safe integer range", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-outbox-"));
    try {
      for (const seq of [0, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
        await expect(writeOutbox({ home, seq })).rejects.toThrow("positive safe integer");
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
