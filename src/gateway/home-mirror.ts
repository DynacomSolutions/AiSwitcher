import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { grantFingerprint } from "../identities/oauth-reconcile.ts";
import { mergeRegistries, readRegistryBase, writeRegistryBase } from "./registry-sync.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type HomeStoreClient } from "./home-store.ts";

/**
 * One replica's side of the PostgreSQL credential store (home-store.ts): keeps the replica's HOME in step with the rows.
 *
 * Every path has a base: the version and content hash this replica last synced. A three-way rule decides each change:
 * - local file unchanged since the base, row moved: the row is written to the file;
 * - local file changed (a refresh here, a host login under a file store), row unchanged: the file is pushed
 *   (compare-and-swap on the base version, so a concurrent write elsewhere is never overwritten);
 * - both changed, or no base yet: logins go to the fresher grant (later expiry; a tie goes to the row, PostgreSQL being the
 *   source of truth); host files keep the host's copy under a file store and registries are merged per identity name there
 *   (registry-sync.ts); both take the row otherwise; heartbeat, markers and metadata take the row.
 *
 * Under a file store the base of a registry also lives in the ais state directory, so a restart does not lose it: a registry
 * row that moved in the store (a console add) reaches the host file, and a host file that did not move is never pushed over it.
 *
 * With a file store (`fileStore`, this replica's HOME is the host's real files) pulls are the write-back to the files, and
 * changed host files are imported. Without one HOME is scratch and only gateway writes (refreshes, markers, heartbeat) are
 * pushed.
 *
 * Per-account work runs under an in-process mutex shared with the refresh guard, so a background pull never lands between
 * a refresh's local write and its push.
 */

export interface MirrorOptions {
  /** The replica's HOME (default the process home). */
  home?: string;
  /** True when HOME holds the host's real files (hostPath): write-back and import. */
  fileStore?: boolean;
  warn?: (message: string) => void;
  /** Called with each row's outcome (host sync counts what it wrote and pushed). */
  onOutcome?: (path: string, outcome: ReconcileOutcome) => void;
  /**
   * File store only. Asked before a login row is written into a host file (HOME-relative path): true means the file holds a
   * login the gateway owns, so the row is never copied into it (outcome "kept"). Pushes of the file are not affected.
   */
  keepHostLogin?: (relPath: string) => Promise<boolean>;
  /**
   * File store only. Asked before a login row is applied either way (HOME-relative path): true means the file holds a login
   * the host owns and the gateway does not manage (host-login-gate.ts). The file is then never pushed to the store and never
   * overwritten from it (outcome "kept"). A failed check counts as true.
   */
  hostOwnsLogin?: (relPath: string) => Promise<boolean>;
}

export type ReconcileOutcome = "same" | "wrote" | "pushed" | "kept" | "conflict";

interface Base {
  version: number;
  sha: string;
}

/**
 * Seconds of the latest expiry-like value in a credential file (any `*expir*`, `last_refresh`, a JWT's `exp`), or undefined.
 * A refresh token's own expiry (`refreshTokenExpiresAt`, `refresh_token_expires_*`) is not the grant's age: Claude Code keeps
 * it when it blanks a login after a failed refresh, so counting it made a logged-out file look fresher than a live grant.
 */
export function grantFreshness(text: string): number | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  let best: number | undefined;
  const take = (s: number | undefined): void => {
    if (s !== undefined && Number.isFinite(s) && s > 0 && (best === undefined || s > best)) best = s;
  };
  const toSeconds = (n: number): number => (n > 1e12 ? n / 1000 : n);
  const jwtExp = (v: string): number | undefined => {
    const part = v.split(".")[1];
    if (!part) return undefined;
    try {
      const exp = (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown }).exp;
      return typeof exp === "number" ? exp : undefined;
    } catch {
      return undefined;
    }
  };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || typeof v !== "object" || v === null) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/expir/i.test(k) && /refresh/i.test(k)) continue;
      if (/expir/i.test(k)) {
        if (typeof x === "number") take(toSeconds(x));
        else if (typeof x === "string") take(/^\d+$/.test(x) ? toSeconds(Number(x)) : Date.parse(x) / 1000);
      } else if (/^last_refresh$/i.test(k) && typeof x === "string") take(Date.parse(x) / 1000);
      else if (/^(access_token|accessToken|access)$/.test(k) && typeof x === "string" && x.split(".").length === 3) take(jwtExp(x));
      else walk(x, depth + 1);
    }
  };
  walk(json, 0);
  return best;
}

