import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { readOpencodeV2Credentials } from "../cli/limits/opencode-limits.ts";
import { heartbeatPath } from "../identities/gateway-heartbeat.ts";
import { enableMemberStore, hasMemberCopy, isMemberStoreTool, memberDir } from "../identities/gateway-members.ts";
import { REVOKED_MARKER_FILE } from "../identities/gateway-revoked.ts";
import { effectiveGrantPaths, type RefreshableTool } from "../identities/oauth-refresh.ts";
import { isRetired } from "../identities/retired.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import type { Identity } from "../identities/types.ts";
import { loadGatewayGuard } from "../sync/gateway-guard.ts";
import { storeMayHoldLogin } from "./host-login-gate.ts";
import { isFresher, isPlaceholderLogin, isRefreshableLogin, isReplacedLogin, losesLogin, mergeByKey, refreshFingerprints, REPLACED_MARKER_FILE } from "./home-mirror.ts";
import { sha256Hex, type HomeFileKind, type HomeStoreClient } from "./home-store.ts";
import { droppedIdentities, mergeRegistries, readRegistryBase } from "./registry-sync.ts";
import type { RefreshGuardBackend } from "./refresh-guard.ts";

/**
 * One-time (and idempotent) import of the gateway's login files from a host HOME into the PostgreSQL store. Run on the
 * host that holds the files (`ais gateway store import`), or at gateway startup with AIS_GATEWAY_STORE_IMPORT=1 on a
 * replica whose HOME is the host's files. Re-running only uploads what changed:
 * - a path the store lacks is added;
 * - host files and markers take the host copy;
 * - a registry follows the host mirror's rule (registry-sync.ts): a host copy that did not move since it was last in step with
 *   the store is never pushed over a newer row (a console add), a host copy that moved alone is pushed, and when both moved
 *   (or nothing was recorded) the two are merged per identity name and the merge is pushed;
 * - a login is replaced only by a strictly fresher grant (later expiry), under the account's refresh lock, and never by
 *   a refresh token the journal shows already rotated out;
 * - the heartbeat is only seeded.
 * Login rows go before the registries, so a replica that reads a new registry already finds the logins it needs. A host-owned claude
 * login (one the gateway does not manage, host-login-gate.ts) is never uploaded; the rows older versions uploaded stay until
 * `ais gateway store prune` removes them: run it once when this version rolls out.
 */

/** File that records the host home the registries were written on, so a replica on another node can translate their paths. */
export const STORE_META_PATH = ".ais/gateway-store-meta.json";
/** Opencode's credential when only its SQLite database holds it: a small file the gateway reads on scratch replicas. */
export const OPENCODE_GATEWAY_KEY_FILE = join("data", "opencode", "ais-gateway-key.json");

/** The login files that hold a refresh token: claude `.credentials.json`, codex and pi `auth.json`. */
const MAIN_LOGIN_FILES = new Set([".credentials.json", "auth.json"]);

const OAUTH_TOOLS: readonly RefreshableTool[] = ["claude", "codex", "grok", "kimi"];

export interface ImportEntry {
  abs: string;
  account: string | null;
  kind: HomeFileKind;
  /** Content made by the import (meta, derived files) instead of read from `abs`. */
  content?: Buffer;
}

export interface ImportReport {
  added: string[];
  updated: string[];
  unchanged: string[];
  /** Kept the store's copy, with why ("store is fresher", "rotated out", "outside HOME"...). */
  skipped: Array<{ path: string; why: string }>;
}

const exists = async (p: string): Promise<boolean> => stat(p).then((s) => s.isFile(), () => false);

/**
 * Content of the derived Go key file for an OpenCode identity folder, or undefined when its SQLite database holds no
 * usable Go credential. The database is not mirrored, so its credential travels in this file. OpenCode v2 writes logins
 * only to the database and never updates auth.json again, so the file is made even when auth.json still holds a key
 * (a Console sign-in leaves the old, possibly expired, auth.json key in place).
 */
export async function opencodeDerivedKeyFile(configDir: string): Promise<Buffer | undefined> {
  const v2 = (await readOpencodeV2Credentials(configDir).catch(() => undefined))?.find((c) => c.provider === "opencode-go")?.entry.key;
  if (typeof v2 !== "string" || !v2.trim()) return undefined;
  return Buffer.from(`${JSON.stringify({ "opencode-go": { type: "api", key: v2 } })}\n`);
}

