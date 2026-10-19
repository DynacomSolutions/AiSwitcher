import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { classify } from "../live/path-classes.ts";
import { MAX_INBOX_BYTES, type BundleEntry, type BundleManifest, parseBundleTar } from "../live/bundle.ts";
import { parseIdentitiesFile } from "../identities/store.ts";
import { expandPath, translateHostPath } from "../identities/match.ts";
import { portableIdentitiesFile } from "../sync/registry.ts";
import { SYNC_TOOL_CONFIGS, isTransientSyncPath } from "../sync/rsync.ts";
import { join as joinPath } from "node:path";
import { canonicalConfig } from "../live/portable.ts";
import { isRetired } from "../identities/retired.ts";
import { MAX_HOST_PAYLOAD_BYTES } from "./protocol.ts";
import pathRules from "../live/path-classes.json" with { type: "json" };

const ROOTS = [...pathRules.toolRoots, pathRules.sshRoot, ".ais"];
const MAX_FILE = 16 * 1024 * 1024;
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 24;
const te = new TextEncoder();

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export async function readHostFileBounded(path: string, limit: number): Promise<Uint8Array | undefined> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= MAX_INBOX_BYTES) throw new Error("invalid host file read limit");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error("host file exceeds its read limit");
    const blocks: Uint8Array[] = [];
    let size = 0;
    const block = new Uint8Array(Math.min(64 * 1024, limit + 1));
    while (true) {
      const { bytesRead } = await file.read(block, 0, Math.min(block.byteLength, limit - size + 1), null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error("host file grew beyond its read limit");
      blocks.push(block.slice(0, bytesRead));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of blocks) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  } finally { await file.close(); }
}

async function validateRegistryPath(home: string, path: string): Promise<boolean> {
  const rel = relative(home, path);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("host identity registry is invalid");
  let cursor = home;
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()) || (index === parts.length - 1 && !info.isFile())) {
      throw new Error("host identity registry is invalid");
    }
  }
  const realPath = await realpath(path);
  const realRel = relative(home, realPath);
  if (realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("host identity registry is invalid");
  return true;
}
function join(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((n, x) => n + x.byteLength, 0));
  let pos = 0; for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.byteLength; }
  return result;
}
function octal(header: Uint8Array, start: number, length: number, value: number): void {
  header.set(te.encode(value.toString(8).padStart(length - 1, "0") + "\0"), start);
}
function tarFile(path: string, bytes: Uint8Array): Uint8Array {
  const parts = path.split("/");
  const name = te.encode(parts.pop()!);
  const prefix = te.encode(parts.join("/"));
  if (name.byteLength > 100 || prefix.byteLength > 155) throw new Error("host snapshot path is too long");
  const header = new Uint8Array(512); header.set(name); header.set(prefix, 345);
  octal(header, 100, 8, 0o600); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
  octal(header, 124, 12, bytes.byteLength); octal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(32, 148, 156); header[156] = 48; header.set(te.encode("ustar\0"), 257); header.set(te.encode("00"), 263);
  const sum = header.reduce((n, b) => n + b, 0); header.set(te.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padded = new Uint8Array(Math.ceil(bytes.byteLength / 512) * 512); padded.set(bytes);
  return join([header, padded]);
}

export interface ExportSnapshotOptions { home?: string; now?: Date; signal?: AbortSignal; }

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("host request cancelled");
}