/** Fingerprints (grantFingerprint) of every refresh token in a credential file, for the journal's rotated-out check. */
export function refreshFingerprints(text: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || typeof v !== "object" || v === null) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/^refresh_?token$|^refresh$/i.test(k) && typeof x === "string" && x.trim()) out.push(grantFingerprint({ refresh_token: x, access_token: "" }));
      else walk(x, depth + 1);
    }
  };
  try {
    walk(JSON.parse(text), 0);
  } catch {
    // not JSON: no tokens to check
  }
  return out;
}

/** True when `a` is strictly fresher than `b` (a grant with a known expiry beats one without). */
export const isFresher = (a: string, b: string): boolean => {
  const fa = grantFreshness(a);
  const fb = grantFreshness(b);
  return fa !== undefined && (fb === undefined || fa > fb);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Merges two JSON-object credential files per top-level key (the shared pi auth.json holds one entry per provider): keys on
 * one side only are kept; where both differ the subtree with the greater grantFreshness wins, a tie going to `theirs`
 * (the store). Undefined when either side is not a JSON object.
 */
export function mergeByKey(mine: string, theirs: string): Buffer | undefined {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(mine);
    b = JSON.parse(theirs);
  } catch {
    return undefined;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return undefined;
  const out: Record<string, unknown> = { ...b };
  for (const [k, v] of Object.entries(a)) {
    if (!(k in b)) {
      out[k] = v;
      continue;
    }
    if (JSON.stringify(v) === JSON.stringify(b[k])) continue;
    const fm = grantFreshness(JSON.stringify(v));
    const fs = grantFreshness(JSON.stringify(b[k]));
    if (fm !== undefined && (fs === undefined || fm > fs)) out[k] = v;
  }
  return Buffer.from(`${JSON.stringify(out, null, 2)}\n`);
}

/** File beside a member-store login that lists the refresh tokens the owner replaced (login-replaced.ts). */
export const REPLACED_MARKER_FILE = "login-replaced.json";

/** The marker row beside a member-store login path (same folder), or undefined. A read problem counts as none. */
export async function replacedFingerprintsFor(store: Pick<HomeStoreClient, "get">, loginRel: string): Promise<Set<string>> {
  const slash = loginRel.lastIndexOf("/");
  if (slash < 0 || !loginRel.includes("gateway-members/")) return new Set();
  const markerRel = `${loginRel.slice(0, slash)}/${REPLACED_MARKER_FILE}`;
  try {
    const [row] = await store.get([markerRel]);
    const parsed = row ? (JSON.parse(row.content.toString("utf8")) as { fingerprints?: unknown }) : undefined;
    return new Set(Array.isArray(parsed?.fingerprints) ? parsed.fingerprints.filter((f): f is string => typeof f === "string") : []);
  } catch {
    return new Set();
  }
}

/** True when `content` still holds a refresh token the owner replaced at `loginRel`. */
export async function isReplacedLogin(store: Pick<HomeStoreClient, "get">, loginRel: string, content: string): Promise<boolean> {
  const replaced = await replacedFingerprintsFor(store, loginRel);
  if (replaced.size === 0) return false;
  return refreshFingerprints(content).some((fp) => replaced.has(fp));
}

const MERGE_ATTEMPTS = 5;
const STOP_PUSH_MS = 5_000;

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.ais-store-${process.pid}-${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, path);
}

const readLocal = async (abs: string): Promise<Buffer | undefined> => readFile(abs).catch(() => undefined);

export class HomeMirror {
  readonly home: string;
  readonly fileStore: boolean;
  private readonly bases = new Map<string, Base>();
  private readonly kinds = new Map<string, { kind: HomeFileKind; account: string | null }>();
  private readonly locks = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unlisten: (() => Promise<void>) | undefined;
  private pending = new Set<string>();
  private draining: Promise<void> | undefined;
  private readonly warn: (message: string) => void;
  private readonly onOutcome: ((path: string, outcome: ReconcileOutcome) => void) | undefined;
  private readonly keepHostLogin: ((relPath: string) => Promise<boolean>) | undefined;
  private readonly hostOwnsLogin: ((relPath: string) => Promise<boolean>) | undefined;
  /** Time of the last full pass that reached the database (ms). */
  lastSyncAt = 0;

