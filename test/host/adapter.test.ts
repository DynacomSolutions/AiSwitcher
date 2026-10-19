import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportSnapshot } from "../../src/host/export.ts";
import { handleHostRequest, runHostStdio } from "../../src/host/adapter.ts";
import { parseBundleTar } from "../../src/live/bundle.ts";
import { encodeJsonFrame, readExact, readRequest, assertEnd } from "../../src/host/protocol.ts";
import { setOpenScanner } from "../../src/sync/tree-merge.ts";
import { importLogs } from "../../src/host/import.ts";
import { setJsonlBeforeCreateHook } from "../../src/sync/dedupe.ts";

async function findFileEndingAt(root: string, suffix: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileEndingAt(path, suffix);
      if (found) return found;
    } else if (entry.isFile() && path.endsWith(suffix)) return path;
  }
  return undefined;
}
import { createHash } from "node:crypto";
import { canonicalConfig } from "../../src/live/portable.ts";

const roots: string[] = [];
afterEach(async () => { setOpenScanner(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "ais-host-synthetic-")); roots.push(path); return path; }

function tarEntry(path: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(path), 0);
  const octal = (at: number, width: number, value: number) => header.set(new TextEncoder().encode(value.toString(8).padStart(width - 1, "0") + "\0"), at);
  octal(100, 8, 0o600); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, content.byteLength); octal(136, 12, 1);
  header.fill(32, 148, 156); header[156] = 48; header.set(new TextEncoder().encode("ustar\0"), 257); header.set(new TextEncoder().encode("00"), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ";
  header.set(new TextEncoder().encode(checksum), 148);
  const padded = new Uint8Array(Math.ceil(content.byteLength / 512) * 512); padded.set(content);
  const result = new Uint8Array(512 + padded.byteLength); result.set(header); result.set(padded, 512); return result;
}
function outbox(files: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, seq: 1, createdAt: "2026-01-01T00:00:00.000Z", kind: "outbox", entries: files.map(({ path, bytes }) => ({ path, class: "logs", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength })) }));
  const entries = [tarEntry("manifest.json", manifest), ...files.map(({ path, bytes }) => tarEntry(path, bytes)), new Uint8Array(1024)];
  const result = new Uint8Array(entries.reduce((size, entry) => size + entry.byteLength, 0)); let offset = 0;
  for (const entry of entries) { result.set(entry, offset); offset += entry.byteLength; }
  return result;
}

