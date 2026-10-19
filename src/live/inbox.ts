import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { parseBundleTar, type Bundle, type BundleManifest } from "./bundle.ts";
import { classify } from "./path-classes.ts";
import { openHomeDirectory, readHomeFile, writeHomeFileAtomic } from "./safe-fs.ts";
import { mergeJsonlLineSets } from "../sync/dedupe.ts";
import { decodeJwtPayload } from "../identities/oauth-reconcile.ts";
import { canonicalConfig } from "./portable.ts";

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
}

const STATE_REL = ".ais/live/exchange-state.json";

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function configHash(path: string, bytes: Uint8Array): string { return hash(canonicalConfig(path, bytes)); }

function plausible(clock: InboxClock): boolean {
  if (![clock.nowMs, clock.imageBuildTimeMs, clock.newestPersistedMtimeMs].every(Number.isFinite)) return false;
  if (clock.nowMs <= clock.imageBuildTimeMs) return false;
  if (clock.nowMs < clock.newestPersistedMtimeMs) return false;
  if (clock.online && (clock.httpDateMs === undefined || !Number.isFinite(clock.httpDateMs))) return false;
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
  for (const key of ["access_token", "accessToken", "token"]) {
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
  return ["access_token", "accessToken", "refresh_token", "refreshToken", "token", "apiKey", "api_key"].some((key) => key in value);
}

function isAtomicGrant(value: Record<string, unknown>): boolean {
  if (containsGrant(value)) return true;
  for (const key of ["tokens", "claudeAiOauth"]) {
    const nested = value[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested) && containsGrant(nested as Record<string, unknown>)) return true;
  }
  return false;
}

function mergeAuth(current: unknown, incoming: unknown): unknown {
  if (!current || typeof current !== "object" || Array.isArray(current) || !incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const oldRecord = current as Record<string, unknown>;
  const newRecord = incoming as Record<string, unknown>;
  if (isAtomicGrant(oldRecord) && isAtomicGrant(newRecord)) return grantTime(oldRecord) > grantTime(newRecord) ? current : incoming;
  const merged: Record<string, unknown> = { ...oldRecord };
  for (const [key, value] of Object.entries(newRecord)) {
    merged[key] = key in oldRecord ? mergeAuth(oldRecord[key], value) : value;
  }
  return merged;
}

function authFreshness(bytes: Uint8Array): number {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    return grantTime(parsed);
  } catch { return -1; }
}

function mergeLogs(current: Uint8Array | undefined, incoming: Uint8Array): Uint8Array {
  if (!current?.byteLength) return incoming;
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).split(/\r?\n/).filter(Boolean);
  const lines = mergeJsonlLineSets([decode(current), decode(incoming)]);
  return new TextEncoder().encode(lines.join("\n") + (lines.length ? "\n" : ""));
}

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
    if (bundle.manifest.seq <= state.lastInboxSeq) {
      return { applied: 0, skipped: bundle.manifest.entries.length, conflicts: [], lastInboxSeq: state.lastInboxSeq };
    }
    const authEntries = bundle.manifest.entries.filter((entry) => entry.class === "auth");
    const authReady = authEntries.length === 0 || plausible(deps.clock);
    if (!authReady) {
      deps.log?.("AIS-LIVE: stage=inbox status=deferred");
      return { applied: 0, skipped: bundle.manifest.entries.length, conflicts: [], deferred: "clock is not plausible for credential merge", lastInboxSeq: state.lastInboxSeq };
    }

    const conflicts: string[] = [];
    const decisions = new Map<string, "drive" | "bundle">();
    for (const entry of bundle.manifest.entries) {
      if (!entry.class.startsWith("config:")) continue;
      const current = await readHomeFile(root, entry.path);
      const baseline = state.hashes[entry.path];
      if (current && baseline && configHash(entry.path, current) !== baseline && entry.sha256 !== baseline && configHash(entry.path, current) !== entry.sha256) conflicts.push(entry.path);
    }
    if (conflicts.length && !deps.isTTY) {
      deps.log?.("AIS-LIVE: stage=inbox status=deferred");
      return { applied: 0, skipped: bundle.manifest.entries.length, conflicts, deferred: "configuration conflicts need a terminal", lastInboxSeq: state.lastInboxSeq };
    }
    for (const path of conflicts) {
      if (!deps.chooseConflict) return { applied: 0, skipped: bundle.manifest.entries.length, conflicts, deferred: "configuration conflict choice is unavailable", lastInboxSeq: state.lastInboxSeq };
      decisions.set(path, await deps.chooseConflict(path));
    }

    let applied = 0;
    const nextHashes = { ...state.hashes };
    const planned: Array<{ path: string; bytes: Uint8Array; mode?: number; hash: string }> = [];
    for (const entry of bundle.manifest.entries) {
      if (entry.class === "auth" && !authReady) continue;
      const content = bundle.files.get(entry.path);
      if (!content) continue;
      const decision = decisions.get(entry.path);
      const current = await readHomeFile(root, entry.path);
      if (decision === "drive") { nextHashes[entry.path] = entry.sha256; continue; }
      if (entry.class.startsWith("config:") && current && state.hashes[entry.path] && configHash(entry.path, current) !== state.hashes[entry.path] && entry.sha256 === state.hashes[entry.path]) {
        nextHashes[entry.path] = entry.sha256;
        continue;
      }
      let bytes = entry.class === "logs" ? mergeLogs(current, content) : entry.class.startsWith("config:") ? canonicalConfig(entry.path, content) : content;
      if (entry.class === "auth" && current) {
        try { bytes = new TextEncoder().encode(JSON.stringify(mergeAuth(JSON.parse(new TextDecoder().decode(current)), JSON.parse(new TextDecoder().decode(content)))) + "\n"); }
        catch { bytes = authFreshness(current) > authFreshness(content) ? current : content; }
      }
      planned.push({ path: entry.path, bytes, ...(entry.class === "ssh" ? { mode: 0o600 } : {}), hash: hash(bytes) });
    }
    // All paths have been validated and existing contents read before writes begin.
    for (const item of planned) {
      await writeHomeFileAtomic(root, item.path, item.bytes, item.mode);
      nextHashes[item.path] = item.hash;
      applied++;
    }
    // A deferred auth merge must be retried, so its seq cannot be acknowledged yet.
    if (authReady) {
      const next: InboxState = { version: 1, lastInboxSeq: bundle.manifest.seq, hashes: nextHashes };
      await writeHomeFileAtomic(root, statePath, new TextEncoder().encode(JSON.stringify(next) + "\n"));
    }
    return {
      applied,
      skipped: bundle.manifest.entries.length - applied,
      conflicts,
      ...(authReady ? {} : { deferred: "clock is not plausible for credential merge" }),
      lastInboxSeq: authReady ? bundle.manifest.seq : state.lastInboxSeq,
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