/** Every file the gateway needs, from the registries under the current HOME (member-store view, as the gateway sees it). */
export async function collectImportEntries(home: string = homedir()): Promise<ImportEntry[]> {
  enableMemberStore();
  const out: ImportEntry[] = [];
  const seen = new Set<string>();
  const add = (e: ImportEntry): void => {
    if (seen.has(e.abs)) return;
    seen.add(e.abs);
    out.push(e);
  };
  const guard = await loadGatewayGuard(home);
  // The registries go last: a replica that applies a new registry (pool membership) must already find the login rows it needs.
  const registries: ImportEntry[] = [];
  for (const [tool, cfg] of Object.entries(TOOL_CONFIGS)) {
    if (!(await exists(cfg.identitiesJsonPath))) continue;
    registries.push({ abs: cfg.identitiesJsonPath, account: null, kind: "registry" });
    let identities: Identity[];
    try {
      identities = (await loadIdentitiesFile(cfg.identitiesJsonPath)).identities;
    } catch {
      continue;
    }
    for (const id of identities) {
      if (isRetired(id)) continue;
      const account = `${tool}/${id.name}`;
      if ((OAUTH_TOOLS as readonly string[]).includes(tool)) {
        // A claude or codex login the gateway does not manage belongs to the host (host-login-gate.ts): never upload it, nor pi's copy of it.
        if (!(await storeMayHoldLogin(tool, id, home, guard).catch(() => false))) continue;
        for (const p of await effectiveGrantPaths(tool as RefreshableTool, id).catch(() => [] as string[])) {
          if (!(await exists(p))) continue;
          // A pi copy belongs to the pi identity; the claude/codex/kimi refresh pulls it by path.
          const piOwned = !p.startsWith(id.configDir + sep);
          add({ abs: p, account: piOwned ? `pi/${id.name}` : account, kind: "login" });
        }
        if (isMemberStoreTool(tool) && hasMemberCopy(tool, id.name)) {
          const dir = memberDir(tool, id.name);
          if (tool === "claude" && (await exists(join(dir, ".claude.json")))) add({ abs: join(dir, ".claude.json"), account, kind: "login" });
          if (await exists(join(dir, REVOKED_MARKER_FILE))) add({ abs: join(dir, REVOKED_MARKER_FILE), account, kind: "marker" });
          if (await exists(join(dir, REPLACED_MARKER_FILE))) add({ abs: join(dir, REPLACED_MARKER_FILE), account, kind: "marker" });
        }
      } else if (tool === "zai" || tool === "ali") {
        const p = join(id.configDir, "crush.json");
        if (await exists(p)) add({ abs: p, account, kind: "hostfile" });
      } else if (tool === "opencode") {
        const p = join(id.configDir, "data", "opencode", "auth.json");
        if (await exists(p)) add({ abs: p, account, kind: "hostfile" });
        const derived = await opencodeDerivedKeyFile(id.configDir);
        if (derived) add({ abs: join(id.configDir, OPENCODE_GATEWAY_KEY_FILE), account, kind: "derived", content: derived });
      }
    }
  }
  for (const r of registries) add(r);
  if (await exists(heartbeatPath())) add({ abs: heartbeatPath(), account: null, kind: "heartbeat" });
  add({ abs: join(home, ...STORE_META_PATH.split("/")), account: null, kind: "meta", content: Buffer.from(`${JSON.stringify({ hostHome: process.env.AIS_HOST_HOME?.trim() || home })}\n`) });
  return out;
}

/** True for a JSON object with more than one top-level entry (a shared pi auth.json, claude with mcpOAuth). */
const isMultiEntry = (text: string): boolean => {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 1;
  } catch {
    return false;
  }
};

const sameJsonText = (a: string, b: string): boolean => {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
};

const relOf = (home: string, abs: string): string | undefined => {
  const r = relative(home, abs);
  return r === "" || r.startsWith("..") || r.startsWith(sep) ? undefined : r.split(sep).join("/");
};