  constructor(
    readonly store: HomeStoreClient,
    opts: MirrorOptions = {},
  ) {
    this.home = opts.home ?? homedir();
    this.fileStore = opts.fileStore === true;
    this.warn = opts.warn ?? ((m) => console.warn(`gateway store: ${m}`));
    this.onOutcome = opts.onOutcome;
    this.keepHostLogin = opts.keepHostLogin;
    this.hostOwnsLogin = opts.hostOwnsLogin;
  }

  /** HOME-relative form of an absolute path, or undefined outside HOME. */
  rel(abs: string): string | undefined {
    const r = relative(this.home, abs);
    if (r === "" || r.startsWith("..") || r.startsWith(sep)) return undefined;
    return r.split(sep).join("/");
  }

  abs(rel: string): string {
    return join(this.home, ...rel.split("/"));
  }

  /** Runs `fn` with the account's in-process mutex (shared with the refresh guard). */
  async withAccount<T>(account: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(account) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((r) => {
      done = r;
    });
    const tail = prev.then(() => mine);
    this.locks.set(account, tail);
    await prev;
    try {
      return await fn();
    } finally {
      done();
      if (this.locks.get(account) === tail) this.locks.delete(account);
    }
  }

  /** Applies one row against the local file by the three-way rule. Returns what happened. */
  private async reconcile(row: HomeFileRow): Promise<ReconcileOutcome> {
    const outcome = await this.reconcileRow(row);
    this.onOutcome?.(row.path, outcome);
    return outcome;
  }

  private async reconcileRow(row: HomeFileRow): Promise<ReconcileOutcome> {
    const abs = this.abs(row.path);
    const local = await readLocal(abs);
    const base = this.bases.get(row.path);
    this.kinds.set(row.path, { kind: row.kind, account: row.account });
    if (this.fileStore && row.kind === "login" && this.hostOwnsLogin && (await this.hostOwnsLogin(row.path).catch(() => true))) return "kept";
    const write = async (): Promise<"wrote" | "kept"> => {
      if (this.fileStore && row.kind === "login" && this.keepHostLogin && (await this.keepHostLogin(row.path).catch(() => true))) return "kept";
      await writeAtomic(abs, row.content);
      await this.setBase(row.path, row.version, row.sha256);
      return "wrote";
    };
    if (this.fileStore && row.kind === "derived") return "kept";
    if (local === undefined) return write();
    const localSha = sha256Hex(local);
    if (localSha === row.sha256) {
      await this.setBase(row.path, row.version, row.sha256);
      return "same";
    }
    if (this.fileStore && row.kind === "registry") return this.reconcileRegistry(row, abs, local, localSha, write);
    if (base && localSha === base.sha) return write();
    // The owner replaced this login with another account's: a copy still holding the replaced token never wins.
    if (row.kind === "login" && (await isReplacedLogin(this.store, row.path, local.toString("utf8")))) return write();
    const push = async (expected: number): Promise<"pushed" | "conflict"> => {
      const r = await this.store.put(row.path, local, { account: row.account, kind: row.kind, expectedVersion: expected });
      if (!r.ok) return "conflict";
      await this.setBase(row.path, r.version, localSha);
      return "pushed";
    };
    const hostTruth = this.fileStore && (row.kind === "registry" || row.kind === "hostfile");
    if (base && base.version === row.version) {
      // Only the local file changed.
      if (row.kind === "registry" || row.kind === "hostfile") return hostTruth ? push(row.version) : write();
      if (row.kind === "meta" || row.kind === "derived") return write();
      return push(row.version);
    }
    // Both changed, or first sight.
    if (hostTruth) return push(row.version);
    if (row.kind === "login" && (row.account ?? "").startsWith("pi/") && mergeByKey(local.toString("utf8"), row.content.toString("utf8"))) return this.mergeAndPush(row, local);
    if (row.kind === "login") {
      const l = local.toString("utf8");
      if (isFresher(l, row.content.toString("utf8"))) return push(row.version);
    }
    if (this.fileStore && row.kind === "hostfile") return "kept";
    return write();
  }

