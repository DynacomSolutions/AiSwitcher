import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyInbox } from "../../src/live/inbox.ts";
import { newestPersistedMtime, openHomeDirectory } from "../../src/live/safe-fs.ts";
import { makeTar } from "./fixtures.ts";

describe("inbox apply", () => {
  const goodClock = { synchronized: true, imageBuildTimeMs: 1_000, newestPersistedMtimeMs: 0, nowMs: 2_000 };
  test("defers credential writes until clock is plausible and leaves sequence retryable", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(join(home, ".codex", "auth.json"), '{"access_token":"SYNTHETIC_FIXTURE_OLD","minted_at":1700000000}\n');
      const tar = makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: new TextEncoder().encode('{"access_token":"SYNTHETIC_FIXTURE_NEW","minted_at":1800000000}\n') }]);
      const res = await applyInbox({ tar, home, clock: { synchronized: false, imageBuildTimeMs: 1_000, newestPersistedMtimeMs: 0, nowMs: 0 } });
      expect(res.deferred).toBeDefined();
      expect(await readFile(join(home, ".codex", "auth.json"), "utf8")).toContain("SYNTHETIC_FIXTURE_OLD");
      expect(res.lastInboxSeq).toBe(0);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("does not follow a symlinked parent while applying files", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    const outside = await mkdtemp(join(tmpdir(), "ais-live-outside-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(join(home, ".codex", "auth.json"), '{"access_token":"SYNTHETIC_FIXTURE_ACCESS","refresh_token":"SYNTHETIC_FIXTURE_REFRESH","minted_at":1700000000}\n');
      const tar = makeTar({}, [{ path: ".claude/settings.json", class: "config:settings", bytes: new TextEncoder().encode('{"theme":"dark"}\n') }]);
      await Bun.write(join(outside, "sentinel"), "unchanged");
      await symlink(outside, join(home, ".claude"));
      await expect(applyInbox({ tar, home, clock: { synchronized: true, imageBuildTimeMs: 0, newestPersistedMtimeMs: 0, nowMs: Date.now() } })).rejects.toThrow();
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("unchanged");
    } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  test("merges provider grants atomically using minted time before expiry", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({
        last_refresh: "2026-10-18T00:00:00Z",
        tokens: { access_token: "SYNTHETIC_FIXTURE_CURRENT_ACCESS", refresh_token: "SYNTHETIC_FIXTURE_CURRENT_REFRESH", minted_at: 200, expires_at: 300 },
      }));
      const incoming = {
        last_refresh: "2026-10-17T00:00:00Z",
        tokens: { access_token: "SYNTHETIC_FIXTURE_OLDER_ACCESS", refresh_token: "SYNTHETIC_FIXTURE_OLDER_REFRESH", minted_at: 100, expires_at: 900 },
      };
      const tar = makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: new TextEncoder().encode(JSON.stringify(incoming)) }]);
      await applyInbox({ tar, home, clock: goodClock });
      const written = JSON.parse(await readFile(join(home, ".codex", "auth.json"), "utf8"));
      expect(written.tokens.access_token).toBe("SYNTHETIC_FIXTURE_CURRENT_ACCESS");
      expect(written.tokens.refresh_token).toBe("SYNTHETIC_FIXTURE_CURRENT_REFRESH");
      expect(written.last_refresh).toBe("2026-10-18T00:00:00Z");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("uses nested minted time before an outer grant expiry", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      const current = {
        expires_at: 2_100_000_000,
        tokens: { access_token: "SYNTHETIC_FIXTURE_CURRENT_ACCESS", refresh_token: "SYNTHETIC_FIXTURE_CURRENT_REFRESH", minted_at: 1_900_000_000 },
      };
      const incoming = {
        expires_at: 2_200_000_000,
        tokens: { access_token: "SYNTHETIC_FIXTURE_OLDER_ACCESS", refresh_token: "SYNTHETIC_FIXTURE_OLDER_REFRESH", minted_at: 1_800_000_000 },
      };
      await writeFile(join(home, ".codex", "auth.json"), JSON.stringify(current));
      const tar = makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: new TextEncoder().encode(JSON.stringify(incoming)) }]);
      await applyInbox({ tar, home, clock: goodClock });
      const written = JSON.parse(await readFile(join(home, ".codex", "auth.json"), "utf8"));
      expect(written.tokens.access_token).toBe("SYNTHETIC_FIXTURE_CURRENT_ACCESS");
      expect(written.tokens.refresh_token).toBe("SYNTHETIC_FIXTURE_CURRENT_REFRESH");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("uses nested Claude grant freshness and keeps its token pair together", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".claude"), { recursive: true });
      const current = { claudeAiOauth: { accessToken: "SYNTHETIC_FIXTURE_CURRENT_ACCESS", refreshToken: "SYNTHETIC_FIXTURE_CURRENT_REFRESH", mintedAt: 1_800_000_000, expiresAt: 1_900_000_000 } };
      const incoming = { claudeAiOauth: { accessToken: "SYNTHETIC_FIXTURE_OLDER_ACCESS", refreshToken: "SYNTHETIC_FIXTURE_OLDER_REFRESH", mintedAt: 1_700_000_000, expiresAt: 2_000_000_000 } };
      await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify(current));
      const tar = makeTar({}, [{ path: ".claude/.credentials.json", class: "auth", bytes: new TextEncoder().encode(JSON.stringify(incoming)) }]);
      await applyInbox({ tar, home, clock: goodClock });
      const written = JSON.parse(await readFile(join(home, ".claude", ".credentials.json"), "utf8"));
      expect(written.claudeAiOauth.accessToken).toBe("SYNTHETIC_FIXTURE_CURRENT_ACCESS");
      expect(written.claudeAiOauth.refreshToken).toBe("SYNTHETIC_FIXTURE_CURRENT_REFRESH");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("defers auth when a persisted portable file is newer than the clock", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      await writeFile(join(home, ".ais", "live", "exchange-state.json"), JSON.stringify({ version: 1, lastInboxSeq: 0, hashes: {} }));
      await mkdir(join(home, ".claude"), { recursive: true });
      const future = new Date(Date.now() + 60 * 60 * 1000);
      await writeFile(join(home, ".claude", "settings.json"), "{}\n");
      await (await import("node:fs/promises")).utimes(join(home, ".claude", "settings.json"), future, future);
      const root = await openHomeDirectory(home);
      let newest: number;
      try { newest = await newestPersistedMtime(root); } finally { await root.close(); }
      const tar = makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: new TextEncoder().encode('{"access_token":"SYNTHETIC_FIXTURE_TOKEN","minted_at":1}') }]);
      const result = await applyInbox({ tar, home, clock: { ...goodClock, nowMs: Date.now(), newestPersistedMtimeMs: newest } });
      expect(result.deferred).toBeDefined();
      expect(result.lastInboxSeq).toBe(0);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("keeps local-only config edits across repeated unchanged host bundles", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".claude"), { recursive: true });
      const baseline = new TextEncoder().encode('{"theme":"SYNTHETIC_FIXTURE_BASE"}\n');
      const local = '{"theme":"SYNTHETIC_FIXTURE_LOCAL"}\n';
      await writeFile(join(home, ".claude", "settings.json"), local);
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      await writeFile(join(home, ".ais", "live", "exchange-state.json"), JSON.stringify({ version: 1, lastInboxSeq: 0, hashes: { ".claude/settings.json": createHash("sha256").update(baseline).digest("hex") } }));
      for (const seq of [1, 2]) {
        const tar = makeTar({ seq }, [{ path: ".claude/settings.json", class: "config:settings", bytes: baseline }]);
        await applyInbox({ tar, home, clock: goodClock });
        expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toBe(local);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("defers two-sided config conflicts without a controlling terminal and honours an explicit choice", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      const path = join(home, ".claude", "settings.json");
      await mkdir(join(home, ".claude"), { recursive: true });
      const baseline = new TextEncoder().encode('{"theme":"SYNTHETIC_FIXTURE_BASE"}\n');
      const drive = new TextEncoder().encode('{"theme":"SYNTHETIC_FIXTURE_DRIVE"}\n');
      const local = '{"theme":"SYNTHETIC_FIXTURE_LOCAL"}\n';
      await writeFile(path, local);
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      await writeFile(join(home, ".ais", "live", "exchange-state.json"), JSON.stringify({ version: 1, lastInboxSeq: 0, hashes: { ".claude/settings.json": createHash("sha256").update(baseline).digest("hex") } }));
      const tar = makeTar({ seq: 1 }, [{ path: ".claude/settings.json", class: "config:settings", bytes: drive }]);
      const deferred = await applyInbox({ tar, home, clock: goodClock, isTTY: false });
      expect(deferred.deferred).toBeDefined();
      expect(deferred.conflicts).toEqual([".claude/settings.json"]);
      expect(await readFile(path, "utf8")).toBe(local);
      const applied = await applyInbox({ tar, home, clock: goodClock, isTTY: true, chooseConflict: async () => "drive" });
      expect(applied.conflicts).toEqual([".claude/settings.json"]);
      expect(await readFile(path, "utf8")).toBe(local);
      const repeated = await applyInbox({ tar: makeTar({ seq: 2 }, [{ path: ".claude/settings.json", class: "config:settings", bytes: drive }]), home, clock: goodClock });
      expect(repeated.conflicts).toEqual([]);
      expect(await readFile(path, "utf8")).toBe(local);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("applies auth freshness and JSONL union without treating them as config conflicts", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await mkdir(join(home, ".claude", "projects", "sample", "sessions"), { recursive: true });
      const logPath = join(home, ".claude", "projects", "sample", "sessions", "run.jsonl");
      await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ access_token: "SYNTHETIC_FIXTURE_OLD_ACCESS", refresh_token: "SYNTHETIC_FIXTURE_OLD_REFRESH", minted_at: 1_700_000_000 }));
      await writeFile(logPath, '{"id":"SYNTHETIC_FIXTURE_ONE"}\n');
      const auth = new TextEncoder().encode(JSON.stringify({ access_token: "SYNTHETIC_FIXTURE_NEW_ACCESS", refresh_token: "SYNTHETIC_FIXTURE_NEW_REFRESH", minted_at: 1_800_000_000 }));
      const log = new TextEncoder().encode('{"id":"SYNTHETIC_FIXTURE_ONE"}\n{"id":"SYNTHETIC_FIXTURE_TWO"}\n');
      const tar = makeTar({}, [
        { path: ".codex/auth.json", class: "auth", bytes: auth },
        { path: ".claude/projects/sample/sessions/run.jsonl", class: "logs", bytes: log },
      ]);
      const result = await applyInbox({ tar, home, clock: goodClock });
      expect(result.conflicts).toEqual([]);
      expect(JSON.parse(await readFile(join(home, ".codex", "auth.json"), "utf8")).access_token).toBe("SYNTHETIC_FIXTURE_NEW_ACCESS");
      expect((await readFile(logPath, "utf8")).match(/SYNTHETIC_FIXTURE_ONE/g)).toHaveLength(1);
      expect(await readFile(logPath, "utf8")).toContain("SYNTHETIC_FIXTURE_TWO");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("defers non-finite and not-yet-after-build clock values", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      const tar = makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: new TextEncoder().encode('{"access_token":"SYNTHETIC_FIXTURE_TOKEN","minted_at":1}') }]);
      for (const clock of [
        { ...goodClock, nowMs: 1_000 },
        { ...goodClock, nowMs: Number.NaN },
        { ...goodClock, online: true, httpDateMs: Number.NaN },
      ]) {
        const result = await applyInbox({ tar, home, clock });
        expect(result.deferred).toBeDefined();
        expect(result.lastInboxSeq).toBe(0);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("applies a duplicate or lower sequence as a no-op", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      await writeFile(join(home, ".ais", "live", "exchange-state.json"), JSON.stringify({ version: 1, lastInboxSeq: 2, hashes: {} }));
      const tar = makeTar({ seq: 2 }, [{ path: ".claude/settings.json", class: "config:settings", bytes: new TextEncoder().encode("{}") }]);
      expect((await applyInbox({ tar, home, clock: goodClock })).applied).toBe(0);
      expect(await Bun.file(join(home, ".claude", "settings.json")).exists()).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("rejects malformed persisted sequence and baseline state before writing", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      await mkdir(join(home, ".ais", "live"), { recursive: true });
      const target = join(home, ".claude", "settings.json");
      const tar = makeTar({ seq: 3 }, [{ path: ".claude/settings.json", class: "config:settings", bytes: new TextEncoder().encode('{"theme":"SYNTHETIC_FIXTURE_DRIVE"}\n') }]);
      const invalidStates = [
        { version: 1, lastInboxSeq: -1, hashes: {} },
        { version: 1, lastInboxSeq: 0, hashes: [] },
        { version: 1, lastInboxSeq: 0, hashes: { ".claude/settings.json": 42 } },
        { version: 1, lastInboxSeq: 0, hashes: { ".claude/settings.json": "not-a-sha256" } },
      ];
      for (const state of invalidStates) {
        await writeFile(join(home, ".ais", "live", "exchange-state.json"), JSON.stringify(state));
        await expect(applyInbox({ tar, home, clock: goodClock })).rejects.toThrow();
        expect(await Bun.file(target).exists()).toBe(false);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("sets SSH material to mode 0600 and never logs its value", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-inbox-"));
    try {
      const secret = "SYNTHETIC_FIXTURE_SSH_KEY_MATERIAL";
      const tar = makeTar({}, [{ path: ".ssh/config", class: "ssh", bytes: new TextEncoder().encode(secret) }]);
      const messages: string[] = [];
      await applyInbox({ tar, home, clock: goodClock, log: (message) => messages.push(message) });
      expect((await readFile(join(home, ".ssh", "config"), "utf8"))).toBe(secret);
      expect((await import("node:fs/promises")).stat(join(home, ".ssh", "config")).then((s) => s.mode & 0o777)).resolves.toBe(0o600);
      expect(messages.join("\n")).not.toContain(secret);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