export async function exportSnapshot(options: ExportSnapshotOptions = {}): Promise<Uint8Array> {
  const home = resolve(options.home ?? homedir());
  const rootReal = await realpath(home);
  const retiredDirs = new Set<string>();
  const registryContents = new Map<string, Uint8Array>();
  for (const cfg of SYNC_TOOL_CONFIGS) {
    const rootName = `.${cfg.toolName === "kimi" ? "kimi-code" : cfg.toolName}`;
    const registryPath = joinPath(rootReal, rootName, "identities.json");
    try {
      if (!await validateRegistryPath(rootReal, registryPath)) continue;
      const registryBytes = await readHostFileBounded(registryPath, MAX_FILE);
      if (!registryBytes) continue;
      registryContents.set(registryPath, registryBytes);
      const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(registryBytes));
      const registry = parseIdentitiesFile(raw);
      for (const identity of registry.identities) if (isRetired(identity)) retiredDirs.add(resolve(identity.configDir.replace(/^~(?=$|\/)/, home)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("host identity registry is invalid");
    }
  }
  const payloads = new Map<string, Uint8Array>();
  let scanned = 0;
  let payloadBytes = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    checkCancelled(options.signal);
    if (depth > MAX_DEPTH || ++scanned > MAX_ENTRIES) throw new Error("host snapshot scan exceeded its bound");
    const absolute = resolve(home, path);
    let stat;
    try { stat = await lstat(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (isTransientSyncPath(path)) return;
      const parts = path.split("/");
      if (parts.length === 1 && !ROOTS.includes(path)) return;
      if (parts[0] === ".ais" && parts.length === 2 && !["hooks", "logs", "config", "identities"].includes(parts[1]!)) return;
      const entries = await readdir(absolute);
      entries.sort();
      for (const name of entries) await visit(`${path}/${name}`, depth + 1);
      return;
    }
    if (!stat.isFile()) return;
    const entryClass = classify(path);
    if (entryClass === "ignore" || isTransientSyncPath(path)) return;
    if (entryClass === "auth" && [...retiredDirs].some((dir) => absolute === dir || absolute.startsWith(`${dir}${sep}`))) return;
    const real = await realpath(absolute).catch(() => undefined);
    if (!real || (relative(rootReal, real).startsWith(`..${sep}`) || isAbsolute(relative(rootReal, real)))) return;
    const maxRead = Math.min(MAX_FILE, MAX_INBOX_BYTES - 1024 * 1024 - payloadBytes);
    if (stat.size > maxRead) {
      if (entryClass === "auth" || entryClass.startsWith("config:") || entryClass === "ssh") throw new Error("host snapshot contains an oversized claimed file");
      return;
    }
    const bytes = registryContents.get(absolute) ?? await readHostFileBounded(absolute, maxRead);
    if (!bytes) {
      if (entryClass === "auth" || entryClass.startsWith("config:") || entryClass === "ssh") throw new Error("host snapshot claimed file disappeared during collection");
      return;
    }
    let portable: Uint8Array<ArrayBufferLike> = new Uint8Array(bytes);
    if (entryClass.startsWith("config:")) portable = canonicalConfig(path, portable);
    if (entryClass === "config:identity" && path.endsWith("/identities.json")) {
      const cfg = SYNC_TOOL_CONFIGS.find((candidate) => path === `.${candidate.toolName === "kimi" ? "kimi-code" : candidate.toolName}/identities.json`);
      if (cfg) {
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const parsed = parseIdentitiesFile(raw);
        const normalized = { ...parsed, identities: parsed.identities.map((identity) => ({ ...identity, configDir: translateHostPath(expandPath(identity.configDir)) })) };
        portable = te.encode(`${JSON.stringify(portableIdentitiesFile(normalized, { ...cfg, identitiesJsonPath: absolute }, home), null, 2)}\n`);
      }
    }
    if (payloadBytes + portable.byteLength > MAX_INBOX_BYTES - 1024 * 1024) {
      if (entryClass === "auth" || entryClass.startsWith("config:") || entryClass === "ssh") throw new Error("host snapshot exceeds the cumulative size limit");
      return;
    }
    payloads.set(path, portable);
    payloadBytes += portable.byteLength;
  };
  for (const name of ROOTS) { checkCancelled(options.signal); await visit(name, 0); }
  const entries: BundleEntry[] = [...payloads].map(([path, bytes]) => ({ path, class: classify(path) as BundleEntry["class"], sha256: hash(bytes), size: bytes.byteLength }));
  const manifest: BundleManifest = { version: 1, seq: 1, createdAt: (options.now ?? new Date()).toISOString(), kind: "inbox", entries };
  const files: Uint8Array[] = [tarFile("manifest.json", te.encode(JSON.stringify(manifest)))];
  for (const [path, bytes] of payloads) files.push(tarFile(path, bytes));
  files.push(new Uint8Array(1024));
  const tar = join(files);
  if (tar.byteLength > Math.min(MAX_INBOX_BYTES, MAX_HOST_PAYLOAD_BYTES)) throw new Error("host snapshot exceeds the size limit");
  // Validate our output against B's authoritative class and manifest parser.
  parseBundleTar(tar, "inbox");
  return tar;
}