  /**
   * A registry under a file store (the host's real files). The base is the in-memory one, else the one recorded in the state
   * directory (it survives a restart): host file unchanged since the base means the store moved (a console add) and the row
   * is written to the host; row unchanged means the host moved and the host file is pushed; anything else (both moved, no
   * base) merges per identity name (registry-sync.ts) and pushes the merge, so neither side loses an identity.
   */
  private async reconcileRegistry(row: HomeFileRow, abs: string, local: Buffer, localSha: string, write: () => Promise<"wrote" | "kept">): Promise<ReconcileOutcome> {
    const last = this.bases.get(row.path) ?? (await readRegistryBase(this.home, row.path));
    const put = async (content: Buffer): Promise<"pushed" | "conflict"> => {
      const r = await this.store.put(row.path, content, { account: row.account, kind: row.kind, expectedVersion: row.version });
      if (!r.ok) return "conflict";
      await this.setBase(row.path, r.version, sha256Hex(content));
      return "pushed";
    };
    if (last && last.sha === localSha) return write();
    if (last && last.sha === row.sha256) return put(local);
    const merged = mergeRegistries(local.toString("utf8"), row.content.toString("utf8"));
    if (!merged) return put(local);
    if (sha256Hex(merged) === row.sha256) return write();
    await writeAtomic(abs, merged);
    return put(merged);
  }

  /** Remembers the version and hash a path was last in step at; a registry under a file store also goes to the state directory. */
  private async setBase(path: string, version: number, sha: string): Promise<void> {
    this.bases.set(path, { version, sha });
    if (!this.fileStore || this.kinds.get(path)?.kind !== "registry") return;
    await writeRegistryBase(this.home, path, { version, sha }).catch((err: unknown) => this.warn(`could not record the sync state of ${path} (${(err as Error).name})`));
  }

