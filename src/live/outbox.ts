import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_OUTBOX_BYTES, type BundleEntry, type BundleManifest } from "./bundle.ts";
import { classify } from "./path-classes.ts";
import { openHomeDirectory, openParent, readHomeFile } from "./safe-fs.ts";
import { canonicalConfig } from "./portable.ts";

interface CollectedFile { path: string; size: number; mtimeMs: number; class: Exclude<BundleEntry["class"], "ignore">; }
const MAX_CONFIG_HASH_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 50_000;

export interface OutboxResult {
  seq: number;
  manifest: BundleManifest;
  tarBytes: Uint8Array;
  encryptedPath?: string;
  skippedSymlinks: number;
}

export interface WriteOutboxDeps {
  home?: string;
  exchangeDir?: string;
  lastInboxSeq?: number;
  now?: Date;
  readFile?: (path: string) => Promise<Uint8Array | undefined>;
  encrypt?: (tar: Uint8Array) => Promise<Uint8Array>;
}

function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function procDir(fd: number): string { return `/proc/self/fd/${fd}`; }

async function collectDirectory(directory: FileHandle, prefix: string, result: CollectedFile[], skipped: { symlinks: number; omitted: number; seen: number }, depth = 0): Promise<void> {
  if (depth > 20 || skipped.seen > MAX_SCAN_ENTRIES) { skipped.omitted++; return; }
  for (const entry of await readdir(procDir(directory.fd), { withFileTypes: true })) {
    if (++skipped.seen > MAX_SCAN_ENTRIES) { skipped.omitted++; return; }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) { skipped.symlinks++; continue; }
    if (entry.isDirectory()) {
      if (!prefix && ![...TOOL_ROOT_NAMES, ".ais"].includes(entry.name)) continue;
      if (prefix && !TOOL_ROOT_NAMES.some((root) => path === root || path.startsWith(`${root}/`)) && path !== ".ais" && !path.startsWith(".ais/")) continue;
      const child = await open(`${procDir(directory.fd)}/${entry.name}`, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
      if (!child) { skipped.symlinks++; continue; }
      try { await collectDirectory(child, path, result, skipped, depth + 1); } finally { await child.close(); }
      continue;
    }
    if (!entry.isFile()) continue;
    const fileClass = classify(path);
    // Credentials are neither payload nor input to outbox collection. In
    // particular, do not open a credential file just to inspect its size.
    if (fileClass === "ignore" || fileClass === "ssh" || fileClass === "auth") continue;
    const file = await open(`${procDir(directory.fd)}/${entry.name}`, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => undefined);
    if (!file) { skipped.symlinks++; continue; }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) continue;
      const cap = fileClass === "logs" ? MAX_OUTBOX_BYTES : MAX_CONFIG_HASH_BYTES;
      if (stat.size > cap) {
        if (fileClass === "logs") { skipped.omitted++; continue; }
        throw new Error(`configuration file exceeds the hash limit: ${path}`);
      }
      result.push({ path, size: stat.size, mtimeMs: stat.mtimeMs, class: fileClass });
    } finally { await file.close(); }
  }
}

async function openRelative(root: FileHandle, relative: string): Promise<FileHandle> {
  const components = relative.split("/");
  let current = root;
  let owned: FileHandle | undefined;
  try {
    for (const [index, component] of components.entries()) {
      if (!component || component === "." || component === "..") throw new Error("invalid home-relative path");
      const next = await open(`${procDir(current.fd)}/${component}`, constants.O_RDONLY | (index < components.length - 1 ? (constants.O_DIRECTORY ?? 0) : (constants.O_NONBLOCK ?? 0)) | (constants.O_NOFOLLOW ?? 0));
      if (owned) await owned.close();
      owned = next;
      current = next;
    }
    if (!owned) throw new Error("empty home-relative path");
    return owned;
  } catch (error) { await owned?.close().catch(() => undefined); throw error; }
}

