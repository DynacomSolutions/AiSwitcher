import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHost } from "../../src/host/remote.ts";
import { encodeJsonFrame } from "../../src/host/protocol.ts";

let paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("SSH uses a configured alias, fixed command and strict batch host validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ais-host-remote-")); paths.push(dir);
  const config = join(dir, "sync.json");
  await writeFile(config, JSON.stringify({ version: 2, remotes: ["synthetic_alias"] }));
  const old = process.env.AIS_SYNC_CONFIG; process.env.AIS_SYNC_CONFIG = config;
  let argv: string[] = [];
  const reply = encodeJsonFrame({ version: 1, ok: true, payloadBytes: 0, result: { protocolVersion: 1 } });
  try {
    const result = await requestHost({ kind: "ssh", alias: "synthetic_alias" }, { operation: "capabilities" }, (args) => {
      argv = args;
      return { stdin: { write: async () => 1, end() {} }, stdout: new ReadableStream({ start(controller) { controller.enqueue(reply); controller.close(); } }), exited: Promise.resolve(0), kill() {} };
    });
    expect(result.header.ok).toBe(true);
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv.slice(-3)).toEqual(["ais", "host", "--stdio"]);
  } finally { if (old === undefined) delete process.env.AIS_SYNC_CONFIG; else process.env.AIS_SYNC_CONFIG = old; }
});

test("rejects unconfigured or shell-bearing aliases before spawning", async () => {
  let called = false;
  await expect(requestHost({ kind: "ssh", alias: "synthetic_alias;touch" }, { operation: "capabilities" }, () => { called = true; throw new Error("unexpected spawn"); })).rejects.toThrow("invalid SSH host alias");
  expect(called).toBe(false);
});

test("reports a missing or incompatible remote with an actionable message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ais-host-remote-")); paths.push(dir);
  const config = join(dir, "sync.json");
  await writeFile(config, JSON.stringify({ version: 2, remotes: ["synthetic_alias"] }));
  const old = process.env.AIS_SYNC_CONFIG; process.env.AIS_SYNC_CONFIG = config;
  try {
    await expect(requestHost({ kind: "ssh", alias: "synthetic_alias" }, { operation: "capabilities" }, () => ({
      stdin: { write: async () => 1, end() {} },
      stdout: new ReadableStream({ start(controller) { controller.close(); } }),
      exited: Promise.resolve(255), kill() {},
    }))).rejects.toThrow("remote ais host is missing, incompatible, or returned a malformed response");
  } finally { if (old === undefined) delete process.env.AIS_SYNC_CONFIG; else process.env.AIS_SYNC_CONFIG = old; }
});

test("kills a timed out SSH request and rejects pre-cancelled local requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ais-host-remote-")); paths.push(dir);
  const config = join(dir, "sync.json");
  await writeFile(config, JSON.stringify({ version: 2, remotes: ["synthetic_alias"] }));
  const old = process.env.AIS_SYNC_CONFIG; process.env.AIS_SYNC_CONFIG = config;
  let killed = false;
  let finish!: (code: number) => void;
  let close!: () => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { close = () => controller.close(); } });
  try {
    await expect(requestHost({ kind: "ssh", alias: "synthetic_alias" }, { operation: "capabilities" }, () => ({
      stdin: { write: async () => 1, end() {} }, stdout, exited,
      kill() { killed = true; close(); finish(143); },
    }), 10)).rejects.toThrow("remote ais host request timed out");
    expect(killed).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(requestHost({ kind: "local" }, { operation: "importLogs", payload: new Uint8Array([1]), signal: controller.signal }, undefined, 10)).rejects.toThrow("host request cancelled");
  } finally { if (old === undefined) delete process.env.AIS_SYNC_CONFIG; else process.env.AIS_SYNC_CONFIG = old; }
});

test("does not expose arbitrary remote error text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ais-host-remote-")); paths.push(dir);
  const config = join(dir, "sync.json");
  await writeFile(config, JSON.stringify({ version: 2, remotes: ["synthetic_alias"] }));
  const old = process.env.AIS_SYNC_CONFIG; process.env.AIS_SYNC_CONFIG = config;
  const response = encodeJsonFrame({ version: 1, ok: false, payloadBytes: 0, error: "SYNTHETIC_FIXTURE_SECRET" });
  try {
    await expect(requestHost({ kind: "ssh", alias: "synthetic_alias" }, { operation: "capabilities" }, () => ({
      stdin: { write: async () => 1, end() {} },
      stdout: new ReadableStream({ start(controller) { controller.enqueue(response); controller.close(); } }),
      exited: Promise.resolve(0), kill() {},
    }))).rejects.toThrow("remote ais host request failed");
  } finally { if (old === undefined) delete process.env.AIS_SYNC_CONFIG; else process.env.AIS_SYNC_CONFIG = old; }
});
