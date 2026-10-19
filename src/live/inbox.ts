import { createHash, randomUUID } from "node:crypto";
import { open as openFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { parseBundleTar, type Bundle, type BundleManifest } from "./bundle.ts";
import { classify } from "./path-classes.ts";
import { appendHomeFile, openHomeDirectory, openParent, readHomeFile, writeHomeFileAtomic } from "./safe-fs.ts";
import { decodeJwtPayload, readPiEntry } from "../identities/oauth-reconcile.ts";
import { canonicalConfig } from "./portable.ts";
import { hasOpenOwner } from "../sync/tree-merge.ts";
import { withOauthRefreshLock } from "../identities/claude-swap-lock.ts";

interface InboxState {
  version: 1;
  lastInboxSeq: number;
  hashes: Record<string, string>;
}

export interface InboxClock {
  synchronized: boolean;
  imageBuildTimeMs: number;
  newestPersistedMtimeMs: number;
  httpDateMs?: number;
  online?: boolean;
  nowMs: number;
}

export interface InboxResult {
  applied: number;
  skipped: number;
  conflicts: string[];
  deferred?: string;
  lastInboxSeq: number;
}

export interface ApplyInboxDeps {
  tar: Uint8Array;
  home?: string;
  statePath?: string;
  clock: InboxClock;
  isTTY?: boolean;
  chooseConflict?: (path: string) => Promise<"drive" | "bundle">;
  log?: (message: string) => void;
  lastInboxSeq?: number;
  /** Test seam for exercising the active-writer safety check. */
  hasOpenOwner?: (path: string) => Promise<boolean | undefined>;
  /** Test seam for a non-cooperating provider write after merge and temp fsync. */
  beforeAuthRename?: (path: string, attempt: number) => Promise<void>;
  /** Test seam for a concurrent log append after the latest read. */
  beforeLogAppend?: (path: string) => Promise<void>;
}

const STATE_REL = ".ais/live/exchange-state.json";

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export function configHash(path: string, bytes: Uint8Array): string {
  const canonical = canonicalConfig(path, bytes);
  if (!path.endsWith(".json")) return hash(canonical);
  return hash(new TextEncoder().encode(JSON.stringify(stable(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(canonical))))));
}

function plausible(clock: InboxClock): boolean {
  if (![clock.nowMs, clock.imageBuildTimeMs, clock.newestPersistedMtimeMs].every(Number.isFinite)) return false;
  if (clock.nowMs <= clock.imageBuildTimeMs) return false;
  if (clock.nowMs < clock.newestPersistedMtimeMs) return false;
  if (clock.online && (clock.httpDateMs === undefined || !Number.isFinite(clock.httpDateMs) || Math.abs(clock.nowMs - clock.httpDateMs) > 60 * 60 * 1000)) return false;
  if (clock.httpDateMs !== undefined && Math.abs(clock.nowMs - clock.httpDateMs) > 60 * 60 * 1000) return false;
  return true;
}

function seconds(value: unknown, key: string): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (/Ms$|Millis/i.test(key) || value > 100_000_000_000) return value / 1000;
  return value;
}

function grantMintedTime(value: Record<string, unknown>): number | undefined {
  const stamps: number[] = [];
  for (const key of ["minted_at", "mintedAt", "last_refresh", "lastRefresh", "last_refreshed_at", "refreshed_at", "updated_at"]) {
    const stamp = seconds(value[key], key);
    if (stamp !== undefined) stamps.push(stamp);
  }
  for (const key of ["access_token", "accessToken", "access", "token"]) {
    const token = value[key];
    if (typeof token === "string") {
      const claims = decodeJwtPayload(token);
      if (typeof claims?.iat === "number" && Number.isFinite(claims.iat)) stamps.push(claims.iat);
    }
  }
  for (const key of ["claudeAiOauth", "tokens"]) {
    const nested = value[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const stamp = grantMintedTime(nested as Record<string, unknown>);
      if (stamp !== undefined) stamps.push(stamp);
    }
  }
  return stamps.length ? Math.max(...stamps) : undefined;
}

