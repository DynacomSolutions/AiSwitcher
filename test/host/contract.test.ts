import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInbox } from "../../src/live/inbox.ts";
import { parseBundleTar } from "../../src/live/bundle.ts";
import { writeOutbox } from "../../src/live/outbox.ts";
import { canonicalConfig } from "../../src/live/portable.ts";
import { classify } from "../../src/live/path-classes.ts";
import { makeTar } from "../live/fixtures.ts";

const markedLog = '{"event":"SYNTHETIC_FIXTURE_contract_log"}\n';
const roots: string[] = [];
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ais-host-contract-test-"));
  roots.push(path);
  return path;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("B live bundle contract", () => {
  test("uses B's exported path classes and excludes ignore from bundle payloads", () => {
    expect(classify(".claude/.credentials.json")).toBe("auth");
    expect(classify(".ais/logs/session.jsonl")).toBe("logs");
    expect(classify(".codex/config.toml")).toBe("config:settings");
    expect(classify(".ssh/config")).toBe("ssh");
    expect(classify(".ais/memory/GLOBAL.md")).toBe("ignore");
  });

  test("applies inbox once and only that inbox sequence is acknowledged", async () => {
    const target = await home();
    const bytes = new TextEncoder().encode('{"theme":"synthetic"}\n');
    const tar = makeTar({ version: 1, seq: 12, kind: "inbox" }, [
      { path: ".claude/settings.json", class: "config:settings", bytes },
    ]);
    const clock = { synchronized: true, imageBuildTimeMs: 0, newestPersistedMtimeMs: 0, nowMs: Date.now() };
    const first = await applyInbox({ home: target, tar, clock });
    const replay = await applyInbox({ home: target, tar, clock });
    expect(first).toMatchObject({ applied: 1, lastInboxSeq: 12 });
    expect(replay).toMatchObject({ applied: 0, lastInboxSeq: 12 });
    expect(await readFile(join(target, ".claude/settings.json"), "utf8")).toBe('{"theme":"synthetic"}\n');
  });

  test("outbox hashes configuration without including its payload and reports applied inbox sequence", async () => {
    const target = await home();
    const config = new TextEncoder().encode('{"enabled":true}\n');
    await mkdir(join(target, ".ais/config"), { recursive: true });
    await mkdir(join(target, ".ais/logs"), { recursive: true });
    await Bun.write(join(target, ".ais/config/sync-v2.json"), config);
    await Bun.write(join(target, ".ais/logs/session.jsonl"), markedLog);
    const result = await writeOutbox({ home: target, lastInboxSeq: 12, now: new Date("2026-10-19T00:00:00.000Z") });
    const parsed = parseBundleTar(result.tarBytes, "outbox");
    const configEntry = parsed.manifest.entries.find((entry) => entry.path === ".ais/config/sync-v2.json");
    const canonical = canonicalConfig(".ais/config/sync-v2.json", config);
    expect(parsed.manifest).toMatchObject({ version: 1, kind: "outbox", lastInboxSeq: 12 });
    expect(configEntry).toMatchObject({ class: "config:settings", sha256: digest(canonical), size: canonical.byteLength });
    expect(parsed.files.has(".ais/config/sync-v2.json")).toBe(false);
    expect(parsed.files.get(".ais/logs/session.jsonl")).toEqual(new TextEncoder().encode(markedLog));
  });

  test("rejects corrupt hashes, unknown kinds, unsafe sequences and unexpected tar entries", () => {
    const safe = new TextEncoder().encode("{}");
    const valid = makeTar({ version: 1, seq: 1, kind: "inbox" }, [
      { path: ".claude/settings.json", class: "config:settings", bytes: safe },
    ]);
    expect(() => parseBundleTar(valid, "outbox")).toThrow();
    const invalidSeq = makeTar({ version: 1, seq: Number.MAX_SAFE_INTEGER + 1, kind: "inbox" }, [
      { path: ".claude/settings.json", class: "config:settings", bytes: safe },
    ]);
    expect(() => parseBundleTar(invalidSeq, "inbox")).toThrow();
    const badHash = makeTar({ version: 1, seq: 1, kind: "inbox" }, [
      { path: ".claude/settings.json", class: "config:settings", bytes: safe, sha256: "0".repeat(64) },
    ]);
    expect(() => parseBundleTar(badHash, "inbox")).toThrow();
    const corruptTrailer = valid.slice();
    corruptTrailer[corruptTrailer.byteLength - 1] = 1;
    expect(() => parseBundleTar(corruptTrailer, "inbox")).toThrow();
  });
});