  /**
   * A shared file (pi's auth.json, one entry per provider) changed on both sides: merge per key, write the merge locally and
   * push it against the row's version, again on a further conflict. Throws when it stays unresolved.
   */
  private async mergeAndPush(row: HomeFileRow, local: Buffer): Promise<"wrote" | "pushed"> {
    let cur = row;
    let mine = local;
    for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt += 1) {
      const merged = mergeByKey(mine.toString("utf8"), cur.content.toString("utf8"));
      if (!merged) throw new Error("gateway store: shared file is no longer a JSON object");
      const sha = sha256Hex(merged);
      if (sha === cur.sha256) {
        await writeAtomic(this.abs(cur.path), cur.content);
        await this.setBase(cur.path, cur.version, cur.sha256);
        return "wrote";
      }
      await writeAtomic(this.abs(cur.path), merged);
      const r = await this.store.put(cur.path, merged, { account: cur.account, kind: cur.kind, expectedVersion: cur.version });
      if (r.ok) {
        await this.setBase(cur.path, r.version, sha);
        return "pushed";
      }
      mine = merged;
      const [next] = await this.store.get([cur.path]);
      if (!next) throw new Error("gateway store: shared file row disappeared during a merge");
      cur = next;
    }
    throw new Error("gateway store: shared file merge kept conflicting");
  }

  /**
   * Reads every row's metadata and applies the ones past their base version. Sequence versions can commit out of order, so a
   * high-water mark could skip a row for good; the metadata is small. Per-account rows run under the account mutex.
   */
  async pullAll(): Promise<void> {
    const metas = await this.store.list(0);
    await this.applyMetas(metas);
    this.lastSyncAt = Date.now();
  }

  private async applyMetas(metas: HomeFileMeta[]): Promise<void> {
    const changed = metas.filter((m) => {
      const b = this.bases.get(m.path);
      return !b || b.version < m.version;
    });
    const byAccount = new Map<string, string[]>();
    for (const m of changed) byAccount.set(m.account ?? "", [...(byAccount.get(m.account ?? "") ?? []), m.path]);
    for (const [account, paths] of byAccount) {
      const run = async (): Promise<void> => {
        for (const row of await this.store.get(paths)) {
          try {
            await this.reconcile(row);
          } catch (err) {
            this.warn(`could not sync ${row.path} (${(err as Error).name})`);
          }
        }
      };
      if (account) await this.withAccount(account, run);
      else await run();
    }
  }

  /** Pulls one account's rows (and `extraPaths`) now. Call it holding the account's refresh lock. */
  async pullAccount(account: string, extraAbs: string[] = []): Promise<void> {
    const extra = extraAbs.map((p) => this.rel(p)).filter((p): p is string => p !== undefined);
    for (const row of await this.store.getAccount(account, extra)) await this.reconcile(row);
  }

  /**
   * Pushes local files that changed since their base (or are new), tagged with `account` and `kind`. Compare-and-swap on
   * the base: a row another replica moved meanwhile is reconciled instead. Throws when the database refuses or is down.
   */
  async push(absPaths: string[], account: string | null, kind: HomeFileKind): Promise<void> {
    for (const abs of absPaths) {
      const rel = this.rel(abs);
      if (!rel) continue;
      const local = await readLocal(abs);
      if (local === undefined) continue;
      const sha = sha256Hex(local);
      const base = this.bases.get(rel);
      if (base && base.sha === sha) continue;
      const known = this.kinds.get(rel);
      const r = await this.store.put(rel, local, { account: known?.account ?? account, kind: known?.kind ?? kind, expectedVersion: base ? base.version : null });
      if (r.ok) {
        this.kinds.set(rel, { kind: known?.kind ?? kind, account: known?.account ?? account });
        await this.setBase(rel, r.version, sha);
        continue;
      }
      // Someone else wrote it: reconcile against their row (fresher grant wins).
      const [row] = await this.store.get([rel]);
      if (!row) throw new Error(`gateway store: write of ${rel} was refused and its row is gone`);
      if ((await this.reconcile(row)) === "conflict") throw new Error(`gateway store: write of ${rel} lost a race that stayed unresolved`);
    }
  }

  /** Pushes the account's tracked files whose local copy differs from their base (a push that missed them). No account lock: call it inside one. */
  async pushAccountDirty(account: string): Promise<void> {
    for (const [rel, base] of [...this.bases]) {
      const k = this.kinds.get(rel);
      if (!k || k.account !== account) continue;
      const local = await readLocal(this.abs(rel));
      if (!local || sha256Hex(local) === base.sha) continue;
      await this.push([this.abs(rel)], account, k.kind);
    }
  }

  /** Pushes every tracked file whose local copy changed (file-store import of host edits, a push that failed earlier). */
  async pushDirty(): Promise<void> {
    for (const [rel, base] of [...this.bases]) {
      const local = await readLocal(this.abs(rel));
      const k = this.kinds.get(rel);
      // A login or meta file this replica wrote that is gone now (deleted by another process) is written again from its row.
      // Only a file store does it: a scratch HOME may lose its files on purpose. keepHostLogin and hostOwnsLogin still apply.
      const missing = !local && this.fileStore && (k?.kind === "login" || k?.kind === "meta");
      if (!missing && (!local || sha256Hex(local) === base.sha)) continue;
      if (!k || (!this.fileStore && (k.kind === "registry" || k.kind === "hostfile"))) continue;
      const run = async (): Promise<void> => {
        const [row] = await this.store.get([rel]);
        if (row) await this.reconcile(row);
      };
      if (k.account) await this.withAccount(k.account, run);
      else await run();
    }
  }

  /** Starts following changes: NOTIFY for speed, a poll for anything missed. */
  async start(pollMs = 5_000): Promise<void> {
    try {
      this.unlisten = await this.store.listen((path) => {
        this.pending.add(path);
        this.kick();
      });
    } catch {
      this.warn("LISTEN unavailable; following changes by polling only");
    }
    this.timer = setInterval(() => this.kick(), pollMs);
    this.timer.unref?.();
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = (async () => {
      try {
        this.pending.clear();
        await this.pullAll();
        await this.pushDirty();
      } catch (err) {
        this.warn(`sync pass failed (${(err as Error).name})`);
      } finally {
        this.draining = undefined;
        if (this.pending.size > 0) this.kick();
      }
    })();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unlisten?.().catch(() => undefined);
    await this.draining?.catch(() => undefined);
    // Last chance for a rotation whose push failed: the pod is going, and so is its local copy.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.pushDirty().catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, STOP_PUSH_MS)))]);
    clearTimeout(timer);
  }

  /** True when the file exists locally (tests, status). */
  has(rel: string): boolean {
    return existsSync(this.abs(rel));
  }
}