function grantExpiryTime(value: Record<string, unknown>): number | undefined {
  const stamps: number[] = [];
  for (const key of ["expires_at", "expiresAt", "expires", "expiry", "expiry_date"]) {
    const stamp = seconds(value[key], key);
    if (stamp !== undefined) stamps.push(stamp);
  }
  for (const key of ["claudeAiOauth", "tokens"]) {
    const nested = value[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const stamp = grantExpiryTime(nested as Record<string, unknown>);
      if (stamp !== undefined) stamps.push(stamp);
    }
  }
  return stamps.length ? Math.max(...stamps) : undefined;
}

function grantTime(value: Record<string, unknown>): number {
  return grantMintedTime(value) ?? grantExpiryTime(value) ?? -1;
}

function containsGrant(value: Record<string, unknown>): boolean {
  return ["access_token", "accessToken", "access", "refresh_token", "refreshToken", "refresh", "token", "apiKey", "api_key"].some((key) => key in value);
}

function isAtomicGrant(value: Record<string, unknown>): boolean {
  if (containsGrant(value)) return true;
  for (const key of ["tokens", "claudeAiOauth"]) {
    const nested = value[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested) && containsGrant(nested as Record<string, unknown>)) return true;
  }
  return false;
}

async function piGrantTime(root: FileHandle, provider: string, entry: Record<string, unknown>): Promise<number> {
  const path = `.ais/live/.grant-snapshot-${randomUUID()}.json`;
  const parent = await openParent(root, path.split("/"), true);
  const bytes = new TextEncoder().encode(JSON.stringify({ [provider]: entry }));
  const tempName = `.${parent.leaf}.tmp-${randomUUID()}`;
  let created = false;
  try {
    const file = await openFile(`/proc/self/fd/${parent.dir.fd}/${tempName}`, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(`/proc/self/fd/${parent.dir.fd}/${tempName}`, `/proc/self/fd/${parent.dir.fd}/${parent.leaf}`);
    created = true;
    const copy = await readPiEntry(`/proc/self/fd/${parent.dir.fd}/${parent.leaf}`, provider);
    return copy?.grant.minted_at ?? copy?.grant.expires_at ?? -1;
  } finally {
    await unlink(`/proc/self/fd/${parent.dir.fd}/${created ? parent.leaf : tempName}`).catch(() => undefined);
    if (parent.dir !== root) await parent.dir.close();
  }
}

async function mergeAuth(current: unknown, incoming: unknown, root: FileHandle, provider?: string): Promise<unknown> {
  if (!current || typeof current !== "object" || Array.isArray(current) || !incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const oldRecord = current as Record<string, unknown>;
  const newRecord = incoming as Record<string, unknown>;
  if (isAtomicGrant(oldRecord) && isAtomicGrant(newRecord)) {
    const oldTime = provider && oldRecord.type === "oauth" ? await piGrantTime(root, provider, oldRecord) : grantTime(oldRecord);
    const newTime = provider && newRecord.type === "oauth" ? await piGrantTime(root, provider, newRecord) : grantTime(newRecord);
    return oldTime >= newTime ? current : incoming;
  }
  const merged: Record<string, unknown> = { ...oldRecord };
  for (const [key, value] of Object.entries(newRecord)) {
    const oldValue = oldRecord[key];
    if (oldValue && typeof oldValue === "object" && !Array.isArray(oldValue) && value && typeof value === "object" && !Array.isArray(value)) {
      const oldNested = oldValue as Record<string, unknown>; const newNested = value as Record<string, unknown>;
      merged[key] = await mergeAuth(oldNested, newNested, root, key);
    } else merged[key] = key in oldRecord ? await mergeAuth(oldValue, value, root) : value;
  }
  return merged;
}

function missingLogLines(current: Uint8Array | undefined, incoming: Uint8Array): Uint8Array {
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).split(/\r?\n/).filter(Boolean);
  const existingLines = decode(current ?? new Uint8Array());
  const counts = new Map<string, number>();
  for (const line of existingLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const additions: string[] = [];
  for (const line of decode(incoming)) {
    const count = counts.get(line) ?? 0;
    if (count > 0) counts.set(line, count - 1);
    else additions.push(line);
  }
  if (!additions.length) return new Uint8Array();
  const separator = current?.byteLength && current.at(-1) !== 10 ? "\n" : "";
  return new TextEncoder().encode(`${separator}${additions.join("\n")}\n`);
}

class AuthTargetChanged extends Error {}

async function readState(root: FileHandle, path: string): Promise<InboxState> {
  const bytes = await readHomeFile(root, path);
  if (!bytes) return { version: 1, lastInboxSeq: 0, hashes: {} };
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<InboxState>;
    if (value.version !== 1 || !Number.isSafeInteger(value.lastInboxSeq) || value.lastInboxSeq! < 0 || !value.hashes || typeof value.hashes !== "object" || Array.isArray(value.hashes)) throw new Error();
    if (Object.entries(value.hashes).some(([path, digest]) => !path || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) throw new Error();
    return value as InboxState;
  } catch { throw new Error("live exchange state is invalid"); }
}

export async function applyInbox(deps: ApplyInboxDeps): Promise<InboxResult> {
  const home = deps.home ?? homedir();
  const statePath = deps.statePath ?? STATE_REL;
  const bundle: Bundle = parseBundleTar(deps.tar, "inbox");
  const root = await openHomeDirectory(home);
  try {
    const state = await readState(root, statePath);
    if (deps.lastInboxSeq !== undefined && (!Number.isSafeInteger(deps.lastInboxSeq) || deps.lastInboxSeq < 0)) throw new Error("lastInboxSeq must be a non-negative safe integer");
    const lastInboxSeq = Math.max(state.lastInboxSeq, deps.lastInboxSeq ?? 0);
    if (bundle.manifest.seq <= lastInboxSeq) {
      return { applied: 0, skipped: bundle.manifest.entries.length, conflicts: [], lastInboxSeq };
    }
    const authEntries = bundle.manifest.entries.filter((entry) => entry.class === "auth");
    const authReady = authEntries.length === 0 || plausible(deps.clock);
    if (!authReady) {
      deps.log?.("AIS-LIVE: stage=inbox status=deferred");
      return { applied: 0, skipped: bundle.manifest.entries.length, conflicts: [], deferred: "clock is not plausible for credential merge", lastInboxSeq };
    }

    const conflicts: string[] = [];
    const decisions = new Map<string, "drive" | "bundle">();
    for (const entry of bundle.manifest.entries) {
      if (!entry.class.startsWith("config:")) continue;
      const current = await readHomeFile(root, entry.path);
      const baseline = state.hashes[entry.path];
      const incoming = bundle.files.get(entry.path);
      if (current && incoming && baseline && configHash(entry.path, current) !== baseline && configHash(entry.path, incoming) !== baseline && configHash(entry.path, current) !== configHash(entry.path, incoming)) conflicts.push(entry.path);
    }
    if (conflicts.length && !deps.isTTY) {
      deps.log?.("AIS-LIVE: stage=inbox status=deferred");
      return { applied: 0, skipped: bundle.manifest.entries.length, conflicts, deferred: "configuration conflicts need a terminal", lastInboxSeq };
    }
    for (const path of conflicts) {
      if (!deps.chooseConflict) return { applied: 0, skipped: bundle.manifest.entries.length, conflicts, deferred: "configuration conflict choice is unavailable", lastInboxSeq };
      decisions.set(path, await deps.chooseConflict(path));
    }

    let applied = 0;
    const nextHashes = { ...state.hashes };
    const planned: Array<{ path: string; bytes: Uint8Array; mode?: number; hash: string; class: string }> = [];
    for (const entry of bundle.manifest.entries) {
      if (entry.class === "auth" && !authReady) continue;
      const content = bundle.files.get(entry.path);
      if (!content) continue;
      const decision = decisions.get(entry.path);
      const current = await readHomeFile(root, entry.path);
      if (decision === "drive") { nextHashes[entry.path] = configHash(entry.path, content); continue; }
      if (entry.class.startsWith("config:") && current && configHash(entry.path, current) === configHash(entry.path, content)) {
        nextHashes[entry.path] = configHash(entry.path, content);
        continue;
      }
      if (entry.class.startsWith("config:") && current && state.hashes[entry.path] && configHash(entry.path, current) !== state.hashes[entry.path] && configHash(entry.path, content) === state.hashes[entry.path]) {
        nextHashes[entry.path] = configHash(entry.path, content);
        continue;
      }
      const bytes = entry.class.startsWith("config:") ? canonicalConfig(entry.path, content) : content;
      planned.push({ path: entry.path, bytes, ...(entry.class === "ssh" ? { mode: 0o600 } : {}), hash: entry.class.startsWith("config:") ? configHash(entry.path, content) : hash(bytes), class: entry.class });
    }
    // All paths have been validated and existing contents read before writes begin.
    for (const item of planned) {
      const entry = bundle.manifest.entries.find((candidate) => candidate.path === item.path)!;
      if (item.class === "logs") {
        const incoming = bundle.files.get(item.path)!;
        const current = await readHomeFile(root, item.path);
        const additions = missingLogLines(current, incoming);
        if (additions.byteLength) {
          await deps.beforeLogAppend?.(item.path);
          await appendHomeFile(root, item.path, additions, item.mode);
          applied++;
        }
        continue;
      }
      if (entry.class === "auth") {
        const parent = await openParent(root, item.path.split("/"), true);
        try {
          const ownerPath = `/proc/self/fd/${parent.dir.fd}/${parent.leaf}`;
          const incoming = bundle.files.get(item.path)!;
          let completed = false;
          await withOauthRefreshLock(`/proc/self/fd/${parent.dir.fd}`, async (lock) => {
            for (let attempt = 0; attempt < 3; attempt++) {
              const owner = deps.hasOpenOwner ? await deps.hasOpenOwner(ownerPath) : await hasOpenOwner(ownerPath, { lookups: 0 });
              if (owner !== false) throw new Error(`credential file is busy or cannot be safely checked: ${item.path}`);
              const existing = await readHomeFile(parent.dir, parent.leaf);
              const expectedHash = existing === undefined ? undefined : hash(existing);
              let bytes = incoming;
              if (existing && item.path.endsWith(".json")) {
                const oldAuth = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(existing)) as Record<string, unknown>;
                const newAuth = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(incoming)) as Record<string, unknown>;
                bytes = new TextEncoder().encode(JSON.stringify(await mergeAuth(oldAuth, newAuth, root)) + "\n");
              } else if (existing) {
                bytes = incoming;
              }
              try {
                await writeHomeFileAtomic(parent.dir, parent.leaf, bytes, item.mode, async (directory, leaf) => {
                  await deps.beforeAuthRename?.(item.path, attempt);
                  const current = await readHomeFile(directory, leaf);
                  if ((current === undefined ? undefined : hash(current)) !== expectedHash || lock.isLost()) throw new AuthTargetChanged();
                });
                item.hash = hash(bytes);
                completed = true;
                break;
              } catch (error) {
                if (!(error instanceof AuthTargetChanged)) throw error;
              }
            }
          });
          if (!completed) {
            deps.log?.(`AIS-LIVE: stage=inbox status=deferred reason=credential-changed path=${item.path}`);
            return { applied, skipped: bundle.manifest.entries.length - applied, conflicts, deferred: "credential changed during restore; retry the inbox", lastInboxSeq };
          }
        } finally { if (parent.dir !== root) await parent.dir.close(); }
      } else await writeHomeFileAtomic(root, item.path, item.bytes, item.mode);
      nextHashes[item.path] = item.hash;
      if (entry.class !== "logs") applied++;
    }
    // A deferred auth merge must be retried, so its seq cannot be acknowledged yet.
    if (authReady) {
      const next: InboxState = { version: 1, lastInboxSeq: Math.max(lastInboxSeq, bundle.manifest.seq), hashes: nextHashes };
      await writeHomeFileAtomic(root, statePath, new TextEncoder().encode(JSON.stringify(next) + "\n"));
    }
    return {
      applied,
      skipped: bundle.manifest.entries.length - applied,
      conflicts,
      ...(authReady ? {} : { deferred: "clock is not plausible for credential merge" }),
      lastInboxSeq: authReady ? Math.max(lastInboxSeq, bundle.manifest.seq) : lastInboxSeq,
    };
  } finally { await root.close(); }
}

export async function readInboxStdin(stream: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024 * 1024) throw new Error("inbox exceeds the size limit");
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
