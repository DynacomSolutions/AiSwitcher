import { describe, expect, test } from "bun:test";
import { readInboxStdin } from "../../src/live/inbox.ts";
import { clockSnapshot, optionalNumberFlag } from "../../src/cli/live/dispatch.ts";
import { applyInbox } from "../../src/live/inbox.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTar } from "./fixtures.ts";

describe("live stdin contract", () => {
  test("reads only the supplied tar stream and never resolves an inbox path", async () => {
    const source = new Uint8Array([0, 1, 2, 3, 255]);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(source); controller.close(); } });
    expect(await readInboxStdin(stream)).toEqual(source);
  });

  test("rejects an oversized stdin stream before returning bytes", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1)); controller.close(); } });
    await expect(readInboxStdin(stream)).rejects.toThrow("size limit");
  });

  test("treats explicit no-network errors as offline but TLS validation failures as unsafe", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-clock-"));
    try {
      const buildTimeFile = join(home, "build-time");
      await writeFile(buildTimeFile, "1000\n");
      const snapshot = (error: unknown) => clockSnapshot(home, {
        buildTimeFile,
        nowMs: () => Date.parse("2100-01-01T00:00:00Z"),
        synchronizedProbe: async () => false,
        fetchImpl: async () => { throw error; },
      });
      const offline = await snapshot(Object.assign(new Error("offline"), { code: "ENETUNREACH" }));
      expect(offline.online).toBe(false);
      const nestedOffline = await snapshot(Object.assign(new Error("offline"), { cause: { code: "EHOSTUNREACH" } }));
      expect(nestedOffline.online).toBe(false);
      const tls = await snapshot(Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" }));
      expect(tls.online).toBe(true);
      expect(tls.httpDateMs).toBeUndefined();
      const nestedTls = await snapshot(Object.assign(new Error("certificate rejected"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }));
      expect(nestedTls.online).toBe(true);
      expect(nestedTls.httpDateMs).toBeUndefined();
      const authHome = join(home, "auth-home");
      await mkdir(authHome, { recursive: true });
      const futureAuth = await snapshot(Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }));
      const authResult = await applyInbox({
        tar: (await import("./fixtures.ts")).makeTar({}, [{ path: ".codex/auth.json", class: "auth", bytes: new TextEncoder().encode('{"access_token":"SYNTHETIC_FIXTURE_TOKEN","minted_at":1700000000}') }]),
        home: authHome,
        clock: futureAuth,
      });
      expect(authResult.deferred).toBeDefined();
      expect(authResult.lastInboxSeq).toBe(0);
      expect(await Bun.file(join(authHome, ".codex", "auth.json")).exists()).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("retries the same auth inbox after correcting the clock with no network interfaces", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-offline-clock-"));
    try {
      const buildTimeFile = join(home, "build-time");
      await writeFile(buildTimeFile, "2026-10-01T00:00:00Z\n");
      const initial = await applyInbox({
        home,
        tar: makeTar({}, [{ path: ".claude/settings.json", class: "config:settings", bytes: new TextEncoder().encode('{"theme":"dark"}') }]),
        clock: { synchronized: false, imageBuildTimeMs: 0, newestPersistedMtimeMs: 0, nowMs: Date.now() },
      });
      expect(initial.lastInboxSeq).toBe(1);
      const statePath = join(home, ".ais/live/exchange-state.json");
      const before = await readFile(statePath, "utf8");
      const tar = makeTar({ seq: 4 }, [{
        path: ".claude/.credentials.json", class: "auth",
        bytes: new TextEncoder().encode('{"access_token":"SYNTHETIC_FIXTURE_CLOCK_ACCESS","minted_at":1800000000}'),
      }]);
      const snapshot = (nowMs: number) => clockSnapshot(home, {
        buildTimeFile, nowMs: () => nowMs, synchronizedProbe: async () => false,
        networkInterfaces: () => ({}),
        // Bun returns this code on a guest with no NIC, including DNS failures.
        fetchImpl: async () => { throw Object.assign(new Error("offline"), { code: "ConnectionRefused" }); },
      });
      const deferred = await applyInbox({ home, tar, clock: await snapshot(Date.parse("2000-01-01T00:00:00Z")) });
      expect(deferred.deferred).toBeDefined();
      expect(deferred.lastInboxSeq).toBe(1);
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(await Bun.file(join(home, ".claude/.credentials.json")).exists()).toBe(false);

      const clock = await snapshot(Date.now() + 1_000);
      const applied = await applyInbox({ home, tar, clock });
      expect(applied.deferred).toBeUndefined();
      expect(applied.lastInboxSeq).toBe(4);
      expect(applied.applied).toBe(1);
      expect(clock.online).toBe(false);
      expect(await readFile(join(home, ".claude/.credentials.json"), "utf8")).toContain("SYNTHETIC_FIXTURE_CLOCK_ACCESS");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("treats any non-TLS failure as offline only without a non-loopback interface", async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-live-clock-network-"));
    try {
      const buildTimeFile = join(home, "build-time");
      await writeFile(buildTimeFile, "1000\n");
      const interfaces = (internal: boolean) => ({
        synthetic: [{ internal, address: "127.0.0.1", netmask: "", family: "IPv4" as const, mac: "", cidr: null }],
      });
      const snapshot = (code: string, networkInterfaces = () => interfaces(true)) => clockSnapshot(home, {
        buildTimeFile, synchronizedProbe: async () => false, networkInterfaces,
        fetchImpl: async () => { throw Object.assign(new Error("probe failed"), { code }); },
      });
      for (const code of ["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "DNSLookupFailed", "UNKNOWN", "TimeoutError"]) {
        expect((await snapshot(code)).online).toBe(false);
        expect((await snapshot(code, () => interfaces(false))).online).toBe(true);
        expect((await snapshot(code, () => { throw new Error("interface query failed"); })).online).toBe(true);
      }
      for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"]) {
        expect((await snapshot(code)).online).toBe(true);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("accepts optional sequence flags and preserves omitted-flag defaults", () => {
    expect(optionalNumberFlag({}, "seq", 1)).toBeUndefined();
    expect(optionalNumberFlag({}, "last-inbox-seq", 0)).toBeUndefined();
    expect(optionalNumberFlag({ seq: "17" }, "seq", 1)).toBe(17);
    expect(optionalNumberFlag({ "last-inbox-seq": "16" }, "last-inbox-seq", 0)).toBe(16);
    expect(() => optionalNumberFlag({ seq: true }, "seq", 1)).toThrow();
    expect(() => optionalNumberFlag({ seq: "0" }, "seq", 1)).toThrow();
  });
});