describe("host adapter", () => {
  test("exports only path-class data and omits retired credentials and unsafe links", async () => {
    const home = await fixture();
    await mkdir(join(home, ".claude", "identities", "retired"), { recursive: true });
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await mkdir(join(home, ".ais", "memory"), { recursive: true });
    await writeFile(join(home, ".claude", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "retired", label: "Retired", configDir: join(home, ".claude", "identities", "retired"), retired: true }] }));
    await writeFile(join(home, ".claude", "identities", "retired", ".credentials.json"), JSON.stringify({ access_token: "SYNTHETIC_FIXTURE_ACCESS_TOKEN" }));
    await writeFile(join(home, ".claude", "projects", "history.jsonl"), "{\"event\":\"SYNTHETIC_FIXTURE\"}\n");
    await writeFile(join(home, ".ais", "memory", "GLOBAL.md"), "SYNTHETIC_FIXTURE_PRIVATE");
    await writeFile(join(home, ".claude", "models.json"), "SYNTHETIC_FIXTURE_MODEL");
    await mkdir(join(home, ".claude", "identities", "work", "plugins", "fixture"), { recursive: true });
    await writeFile(join(home, ".claude", "projects", "state.sqlite-wal"), "SYNTHETIC_FIXTURE_TRANSIENT");
    await writeFile(join(home, ".claude", "projects", "run.lock"), "SYNTHETIC_FIXTURE_TRANSIENT");
    await writeFile(join(home, ".claude", "identities", "work", "plugins", "fixture", "weights.gguf"), "SYNTHETIC_FIXTURE_MODEL");
    await symlink(join(home, ".ais", "memory", "GLOBAL.md"), join(home, ".claude", "projects", "linked.jsonl"));
    const tar = await exportSnapshot({ home, now: new Date("2026-01-01T00:00:00Z") });
    const bundle = parseBundleTar(tar, "inbox");
    expect(bundle.files.has(".claude/projects/history.jsonl")).toBe(true);
    expect(bundle.files.has(".claude/identities/retired/.credentials.json")).toBe(false);
    expect(bundle.files.has(".ais/memory/GLOBAL.md")).toBe(false);
    expect(bundle.files.has(".claude/models.json")).toBe(false);
    expect(bundle.files.has(".claude/projects/state.sqlite-wal")).toBe(false);
    expect(bundle.files.has(".claude/projects/run.lock")).toBe(false);
    expect(bundle.files.has(".claude/identities/work/plugins/fixture/weights.gguf")).toBe(false);
    expect(bundle.files.has(".claude/projects/linked.jsonl")).toBe(false);
  });

  test("exports every root, provider and registered identity auth claim from B path classes", async () => {
    const home = await fixture();
    const rootAuth = [".credentials.json", "auth.json", "credentials.json", "auth.toml", "kimi-code.json", "crush.json", "console-cookie.txt"];
    for (const [index, file] of rootAuth.entries()) {
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(join(home, ".claude", file), `SYNTHETIC_FIXTURE_AUTH_${index}`);
    }
    await mkdir(join(home, ".opencode", "data", "opencode"), { recursive: true });
    await writeFile(join(home, ".opencode", "data", "opencode", "auth.json"), '{"token":"SYNTHETIC_FIXTURE_OPENCODE"}');
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "auth.json"), '{"token":"SYNTHETIC_FIXTURE_PI"}');
    const configDir = join(home, ".claude", "identities", "active");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(home, ".claude", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "active", label: "Active", configDir }] }));
    await writeFile(join(configDir, ".credentials.json"), '{"access_token":"SYNTHETIC_FIXTURE_ACTIVE"}');
    const bundle = parseBundleTar(await exportSnapshot({ home }), "inbox");
    for (const file of rootAuth) expect(bundle.files.has(`.claude/${file}`)).toBe(true);
    expect(bundle.files.has(".opencode/data/opencode/auth.json")).toBe(true);
    expect(bundle.files.has(".pi/agent/auth.json")).toBe(true);
    expect(bundle.files.has(".claude/identities/active/.credentials.json")).toBe(true);
  });

  test("rejects identity registries reached through a symlinked tool root", async () => {
    const home = await fixture();
    const outside = await fixture();
    await mkdir(join(outside, ".claude"), { recursive: true });
    await writeFile(join(outside, ".claude", "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "retired", label: "Retired", configDir: join(outside, ".claude", "retired"), retired: true }] }));
    await symlink(join(outside, ".claude"), join(home, ".claude"));
    await expect(exportSnapshot({ home })).rejects.toThrow("host identity registry is invalid");
  });

  test("preserves coalesced bytes across request header and payload reads", async () => {
    const head = encodeJsonFrame({ version: 1, operation: "importLogs", payloadBytes: 3 });
    const combined = new Uint8Array(head.byteLength + 3); combined.set(head); combined.set([1, 2, 3], head.byteLength);
    const reader = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(combined); controller.close(); } }).getReader();
    const { request, payload } = await readRequest(reader);
    expect(request.operation).toBe("importLogs");
    expect([...payload]).toEqual([1, 2, 3]);
    await assertEnd(reader);
  });

  test("reads fragmented frames and rejects trailing bytes coalesced with the response", async () => {
    const frame = encodeJsonFrame({ version: 1, operation: "capabilities", payloadBytes: 0 });
    const chunks = [...frame].map((byte) => new Uint8Array([byte]));
    const reader = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }).getReader();
    expect((await readRequest(reader)).request.operation).toBe("capabilities");
    await assertEnd(reader);
    const tailed = new Uint8Array(frame.byteLength + 1); tailed.set(frame); tailed[tailed.length - 1] = 1;
    const tailReader = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(tailed); controller.close(); } }).getReader();
    await readRequest(tailReader);
    await expect(assertEnd(tailReader)).rejects.toThrow("trailing");
  });

  test("rejects secret-bearing or unknown request fields", async () => {
    const frame = encodeJsonFrame({ version: 1, operation: "capabilities", payloadBytes: 0, passphrase: "SYNTHETIC_FIXTURE_PASSPHRASE" });
    const reader = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame); controller.close(); } }).getReader();
    await expect(readRequest(reader)).rejects.toThrow("unknown host protocol request field");
  });

  test("preview hashes canonical settings and rejects a symlink without executing config", async () => {
    const home = await fixture();
    const settingsPath = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    const config = new TextEncoder().encode('{"synthetic":"SYNTHETIC_FIXTURE"}\n');
    await writeFile(settingsPath, config);
    const entry = { path: ".claude/settings.json", class: "config:settings", sha256: createHash("sha256").update(canonicalConfig(".claude/settings.json", config)).digest("hex") };
    const result = await handleHostRequest({ operation: "previewConfig", payloadBytes: 0, preview: { entries: [entry] } }, new Uint8Array(), home);
    expect(new TextDecoder().decode(result.header)).toContain('"conflicts":[]');
    await rm(settingsPath);
    const target = join(home, ".claude", "elsewhere.json");
    await writeFile(target, config);
    await symlink(target, settingsPath);
    await expect(handleHostRequest({ operation: "previewConfig", payloadBytes: 0, preview: { entries: [entry] } }, new Uint8Array(), home)).rejects.toThrow("unsafe config preview path");
    expect(await Bun.file(target).text()).toBe(new TextDecoder().decode(config));
  });

  test("writes header before binary response bytes in stdio mode", async () => {
    const home = await fixture();
    const request = encodeJsonFrame({ version: 1, operation: "exportSnapshot", payloadBytes: 0 });
    const chunks: Uint8Array[] = [];
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(request); controller.close(); } });
    await runHostStdio({ home, stdin: stream, stdout: { write(bytes) { chunks.push(new Uint8Array(bytes)); } } });
    expect(chunks.length).toBeGreaterThan(1);
    const response = await handleHostRequest({ operation: "capabilities", payloadBytes: 0 }, new Uint8Array(), home);
    expect(response.header.byteLength).toBeGreaterThan(4);
  });

  test("a closed stdout after the request was read is a clean exit", async () => {
    const home = await fixture();
    const request = encodeJsonFrame({ version: 1, operation: "capabilities", payloadBytes: 0 });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(request); controller.close(); } });
    const previous = process.exitCode;
    await runHostStdio({ home, stdin: stream, stdout: { write() { throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }); } } });
    expect(process.exitCode).toBe(previous);
  });

  test("the real entrypoint exits 0 when the reader closes early", async () => {
    const home = await fixture();
    const proc = Bun.spawn([Bun.which("bun")!, "run", "src/ais.ts", "host", "--stdio"], {
      cwd: process.cwd(), env: { ...process.env, HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    await proc.stdout.cancel();
    proc.stdin.write(encodeJsonFrame({ version: 1, operation: "capabilities", payloadBytes: 0 })); proc.stdin.end();
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
  }, 20_000);

  test("actual ais host stdio entrypoint emits a framed capabilities response", async () => {
    const home = await fixture();
    const proc = Bun.spawn([Bun.which("bun")!, "run", "src/ais.ts", "host", "--stdio"], {
      cwd: process.cwd(), env: { ...process.env, HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const request = encodeJsonFrame({ version: 1, operation: "capabilities", payloadBytes: 0 });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 15_000);
    let stdout: ArrayBuffer; let stderr: string; let code: number;
    try {
      proc.stdin.write(request); proc.stdin.end();
      [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    } finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill(); }
    expect(timedOut).toBe(false);
    expect(code!, stderr!).toBe(0);
    const reader = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(stdout!)); controller.close(); } }).getReader();
    const header = await readExact(reader, 4);
    const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
    const response = JSON.parse(new TextDecoder().decode(await readExact(reader, length)));
    expect(response).toMatchObject({ version: 1, ok: true, payloadBytes: 0, result: { protocolVersion: 1 } });
    await assertEnd(reader);
  }, 20_000);

  test("importLogs is additive and preserves conflicting non-JSONL and open rollout data", async () => {
    const home = await fixture();
    const history = join(home, ".claude", "projects", "SYNTHETIC_FIXTURE", "history-32.jsonl");
    const config = join(home, ".claude", "projects", "SYNTHETIC_FIXTURE", "rollout.json");
    const metadata = join(home, ".claude", "projects", "SYNTHETIC_FIXTURE", "metadata.json");
    await mkdir(join(home, ".claude", "projects", "SYNTHETIC_FIXTURE"), { recursive: true });
    await writeFile(history, "{\"id\":\"SYNTHETIC_FIXTURE_1\"}\n");
    await writeFile(config, "SYNTHETIC_FIXTURE_ACTIVE_LOCAL");
    await writeFile(metadata, "SYNTHETIC_FIXTURE_SHARED_METADATA");
    const rollout = ".claude/projects/SYNTHETIC_FIXTURE/history-32.jsonl";
    const jsonl = new TextEncoder().encode("{\"id\":\"SYNTHETIC_FIXTURE_2\"}\n");
    const incomingConfig = new TextEncoder().encode("SYNTHETIC_FIXTURE_REMOTE");
    const sharedMetadata = new TextEncoder().encode("SYNTHETIC_FIXTURE_SHARED_METADATA");
    const extraLogs = Array.from({ length: 32 }, (_, index) => ({ path: `.claude/projects/SYNTHETIC_FIXTURE/history-${index}.jsonl`, bytes: new TextEncoder().encode(`{\"id\":\"SYNTHETIC_FIXTURE_${index}\"}\n`) }));
    const tar = outbox([...extraLogs, { path: rollout, bytes: jsonl }, { path: ".claude/projects/SYNTHETIC_FIXTURE/rollout.json", bytes: incomingConfig }, { path: ".claude/projects/SYNTHETIC_FIXTURE/metadata.json", bytes: sharedMetadata }]);
    const activeHandle = await open(history, "r");
    let first: Awaited<ReturnType<typeof importLogs>>; let second: Awaited<ReturnType<typeof importLogs>>;
    try { first = await importLogs(tar, home); second = await importLogs(tar, home); }
    finally { await activeHandle.close(); }
    expect(first.applied).toBeGreaterThan(0);
    expect(second.applied).toBe(0);
    expect(await Bun.file(history).text()).not.toContain("SYNTHETIC_FIXTURE_2");
    expect(await Bun.file(config).text()).toBe("SYNTHETIC_FIXTURE_ACTIVE_LOCAL");
    expect(first.skipped).toBeGreaterThanOrEqual(2);
    expect(first.conflicts).toContain(rollout);
    const conflictBase = join(home, ".ais", "cache", "host-import-conflicts");
    expect((await readdir(conflictBase)).length).toBeGreaterThan(0);
    const conflictHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const preservedRollout = await findFileEndingAt(conflictBase, `/incoming/${rollout}`);
    expect(preservedRollout && await Bun.file(preservedRollout).text()).toBe(new TextDecoder().decode(jsonl));
    expect(await Bun.file(join(conflictBase, ".claude/projects/SYNTHETIC_FIXTURE/rollout.json") + `.${conflictHash(incomingConfig)}`).exists()).toBe(true);
    expect(await Bun.file(join(conflictBase, ".claude/projects/SYNTHETIC_FIXTURE/metadata.json") + `.${conflictHash(sharedMetadata)}`).exists()).toBe(false);
    expect(second.conflicts).toEqual(first.conflicts);
    expect(await readdir(join(conflictBase, ".claude", "projects", "SYNTHETIC_FIXTURE"))).toEqual([
      `rollout.json.${conflictHash(incomingConfig)}`,
    ]);
  }, 30000);

  test("counts absent non-JSONL imports and skips equal files on replay", async () => {
    const home = await fixture();
    const bytes = new TextEncoder().encode("SYNTHETIC_FIXTURE_METADATA");
    const tar = outbox([{ path: ".claude/projects/SYNTHETIC_FIXTURE/metadata.json", bytes }]);
    const first = await importLogs(tar, home);
    const second = await importLogs(tar, home);
    expect(first.applied).toBe(1);
    expect(first.conflicts).toEqual([]);
    expect(second.applied).toBe(0);
    expect(second.conflicts).toEqual([]);
    expect(await readdir(join(home, ".ais", "cache", "host-import-conflicts")).catch(() => [])).toEqual([]);
  });

  test("reports and durably preserves an import against a closed incomplete JSONL destination", async () => {
    const home = await fixture();
    const rel = ".claude/projects/SYNTHETIC_FIXTURE/history.jsonl";
    const destination = join(home, rel);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "SYNTHETIC_FIXTURE_local_partial");
    const incoming = new TextEncoder().encode("SYNTHETIC_FIXTURE_remote\n");

    const result = await importLogs(outbox([{ path: rel, bytes: incoming }]), home);

    expect(result.conflicts).toContain(rel);
    const preserved = await findFileEndingAt(join(home, ".ais", "cache", "host-import-conflicts"), `/incoming/${rel}`);
    expect(preserved && await Bun.file(preserved).text()).toBe(new TextDecoder().decode(incoming));
    expect(await Bun.file(destination).text()).toBe("SYNTHETIC_FIXTURE_local_partial");
  });

  test("reports and preserves an EEXIST race while creating a JSONL destination", async () => {
    const home = await fixture();
    const rel = ".claude/projects/SYNTHETIC_FIXTURE/raced.jsonl";
    const destination = join(home, rel);
    const incoming = new TextEncoder().encode("SYNTHETIC_FIXTURE_imported\n");
    setJsonlBeforeCreateHook(async (path) => {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, "SYNTHETIC_FIXTURE_native\n");
    });

    try {
      const result = await importLogs(outbox([{ path: rel, bytes: incoming }]), home);
      expect(result.conflicts).toContain(rel);
      expect(await Bun.file(destination).text()).toBe("SYNTHETIC_FIXTURE_native\n");
      const preserved = await findFileEndingAt(join(home, ".ais", "cache", "host-import-conflicts"), `/incoming/${rel}`);
      expect(preserved && await Bun.file(preserved).text()).toBe(new TextDecoder().decode(incoming));
    } finally { setJsonlBeforeCreateHook(); }
  });

  test("import rejects transient log payloads and symlink parents before writing", async () => {
    const home = await fixture();
    const outside = await fixture();
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await symlink(outside, join(home, ".claude", "projects", "SYNTHETIC_FIXTURE_LINK"));
    const symlinkTar = outbox([{ path: ".claude/projects/SYNTHETIC_FIXTURE_LINK/rollout.jsonl", bytes: new TextEncoder().encode("SYNTHETIC_FIXTURE\n") }]);
    await expect(importLogs(symlinkTar, home)).rejects.toThrow("symlink");
    expect(await Bun.file(join(outside, "rollout.jsonl")).exists()).toBe(false);
    const transientTar = outbox([{ path: ".claude/projects/SYNTHETIC_FIXTURE/state.sqlite-wal", bytes: new TextEncoder().encode("SYNTHETIC_FIXTURE") }]);
    await expect(importLogs(transientTar, home)).rejects.toThrow("transient");
  });

  test("import rejects a symlinked cache before creating staging or conflict data", async () => {
    const home = await fixture();
    const outside = await fixture();
    await mkdir(join(home, ".ais"), { recursive: true });
    await symlink(outside, join(home, ".ais", "cache"));
    const tar = outbox([{ path: ".claude/projects/SYNTHETIC_FIXTURE/rollout.json", bytes: new TextEncoder().encode("SYNTHETIC_FIXTURE_REMOTE") }]);
    await expect(importLogs(tar, home)).rejects.toThrow("host cache path is unsafe");
    expect(await readdir(outside)).toEqual([]);
  });

  test("import rejects a symlink inside the durable conflict tree before writing", async () => {
    const home = await fixture();
    const outside = await fixture();
    const conflictParent = join(home, ".ais", "cache", "host-import-conflicts", ".claude", "projects");
    await mkdir(conflictParent, { recursive: true });
    await symlink(outside, join(conflictParent, "SYNTHETIC_FIXTURE"));
    const target = join(home, ".claude", "projects", "SYNTHETIC_FIXTURE", "rollout.json");
    await mkdir(join(home, ".claude", "projects", "SYNTHETIC_FIXTURE"), { recursive: true });
    await writeFile(target, "SYNTHETIC_FIXTURE_ACTIVE");
    const tar = outbox([{ path: ".claude/projects/SYNTHETIC_FIXTURE/rollout.json", bytes: new TextEncoder().encode("SYNTHETIC_FIXTURE_REMOTE") }]);
    await expect(importLogs(tar, home)).rejects.toThrow("symlink");
    expect(await readdir(outside)).toEqual([]);
    expect(await Bun.file(target).text()).toBe("SYNTHETIC_FIXTURE_ACTIVE");
  });
});