async function readBounded(root: FileHandle, path: string, maxBytes: number): Promise<Uint8Array> {
  const file = await openRelative(root, path);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`file exceeds its read limit: ${path}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`file grew beyond its read limit: ${path}`);
      chunks.push(buffer.slice(0, bytesRead));
    }
    return joinBytes(chunks);
  } finally { await file.close(); }
}

const TOOL_ROOT_NAMES = [".claude", ".codex", ".grok", ".kimi-code", ".pi", ".opencode", ".zai", ".ali"];

function writeOctal(header: Uint8Array, start: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  header.set(new TextEncoder().encode(text), start);
}

function tarFile(path: string, content: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const fullName = encoder.encode(path);
  let name = fullName;
  let prefix = new Uint8Array();
  if (fullName.length > 100) {
    const split = path.lastIndexOf("/");
    if (split < 1) throw new Error(`bundle path is too long: ${path}`);
    prefix = encoder.encode(path.slice(0, split));
    name = encoder.encode(path.slice(split + 1));
    if (name.length > 100 || prefix.length > 155) throw new Error(`bundle path is too long: ${path}`);
  }
  const header = new Uint8Array(512);
  header.set(name, 0);
  header.set(prefix, 345);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(32, 148, 156);
  header[156] = 48;
  header.set(new TextEncoder().encode("ustar\0"), 257);
  header.set(new TextEncoder().encode("00"), 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
  header.set(new TextEncoder().encode(checksum), 148);
  const padded = new Uint8Array(Math.ceil(content.byteLength / 512) * 512);
  padded.set(content);
  const output = new Uint8Array(header.byteLength + padded.byteLength);
  output.set(header);
  output.set(padded, header.byteLength);
  return output;
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function nextSequence(root: FileHandle): Promise<number> {
  const { dir, leaf } = await openParent(root, [".ais", "live", "outbox-seq.json"], true);
  const statePath = `${procDir(dir.fd)}/${leaf}`;
  const lockPath = `${procDir(dir.fd)}/.outbox.lock`;
  let lock: FileHandle;
  try { lock = await open(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch { await dir.close(); throw new Error("another outbox writer holds the sequence lock"); }
  try {
    const lockStat = await lock.stat();
    if (!lockStat.isFile()) throw new Error("outbox sequence lock is unsafe");
    const flock = Bun.which("flock");
    if (!flock) throw new Error("flock is required for outbox sequence locking");
    const lockResult = Bun.spawnSync([flock, "-n", "-x", "3"], { stdio: ["ignore", "ignore", "ignore", lock.fd] });
    if (lockResult.exitCode !== 0) throw new Error("another outbox writer holds the sequence lock");
    let seq = 0;
    try {
      const old = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await old.stat();
        if (!stat.isFile() || stat.size > 4096) throw new Error("outbox sequence state is invalid");
        const buffer = new Uint8Array(4097);
        const { bytesRead } = await old.read(buffer, 0, buffer.byteLength, 0);
        if (bytesRead > 4096) throw new Error("outbox sequence state is invalid");
        const parsed = JSON.parse(new TextDecoder().decode(buffer.subarray(0, bytesRead))) as { version?: number; seq?: number };
        if (parsed.version !== 1 || !Number.isSafeInteger(parsed.seq) || parsed.seq! < 0 || parsed.seq === Number.MAX_SAFE_INTEGER) throw new Error("outbox sequence state is invalid");
        seq = parsed.seq!;
      } finally { await old.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    seq++;
    const temp = `${procDir(dir.fd)}/.outbox-seq-${crypto.randomUUID()}.tmp`;
    const output = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await output.writeFile(JSON.stringify({ version: 1, seq }) + "\n"); await output.sync(); } finally { await output.close(); }
    await rename(temp, statePath);
    await dir.sync();
    return seq;
  } finally { await lock.close(); await dir.close(); }
}

/** Collect a snapshot as agent, then optionally encrypt and atomically publish it. */
export async function writeOutbox(deps: WriteOutboxDeps = {}): Promise<OutboxResult> {
  if (deps.lastInboxSeq !== undefined && (!Number.isSafeInteger(deps.lastInboxSeq) || deps.lastInboxSeq < 0)) {
    throw new Error("lastInboxSeq must be a non-negative safe integer");
  }
  const home = deps.home ?? homedir();
  const exchange = deps.exchangeDir;
  const root = await openHomeDirectory(home);
  let seq: number;
  try { seq = await nextSequence(root); }
  catch (error) { await root.close(); throw error; }
  const collected: CollectedFile[] = [];
  const skipped = { symlinks: 0, omitted: 0, seen: 0 };
  let appliedSeq = deps.lastInboxSeq;
  try {
    await collectDirectory(root, "", collected, skipped);
    if (appliedSeq === undefined) {
      const state = await readHomeFile(root, ".ais/live/exchange-state.json");
      if (state) {
        try {
        const value = JSON.parse(new TextDecoder().decode(state)) as { version?: number; lastInboxSeq?: number };
          if (value.version !== 1 || !Number.isSafeInteger(value.lastInboxSeq) || value.lastInboxSeq! < 0) throw new Error();
          appliedSeq = value.lastInboxSeq;
        } catch { throw new Error("persisted inbox sequence state is invalid"); }
      }
    }
  } catch (error) { await root.close(); throw error; }
  if (deps.readFile) {
    if (appliedSeq === undefined) {
      const extra = await deps.readFile(".ais/live/exchange-state.json");
      if (extra) {
        try {
        const value = JSON.parse(new TextDecoder().decode(extra)) as { version?: number; lastInboxSeq?: number };
          if (value.version !== 1 || !Number.isSafeInteger(value.lastInboxSeq) || value.lastInboxSeq! < 0) throw new Error();
          appliedSeq = value.lastInboxSeq;
        } catch { throw new Error("persisted inbox sequence state is invalid"); }
      }
    }
  }

  const logFiles = collected.filter((file) => file.class === "logs").sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const configFiles = collected.filter((file) => file.class.startsWith("config:"));
  const selectedLogs: CollectedFile[] = [];
  const configEstimate = configFiles.reduce((sum, file) => sum + 128 + new TextEncoder().encode(file.path).byteLength, 0);
  let selectedTarCost = 1024 + 512 + Math.ceil((configEstimate + 512) / 512) * 512 + configFiles.length * 512 + 64 * 1024;
  let logBudgetFull = false;
  for (const file of logFiles) {
    const cost = 512 + Math.ceil(file.size / 512) * 512;
    if (logBudgetFull || selectedTarCost + cost > MAX_OUTBOX_BYTES) { skipped.omitted++; logBudgetFull = true; continue; }
    selectedLogs.push(file);
    selectedTarCost += cost;
  }
  const fileBytes = new Map<string, Uint8Array>();
  const configDigests = new Map<string, { sha256: string; size: number }>();
  try {
    for (const file of configFiles) {
      const canonical = canonicalConfig(file.path, await readBounded(root, file.path, MAX_CONFIG_HASH_BYTES));
      configDigests.set(file.path, { sha256: sha(canonical), size: canonical.byteLength });
    }
    for (const file of selectedLogs) fileBytes.set(file.path, await readBounded(root, file.path, MAX_OUTBOX_BYTES));
  } finally { await root.close(); }
  const manifestBase = (entries: BundleEntry[], truncated: boolean): BundleManifest => ({
    version: 1, seq, createdAt: (deps.now ?? new Date()).toISOString(), kind: "outbox", entries,
    lastInboxSeq: appliedSeq ?? 0, truncated, skippedSymlinks: skipped.symlinks,
  });
  let truncated = skipped.omitted > 0 || selectedLogs.length < logFiles.length;
  let entries: BundleEntry[] = [];
  let manifest = manifestBase([], false);
  let manifestBytes = new Uint8Array();
  const makeEntries = () => [
    ...configFiles.map((file) => ({ path: file.path, class: file.class, sha256: configDigests.get(file.path)!.sha256, size: configDigests.get(file.path)!.size })),
    ...selectedLogs.map((file) => ({ path: file.path, class: file.class, sha256: sha(fileBytes.get(file.path)!), size: fileBytes.get(file.path)!.byteLength })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  while (true) {
    entries = makeEntries();
    manifest = manifestBase(entries, truncated);
    manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const estimated = 1024 + 512 + Math.ceil(manifestBytes.byteLength / 512) * 512 + entries.reduce((sum, entry) => sum + 512 + Math.ceil((entry.class === "logs" ? entry.size : 0) / 512) * 512, 0);
    if (estimated <= MAX_OUTBOX_BYTES) break;
    if (!selectedLogs.length) throw new Error("outbox configuration manifest exceeds the size limit");
    selectedLogs.pop();
    truncated = true;
  }
  const chunks = [tarFile("manifest.json", manifestBytes), ...selectedLogs.map((file) => tarFile(file.path, fileBytes.get(file.path)!)), new Uint8Array(1024)];
  const tarBytes = joinBytes(chunks);
  if (tarBytes.byteLength > MAX_OUTBOX_BYTES) throw new Error("outbox could not fit within its size limit");
  let encryptedPath: string | undefined;
  if (exchange && deps.encrypt) {
    const directory = join(exchange, "outbox");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const encrypted = await deps.encrypt(tarBytes);
    if (encrypted.byteLength > MAX_OUTBOX_BYTES) throw new Error("encrypted outbox exceeds the size limit");
    const finalPath = join(directory, `bundle-${seq}.age`);
    const tempPath = join(directory, `.bundle-${seq}.${crypto.randomUUID()}.tmp`);
    const file = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
    await rename(tempPath, finalPath);
    const publishedDir = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { await publishedDir.sync(); } finally { await publishedDir.close(); }
    for (const name of await readdir(directory)) {
      const match = /^bundle-(\d+)\.age$/.exec(name);
      if (match && Number(match[1]) < seq) await unlink(join(directory, name)).catch(() => undefined);
    }
    encryptedPath = finalPath;
  }
  return { seq, manifest, tarBytes, ...(encryptedPath ? { encryptedPath } : {}), skippedSymlinks: skipped.symlinks };
}