export async function importHome(
  store: Pick<HomeStoreClient, "get" | "put">,
  opts: { home?: string; dryRun?: boolean; lock?: RefreshGuardBackend; entries?: ImportEntry[]; lockTimeoutMs?: number } = {},
): Promise<ImportReport> {
  const home = opts.home ?? homedir();
  const report: ImportReport = { added: [], updated: [], unchanged: [], skipped: [] };
  const handle = async (e: ImportEntry): Promise<void> => {
    const rel = relOf(home, e.abs);
    if (!rel) {
      report.skipped.push({ path: e.abs, why: "outside HOME" });
      return;
    }
    const content = e.content ?? (await readFile(e.abs).catch(() => undefined));
    if (!content) return;
    // A placeholder or a file without a refresh token is no login: it never reaches the store, whatever the row holds.
    // Only a tool's main login file is checked: the member account record (.claude.json) holds no refresh token and travels as is.
    if (e.kind === "login" && MAIN_LOGIN_FILES.has(basename(rel))) {
      const text = content.toString("utf8");
      if (isPlaceholderLogin(text)) {
        report.skipped.push({ path: rel, why: "it holds a gateway placeholder, not a login" });
        return;
      }
      if (!isRefreshableLogin(text)) {
        report.skipped.push({ path: rel, why: "it holds no refresh token" });
        return;
      }
    }
    const once = async (): Promise<void> => {
      if (e.kind === "login" && (await isReplacedLogin(store, rel, content.toString("utf8")))) {
        report.skipped.push({ path: rel, why: "it holds a login the owner replaced with another account's" });
        return;
      }
      const [row] = await store.get([rel]);
      if (!row) {
        if (!opts.dryRun) {
          const r = await store.put(rel, content, { account: e.account, kind: e.kind, expectedVersion: null });
          if (!r.ok) return once();
        }
        report.added.push(rel);
        return;
      }
      if (row.sha256 === sha256Hex(content)) {
        report.unchanged.push(rel);
        return;
      }
      if (e.kind === "heartbeat") {
        report.skipped.push({ path: rel, why: "the store already has a heartbeat" });
        return;
      }
      const multi = e.kind === "login" && isMultiEntry(content.toString("utf8")) && mergeByKey(content.toString("utf8"), row.content.toString("utf8")) !== undefined;
      if (e.kind === "login" && !multi) {
        if (!isFresher(content.toString("utf8"), row.content.toString("utf8"))) {
          report.skipped.push({ path: rel, why: "the store's grant is as fresh or fresher" });
          return;
        }
      }
      let body = content;
      if (e.kind === "login") {
        // A multi-entry login (pi auth.json, claude with mcpOAuth) is merged per entry: the older token of one entry never replaces a newer one,
        // and a gateway entry never replaces a real one. It is pushed only when the merge loses nothing and differs from the row.
        const merged = multi ? mergeByKey(content.toString("utf8"), row.content.toString("utf8")) : undefined;
        if (merged) {
          if (losesLogin(merged.toString("utf8"), row.content.toString("utf8"))) {
            report.skipped.push({ path: rel, why: "it would replace a login the gateway can renew with one it cannot" });
            return;
          }
          if (sameJsonText(merged.toString("utf8"), row.content.toString("utf8"))) {
            report.skipped.push({ path: rel, why: "the store's grant is as fresh or fresher" });
            return;
          }
          body = merged;
        } else if (losesLogin(content.toString("utf8"), row.content.toString("utf8"))) {
          report.skipped.push({ path: rel, why: "it would replace a login the gateway can renew with one it cannot" });
          return;
        }
      }
      if (e.kind === "registry") {
        const last = await readRegistryBase(home, rel);
        if (last && last.sha === sha256Hex(content)) {
          report.skipped.push({ path: rel, why: "the store's registry is newer and the host copy did not change" });
          return;
        }
        // A host copy that drops an identity the store holds is merged, never pushed as is: removal goes through retire.
        if (!last || last.sha !== row.sha256 || droppedIdentities(content.toString("utf8"), row.content.toString("utf8")).length > 0) {
          const merged = mergeRegistries(content.toString("utf8"), row.content.toString("utf8"), last?.names ? { baseNames: last.names } : {});
          if (!merged && droppedIdentities(content.toString("utf8"), row.content.toString("utf8")).length > 0) {
            report.skipped.push({ path: rel, why: "the host copy is no registry and would drop identities the store holds" });
            return;
          }
          if (merged) {
            if (sha256Hex(merged) === row.sha256) {
              report.skipped.push({ path: rel, why: "the store's registry already holds every host identity" });
              return;
            }
            body = merged;
          }
        }
      }
      if (!opts.dryRun) {
        const r = await store.put(rel, body, { account: e.account, kind: e.kind, expectedVersion: row.version });
        if (!r.ok) return once();
      }
      report.updated.push(rel);
    };
    if (e.kind === "login" && e.account && opts.lock && !opts.dryRun) {
      const [provider, ...rest] = e.account.split("/");
      const lock = await opts.lock.acquire({ provider: provider!, identity: rest.join("/") }, opts.lockTimeoutMs ?? 60_000);
      try {
        // A refresh token the journal shows rotated out is a lagging copy: never import it.
        let spent = false;
        for (const fp of refreshFingerprints(content.toString("utf8"))) {
          const rows = await lock.findByOldFp(fp);
          if (rows.some((r) => r.outcome === "refreshed" && r.newFp !== undefined && r.newFp !== r.oldFp)) spent = true;
        }
        if (spent) report.skipped.push({ path: rel, why: "its refresh token was already rotated out" });
        else await once();
      } finally {
        await lock.release();
      }
    } else await once();
    };
  for (const e of opts.entries ?? (await collectImportEntries(home))) {
    // One refused or broken file never stops the import, nor the host sync pass around it.
    try {
      await handle(e);
    } catch (err) {
      report.skipped.push({ path: relOf(home, e.abs) ?? e.abs, why: `import failed (${(err as Error).message})` });
    }
  }
  return report;
}
