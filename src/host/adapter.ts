import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { classify } from "../live/path-classes.ts";
import { canonicalConfig } from "../live/portable.ts";
import { exportSnapshot } from "./export.ts";
import { importLogs } from "./import.ts";
import { readHostFileBounded } from "./export.ts";
import { HOST_PROTOCOL_VERSION, MAX_HOST_PAYLOAD_BYTES, readRequest, assertEnd, encodeJsonFrame, responseHeader } from "./protocol.ts";

export interface AdapterDeps { home?: string; stdin?: ReadableStream<Uint8Array>; stdout?: { write(bytes: Uint8Array): unknown }; }

async function previewConfig(preview: unknown, home: string, signal?: AbortSignal): Promise<unknown> {
  if (!preview || typeof preview !== "object" || !Array.isArray((preview as { entries?: unknown }).entries)) throw new Error("previewConfig requires an entries array");
  const entries = (preview as { entries: unknown[] }).entries;
  if (entries.length > 10_000) throw new Error("previewConfig entry limit exceeded");
  const conflicts: string[] = [];
  for (const item of entries) {
    checkCancelled(signal);
    if (!item || typeof item !== "object") throw new Error("invalid config preview entry");
    const entry = item as { path?: unknown; class?: unknown; sha256?: unknown };
    if (typeof entry.path !== "string" || typeof entry.class !== "string" || !entry.class.startsWith("config:") || classify(entry.path) !== entry.class || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("invalid config preview entry");
    const root = resolve(home);
    const target = resolve(root, ...entry.path.split("/"));
    const relativePath = relative(root, target);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("unsafe config preview path");
    let bytes: Uint8Array | undefined;
    try {
      let cursor = root;
      const components = relativePath.split(sep);
      for (const [index, component] of components.entries()) {
        cursor = resolve(cursor, component);
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error("unsafe config preview path");
        if (index < components.length - 1 && !stat.isDirectory()) throw new Error("unsafe config preview path");
        if (index === components.length - 1 && (!stat.isFile() || stat.size > 8 * 1024 * 1024)) throw new Error("unsafe config preview file");
      }
      const realRoot = await realpath(root);
      const realTarget = await realpath(target);
      const rel = relative(realRoot, realTarget);
      if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("config preview escapes home");
      bytes = await readHostFileBounded(target, 8 * 1024 * 1024);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (bytes && createHash("sha256").update(canonicalConfig(entry.path, bytes)).digest("hex") !== entry.sha256) conflicts.push(entry.path);
  }
  return { conflicts };
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("host request cancelled");
}

export async function handleHostRequest(request: { operation: string; payloadBytes: number; preview?: unknown }, payload: Uint8Array, home = homedir(), signal?: AbortSignal): Promise<{ header: Uint8Array; payload: Uint8Array }> {
  checkCancelled(signal);
  if (payload.byteLength !== request.payloadBytes) throw new Error("host request payload length mismatch");
  if (request.operation === "capabilities") {
    return { header: encodeJsonFrame(responseHeader(true, 0, { protocolVersion: HOST_PROTOCOL_VERSION, operations: ["capabilities", "exportSnapshot", "importLogs", "previewConfig"], bundleVersion: 1 })), payload: new Uint8Array() };
  }
  if (request.operation === "exportSnapshot") {
    const bytes = await exportSnapshot({ home, signal });
    if (bytes.byteLength > MAX_HOST_PAYLOAD_BYTES) throw new Error("host snapshot exceeds the protocol limit");
    return { header: encodeJsonFrame(responseHeader(true, bytes.byteLength)), payload: bytes };
  }
  if (request.operation === "importLogs") {
    const result = await importLogs(payload, home, signal);
    return { header: encodeJsonFrame(responseHeader(true, 0, result)), payload: new Uint8Array() };
  }
  if (request.operation === "previewConfig") {
    checkCancelled(signal);
    const result = await previewConfig(request.preview, home, signal);
    return { header: encodeJsonFrame(responseHeader(true, 0, result)), payload: new Uint8Array() };
  }
  throw new Error("unsupported host operation");
}

/** A peer that closes its read end after reading the frame it needs is not an error. */
async function writeFrame(deps: AdapterDeps, bytes: Uint8Array): Promise<void> {
  try {
    if (deps.stdout) deps.stdout.write(bytes); else await Bun.stdout.write(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EPIPE" || /EPIPE/.test(String(error))) return;
    throw error;
  }
}

export async function runHostStdio(deps: AdapterDeps = {}): Promise<void> {
  const reader = (deps.stdin ?? Bun.stdin.stream()).getReader();
  let frames: Uint8Array[];
  try {
    const { request, payload } = await readRequest(reader);
    await assertEnd(reader);
    const response = await handleHostRequest(request, payload, deps.home ?? homedir());
    frames = response.payload.byteLength ? [response.header, response.payload] : [response.header];
  } catch {
    // Do not reflect parser text, paths, or payload excerpts to a peer.
    frames = [encodeJsonFrame(responseHeader(false, 0, undefined, "host request failed"))];
    process.exitCode = 2;
  } finally { reader.releaseLock(); }
  for (const frame of frames) await writeFrame(deps, frame);
}

if (import.meta.main) await runHostStdio();
