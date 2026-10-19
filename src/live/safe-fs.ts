import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { classify } from "./path-classes.ts";

const DIR = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const FILE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const MAX_HOME_READ = 64 * 1024 * 1024;

function fdPath(fd: number, leaf = ""): string {
  return leaf ? `/proc/self/fd/${fd}/${leaf}` : `/proc/self/fd/${fd}`;
}

function validateParts(parts: string[]): void {
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0"))) {
    throw new Error("unsafe home-relative path");
  }
}

export async function openHomeDirectory(home: string): Promise<FileHandle> {
  return open(home, DIR);
}

/** Walk each component through an already-open directory descriptor. */
export async function openParent(root: FileHandle, parts: string[], create: boolean): Promise<{ dir: FileHandle; leaf: string }> {
  validateParts(parts);
  let current = root;
  const owned: FileHandle[] = [];
  try {
    for (const part of parts.slice(0, -1)) {
      if (create) await mkdir(fdPath(current.fd, part), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const next = await open(fdPath(current.fd, part), DIR);
      owned.push(next);
      current = next;
    }
    for (const handle of owned.slice(0, -1)) await handle.close();
    return { dir: current, leaf: parts.at(-1)! };
  } catch (error) {
    await Promise.all(owned.map((handle) => handle.close().catch(() => undefined)));
    throw error;
  }
}

export async function readHomeFile(root: FileHandle, path: string): Promise<Uint8Array | undefined> {
  const parent = await openParent(root, path.split("/"), false).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!parent) return undefined;
  const { dir, leaf } = parent;
  try {
    const file = await open(fdPath(dir.fd, leaf), FILE | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) return undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return undefined;
      if (stat.size > MAX_HOME_READ) throw new Error("home file exceeds the safe read limit");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const buffer = new Uint8Array(64 * 1024);
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > MAX_HOME_READ) throw new Error("home file grew beyond the safe read limit");
        chunks.push(buffer.slice(0, bytesRead));
      }
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } finally { await file.close(); }
  } finally { if (dir !== root) await dir.close(); }
}

export async function statHomeMtime(root: FileHandle, path: string): Promise<number | undefined> {
  const parent = await openParent(root, path.split("/"), false).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!parent) return undefined;
  try {
    const file = await open(fdPath(parent.dir.fd, parent.leaf), FILE | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) return undefined;
    try { const stat = await file.stat(); return stat.isFile() ? stat.mtimeMs : undefined; }
    finally { await file.close(); }
  } finally { if (parent.dir !== root) await parent.dir.close(); }
}

/** Newest timestamp among the bounded, portable profile paths persisted in home. */
export async function newestPersistedMtime(root: FileHandle): Promise<number> {
  const roots = new Set([".ais", ".claude", ".codex", ".grok", ".kimi-code", ".pi", ".opencode", ".zai", ".ali", ".ssh"]);
  const walk = async (directory: FileHandle, prefix: string, depth: number, count: { value: number }): Promise<number> => {
    // An incomplete freshness scan must never make an inbox look safe to apply.
    if (depth > 20 || count.value >= 50_000) return Number.POSITIVE_INFINITY;
    let newest = 0;
    for (const entry of await readdir(fdPath(directory.fd), { withFileTypes: true })) {
      if (++count.value > 50_000) return Number.POSITIVE_INFINITY;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && !roots.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const pathClass = classify(relative);
      if (entry.isDirectory()) {
        const rootName = relative.split("/", 1)[0]!;
        if (!roots.has(rootName)) continue;
        const child = await open(fdPath(directory.fd, entry.name), DIR).catch(() => undefined);
        if (!child) continue;
        try { newest = Math.max(newest, await walk(child, relative, depth + 1, count)); }
        finally { await child.close(); }
      } else if (entry.isFile() && (pathClass !== "ignore" || relative === ".ais/live/exchange-state.json")) {
        const file = await open(fdPath(directory.fd, entry.name), FILE | (constants.O_NONBLOCK ?? 0)).catch(() => undefined);
        if (!file) continue;
        try { const stat = await file.stat(); if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs); }
        finally { await file.close(); }
      }
    }
    return newest;
  };
  return walk(root, "", 0, { value: 0 });
}

export async function writeHomeFileAtomic(root: FileHandle, path: string, content: Uint8Array, mode = 0o600): Promise<void> {
  const { dir, leaf } = await openParent(root, path.split("/"), true);
  const temporary = `.${leaf}.ais-${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(fdPath(dir.fd, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    // rename within the anchored parent directory; no symlink target is followed.
    await rename(fdPath(dir.fd, temporary), fdPath(dir.fd, leaf));
    await dir.sync();
  } catch (error) {
    await unlink(fdPath(dir.fd, temporary)).catch(() => undefined);
    throw error;
  } finally { if (dir !== root) await dir.close(); }
}
