import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBundleTar, readBundle } from "../../src/live/bundle.ts";
import { writeOutbox } from "../../src/live/outbox.ts";
import { applyInbox } from "../../src/live/inbox.ts";
import { makeTar } from "./fixtures.ts";

describe("authenticated bundle format", () => {
  test("round trips a generated outbox and carries real config hashes without config payloads", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-bundle-"));
    try {
      const result = await writeOutbox({ home, now: new Date("2026-10-19T00:00:00Z") });
      expect(() => parseBundleTar(result.tarBytes, "outbox")).not.toThrow();
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("rejects incomplete and noncanonical tar input", () => {
    expect(() => parseBundleTar(new Uint8Array(512), "inbox")).toThrow();
  });

  test("rejects traversal, absolute, symlink, and hardlink entries", () => {
    const payload = new TextEncoder().encode("fixture");
    for (const invalid of [
      makeTar({}, [{ path: "../escape", class: "auth", bytes: payload }]),
      makeTar({}, [{ path: "/absolute", class: "auth", bytes: payload }]),
      makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: payload, type: 50 }]),
      makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: payload, type: 49 }]),
    ]) expect(() => parseBundleTar(invalid, "inbox")).toThrow();
  });

  test("rejects duplicate paths, unknown classes, and payload hash mismatch", () => {
    const payload = new TextEncoder().encode("SYNTHETIC_FIXTURE_AUTH");
    expect(() => parseBundleTar(makeTar({}, [
      { path: ".codex/auth.json", class: "auth", bytes: payload },
      { path: ".codex/auth.json", class: "auth", bytes: payload },
    ]), "inbox")).toThrow();
    expect(() => parseBundleTar(makeTar({}, [{ path: ".codex/auth.json", class: "bogus", bytes: payload }]), "inbox")).toThrow();
    expect(() => parseBundleTar(makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: payload, sha256: "0".repeat(64) }]), "inbox")).toThrow();
  });

  test("a late age failure after valid tar bytes cannot reach inbox writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ais-live-age-fixture-"));
    const home = await mkdtemp(join(tmpdir(), "ais-live-age-home-"));
    const fakeAge = join(root, "age");
    const validTar = makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: new TextEncoder().encode('{"access_token":"SYNTHETIC_FIXTURE_TOKEN","minted_at":1}') }]);
    const encrypted = join(root, "ciphertext.age");
    try {
      await writeFile(encrypted, "fixture ciphertext");
      await writeFile(join(root, "valid.tar"), validTar);
      await writeFile(fakeAge, "#!/bin/sh\ncat \"$AIS_TEST_TAR\"\nexit 1\n");
      await chmod(fakeAge, 0o700);
      const oldPath = process.env.PATH;
      const oldTar = process.env.AIS_TEST_TAR;
      process.env.PATH = `${root}:${oldPath ?? ""}`;
      process.env.AIS_TEST_TAR = join(root, "valid.tar");
      try { await expect(readBundle(encrypted, "SYNTHETIC_FIXTURE_PASSPHRASE", "inbox")).rejects.toThrow("authenticate"); }
      finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; if (oldTar === undefined) delete process.env.AIS_TEST_TAR; else process.env.AIS_TEST_TAR = oldTar; }
      await expect(readFile(join(home, ".codex", "auth.json"), "utf8")).rejects.toThrow();
      const result = await applyInbox({ tar: validTar, home, clock: { synchronized: true, imageBuildTimeMs: 0, newestPersistedMtimeMs: 0, nowMs: Date.now() } });
      expect(result.applied).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
  });
});
