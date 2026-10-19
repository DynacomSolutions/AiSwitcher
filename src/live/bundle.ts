import { closeSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { constants, open } from "node:fs/promises";
import { classify, type LivePathClass } from "./path-classes.ts";

export const MAX_INBOX_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOX_BYTES = 32 * 1024 * 1024;
const TAR_BLOCK = 512;
const AGE_DECRYPT_TIMEOUT_MS = 30_000;

export interface BundleEntry {
  path: string;
  class: Exclude<LivePathClass, "ignore">;
  sha256: string;
  size: number;
}

export interface BundleManifest {
  version: 1;
  seq: number;
  createdAt: string;
  kind: "inbox" | "outbox";
  entries: BundleEntry[];
  lastInboxSeq?: number;
  truncated?: boolean;
  skippedSymlinks?: number;
}

export interface Bundle {
  manifest: BundleManifest;
  files: Map<string, Uint8Array>;
  tarBytes: Uint8Array;
}

function safePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  const slice = end < 0 ? bytes : bytes.subarray(0, end);
  return new TextDecoder("utf-8", { fatal: true }).decode(slice);
}

function tarOctal(bytes: Uint8Array): number {
  const text = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("invalid tar numeric field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("tar size is out of range");
  return value;
}

function parseTar(raw: Uint8Array, maxBytes: number): Map<string, Uint8Array> {
  if (raw.byteLength > maxBytes) throw new Error("bundle exceeds the size limit");
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let ended = false;
  while (offset + TAR_BLOCK <= raw.byteLength) {
    const header = raw.subarray(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;
    if (header.every((byte) => byte === 0)) {
      if (offset + TAR_BLOCK > raw.byteLength || !raw.subarray(offset, offset + TAR_BLOCK).every((byte) => byte === 0)) {
        throw new Error("tar must end with two zero blocks");
      }
      if (raw.subarray(offset + TAR_BLOCK).some((byte) => byte !== 0)) throw new Error("non-canonical bytes after tar end");
      ended = true;
      break;
    }
    const storedChecksum = tarOctal(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (storedChecksum !== checksum) throw new Error("tar header checksum mismatch");
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    if (!safePath(path)) throw new Error("unsafe tar path");
    if (header[156] !== 0 && header[156] !== 48) throw new Error("tar contains a non-regular entry");
    if (header.subarray(257, 263).some((b) => b !== 0) && tarString(header.subarray(257, 263)) !== "ustar") {
      throw new Error("unsupported tar format");
    }
    if (files.has(path)) throw new Error("duplicate tar path");
    const size = tarOctal(header.subarray(124, 136));
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (offset + padded > raw.byteLength) throw new Error("truncated tar entry");
    files.set(path, raw.slice(offset, offset + size));
    offset += padded;
  }
  if (!ended) throw new Error("tar end marker is missing");
  return files;
}

function parseManifest(value: Uint8Array, files: Map<string, Uint8Array>): BundleManifest {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); }
  catch { throw new Error("invalid bundle manifest"); }
  if (!raw || typeof raw !== "object") throw new Error("invalid bundle manifest");
  const manifest = raw as Partial<BundleManifest>;
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.seq) || manifest.seq! < 1 ||
      typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt)) ||
      (manifest.kind !== "inbox" && manifest.kind !== "outbox") || !Array.isArray(manifest.entries)) {
    throw new Error("invalid bundle manifest fields");
  }
  if (manifest.lastInboxSeq !== undefined && (!Number.isSafeInteger(manifest.lastInboxSeq) || manifest.lastInboxSeq < 0)) throw new Error("invalid lastInboxSeq");
  if (manifest.skippedSymlinks !== undefined && (!Number.isSafeInteger(manifest.skippedSymlinks) || manifest.skippedSymlinks < 0)) throw new Error("invalid skippedSymlinks");
  if (manifest.truncated !== undefined && typeof manifest.truncated !== "boolean") throw new Error("invalid truncated flag");
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || !safePath(entry.path) || entry.path === "manifest.json" || seen.has(entry.path) ||
        !["auth", "logs", "config:settings", "config:plugins", "config:identity", "ssh"].includes(entry.class) ||
        classify(entry.path) !== entry.class || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("invalid bundle entry");
    seen.add(entry.path);
    const content = files.get(entry.path);
    const configManifestOnly = manifest.kind === "outbox" && entry.class.startsWith("config:") && !content;
    if (!configManifestOnly && (!content || content.byteLength !== entry.size || createHash("sha256").update(content!).digest("hex") !== entry.sha256)) {
      throw new Error(`bundle payload check failed: ${entry.path}`);
    }
  }
  for (const path of files.keys()) if (path !== "manifest.json" && !seen.has(path)) throw new Error("unlisted bundle payload");
  return manifest as BundleManifest;
}

/** Parse and validate a fully authenticated tar. Call only after age exits successfully. */
export function parseBundleTar(raw: Uint8Array, kind?: BundleManifest["kind"]): Bundle {
  const limit = kind === "inbox" ? MAX_INBOX_BYTES : MAX_OUTBOX_BYTES;
  const files = parseTar(raw, limit);
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) throw new Error("bundle manifest is missing");
  const manifest = parseManifest(manifestBytes, files);
  if (kind && manifest.kind !== kind) throw new Error("bundle kind does not match the requested operation");
  return { manifest, files, tarBytes: raw };
}

/** Decrypt completely before parsing so failed authentication cannot cause partial application. */
export async function readBundle(file: string, passphrase: string, kind?: BundleManifest["kind"]): Promise<Bundle> {
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const stat = await fh.stat();
  if (!stat.isFile()) { await fh.close(); throw new Error("bundle source is not a regular file"); }
  const max = kind === "inbox" ? MAX_INBOX_BYTES : MAX_OUTBOX_BYTES;
  if (stat.size > max) { await fh.close(); throw new Error("encrypted bundle exceeds the size limit"); }
  const proc = Bun.spawn([Bun.which("age") ?? "age", "-d", "-j", "batchpass"], {
    env: { ...process.env, AGE_PASSPHRASE_FD: "3", AGE_PASSPHRASE: undefined, AGE_PASSPHRASE_WORK_FACTOR: undefined },
    stdio: [fh.fd, "pipe", "pipe", "pipe"],
  });
  let stderr = "";
  const stderrDrain = (async () => {
    for await (const chunk of proc.stderr) {
      if (stderr.length < 4096) stderr += new TextDecoder().decode(chunk).slice(0, 4096 - stderr.length);
    }
  })();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = setTimeout(() => { try { proc.kill(); } catch { /* process already exited */ } }, AGE_DECRYPT_TIMEOUT_MS);
  try {
    // Register process completion before draining either stream. The ciphertext
    // descriptor is already pinned and is age's stdin, so a path swap cannot
    // substitute another file after the no-follow open.
    const exited = proc.exited;
    const passphraseFd = proc.stdio[3];
    if (passphraseFd === null) throw new Error("age passphrase pipe is unavailable");
    writeSync(passphraseFd, `${passphrase}\n`);
    closeSync(passphraseFd);
    for await (const chunk of proc.stdout) {
      size += chunk.byteLength;
      if (size > max) { proc.kill(); throw new Error("bundle exceeds the size limit"); }
      chunks.push(chunk);
    }
    const [status] = await Promise.all([exited, stderrDrain]);
    if (status !== 0) throw new Error("age could not authenticate the bundle");
    const raw = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    return parseBundleTar(raw, kind);
  } catch (error) {
    try { proc.kill(); } catch { /* already exited */ }
    await Promise.allSettled([proc.exited, stderrDrain]);
    throw error;
  } finally { clearTimeout(timeout); await fh.close(); }
}
