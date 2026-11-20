import { SQL } from "bun";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PgListener } from "./pg-listen.ts";
import { pgPoolOptions } from "./pg-pool.ts";

/**
 * The gateway credential store in PostgreSQL: an encrypted mirror of the files the gateway's login model is made of
 * (identity registries, each account's credential files, the ownership heartbeat, revoked markers), keyed by their
 * HOME-relative path. Every replica materialises the rows into its own HOME (home-mirror.ts), so the file-based refresh,
 * guard and credential cache work unchanged on any node. PostgreSQL is the source of truth.
 *
 * Contents are AES-256-GCM encrypted with AIS_GATEWAY_STORE_KEY (32 bytes, base64 or hex); the path is the AAD, so a row
 * cannot be moved to another path. Nothing here logs or returns a key, a token or a file's contents in an error.
 */

/** Env var holding the 32-byte encryption key (base64 or 64 hex digits). The deployment fills it from a Secret. */
export const STORE_KEY_ENV = "AIS_GATEWAY_STORE_KEY";
/** NOTIFY channel; the payload is the changed path. */
export const HOME_FILES_CHANNEL = "ais_gateway_files";

/**
 * registry: an identities.json; login: a credential file of one account (`account` = "tool/identity"); hostfile: an
 * account file the host owns that the gateway only reads (never written back over a host file); heartbeat: the
 * ownership heartbeat; marker: a login-revoked.json; meta: store metadata (the host home the registries were written on);
 * derived: a file the import made for scratch replicas only (never written into a file store).
 */
export type HomeFileKind = "registry" | "login" | "hostfile" | "heartbeat" | "marker" | "meta" | "derived";

export interface HomeFileMeta {
  path: string;
  account: string | null;
  kind: HomeFileKind;
  sha256: string;
  version: number;
}

export interface HomeFileRow extends HomeFileMeta {
  content: Buffer;
}

export type PutResult = { ok: true; version: number } | { ok: false; current?: HomeFileMeta };

/** A row as stored: metadata plus the encrypted content (never decrypted by the holder of this value). */
export interface HomeCipherRow extends HomeFileMeta {
  cipher: Buffer;
}

/**
 * What the host mirror and the import need from a store: PgHomeStore (direct database) and HttpHomeStore (the gateway's
 * admin API, home-store-http.ts) both provide it. Content is plain here; each implementation encrypts and decrypts itself.
 */
export type HomeStoreClient = Pick<PgHomeStore, "list" | "get" | "getAccount" | "put" | "listen" | "close">;

/**
 * What the gateway's admin routes serve (admin-store.ts): rows stay encrypted, so the admin token alone never reads a
 * credential. PgHomeStore provides it.
 */
export interface HomeStoreServer {
  list(sinceVersion?: number): Promise<HomeFileMeta[]>;
  getCipher(query: { paths?: string[]; account?: string; extraPaths?: string[] }): Promise<HomeCipherRow[]>;
  putCipher(path: string, cipher: Buffer, sha256: string, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult>;
  /** Decrypts a row's content, to check what a client pushed. Throws when it does not decrypt. */
  decrypt(path: string, cipher: Buffer): Buffer;
  listen(onPath: (path: string) => void): Promise<() => Promise<void>>;
}

export const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Parses the key: base64 (44 chars) or hex (64 digits) of exactly 32 bytes. Throws a message without the value. */
export function parseStoreKey(raw: string | undefined): Buffer {
  const v = raw?.trim();
  if (!v) throw new Error(`${STORE_KEY_ENV} is required for the PostgreSQL credential store (32 random bytes, base64)`);
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error(`${STORE_KEY_ENV} must decode to 32 bytes (got ${key.length}); generate one with: openssl rand -base64 32`);
  return key;
}

export function encryptFile(key: Buffer, path: string, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(path, "utf8"));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}

export function decryptFile(key: Buffer, path: string, cipher: Buffer): Buffer {
  if (cipher.length < 28) throw new Error(`gateway store: row for ${path} is too short to decrypt`);
  const d = createDecipheriv("aes-256-gcm", key, cipher.subarray(0, 12));
  d.setAAD(Buffer.from(path, "utf8"));
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  try {
    return Buffer.concat([d.update(cipher.subarray(12, cipher.length - 16)), d.final()]);
  } catch {
    throw new Error(`gateway store: row for ${path} does not decrypt with ${STORE_KEY_ENV} (wrong key or tampered row)`);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: driver rows are untyped
const toMeta = (r: any): HomeFileMeta => ({ path: r.path, account: r.account ?? null, kind: r.kind as HomeFileKind, sha256: r.sha256, version: Number(r.version) });
const toBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v), "binary"));

/** Validates a HOME-relative path: no absolute, no `..`, no empty segment. */
export function assertRelPath(path: string): void {
  if (path === "" || path.startsWith("/") || path.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`gateway store: invalid relative path`);
}

/** The table behind the store. One pool per process; every call bounded on the client. */
export class PgHomeStore {
  readonly sql: SQL;
  private readonly ownsSql: boolean;
  constructor(
    url: string,
    private readonly key: Buffer,
    readonly holder: string = `${process.env.HOSTNAME ?? "gateway"}:${process.pid}`,
    private readonly warn: (message: string) => void = (m) => console.warn(`gateway store: ${m}`),
    /** The process-wide pool and LISTEN connection. The store never closes them. Without them it owns a pool. */
    shared: { sql?: SQL; listener?: PgListener } = {},
  ) {
    this.ownsSql = !shared.sql;
    this.sql = shared.sql ?? new SQL(url, pgPoolOptions({ maxCap: 4 }));
    this.listener = shared.listener;
  }

  private readonly listener: PgListener | undefined;

  /** Closes the store's own pool. A shared pool stays open. */
  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.close();
  }

  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  /** Metadata of every row, or only those changed after `sinceVersion`. */
  async list(sinceVersion = 0): Promise<HomeFileMeta[]> {
    const rows = await this.sql`SELECT path, account, kind, sha256, version FROM gateway_home_files WHERE version > ${sinceVersion} ORDER BY version`;
    return rows.map(toMeta);
  }

  /** Rows (decrypted) for an account, plus any extra paths. */
  async getAccount(account: string, extraPaths: string[] = []): Promise<HomeFileRow[]> {
    const rows = await this.sql`SELECT path, account, kind, sha256, version, cipher FROM gateway_home_files WHERE account = ${account} OR path IN ${this.sql(extraPaths.length > 0 ? extraPaths : [""])}`;
    return this.decodeAll(rows);
  }

  async get(paths: string[]): Promise<HomeFileRow[]> {
    if (paths.length === 0) return [];
    const rows = await this.sql`SELECT path, account, kind, sha256, version, cipher FROM gateway_home_files WHERE path IN ${this.sql(paths)}`;
    return this.decodeAll(rows);
  }

  /** Decrypts per row: one row that does not decrypt is skipped (warned by path only), so it cannot block the others. */
  private decodeAll(rows: Array<Record<string, unknown>>): HomeFileRow[] {
    const out: HomeFileRow[] = [];
    for (const r of rows) {
      try {
        out.push(this.decode(r));
      } catch {
        this.warn(`skipping row ${String(r.path)}: it does not decrypt with ${STORE_KEY_ENV}`);
      }
    }
    return out;
  }

  private decode(r: Record<string, unknown>): HomeFileRow {
    const meta = toMeta(r);
    return { ...meta, content: decryptFile(this.key, meta.path, toBuffer(r.cipher)) };
  }

  /**
   * Writes a file. `expectedVersion`: undefined = unconditional, null = only when absent, a number = only while the row
   * is still at that version (compare-and-swap). A refused write returns the current row's metadata.
   */
  async put(path: string, content: Buffer, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    assertRelPath(path);
    return this.write(path, encryptFile(this.key, path, content), sha256Hex(content), opts);
  }

  /**
   * Writes a row whose content a client already encrypted (the gateway's admin route). The cipher must decrypt with this
   * key for this path, and its content must match `sha256`: a bad client can never store a row nobody can read.
   */
  async putCipher(path: string, cipher: Buffer, sha256: string, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    assertRelPath(path);
    if (sha256Hex(decryptFile(this.key, path, cipher)) !== sha256) throw new Error("gateway store: the checksum does not match the content");
    return this.write(path, cipher, sha256, opts);
  }

  private async write(path: string, cipher: Buffer, sha: string, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    const exp = opts.expectedVersion;
    let rows: Array<{ version: unknown }>;
    if (exp === undefined) {
      rows = await this.sql`
        INSERT INTO gateway_home_files (path, account, kind, cipher, sha256, updated_by)
        VALUES (${path}, ${opts.account}, ${opts.kind}, ${cipher}, ${sha}, ${this.holder})
        ON CONFLICT (path) DO UPDATE SET account = EXCLUDED.account, kind = EXCLUDED.kind, cipher = EXCLUDED.cipher, sha256 = EXCLUDED.sha256,
          version = nextval('gateway_home_files_version'), updated_at = now(), updated_by = EXCLUDED.updated_by
        RETURNING version`;
    } else if (exp === null) {
      rows = await this.sql`
        INSERT INTO gateway_home_files (path, account, kind, cipher, sha256, updated_by)
        VALUES (${path}, ${opts.account}, ${opts.kind}, ${cipher}, ${sha}, ${this.holder})
        ON CONFLICT (path) DO NOTHING
        RETURNING version`;
    } else {
      rows = await this.sql`
        UPDATE gateway_home_files SET account = ${opts.account}, kind = ${opts.kind}, cipher = ${cipher}, sha256 = ${sha},
          version = nextval('gateway_home_files_version'), updated_at = now(), updated_by = ${this.holder}
        WHERE path = ${path} AND version = ${exp}
        RETURNING version`;
    }
    if (rows.length === 0) {
      const cur = await this.sql`SELECT path, account, kind, sha256, version FROM gateway_home_files WHERE path = ${path}`;
      return { ok: false, ...(cur[0] ? { current: toMeta(cur[0]) } : {}) };
    }
    await this.sql`SELECT pg_notify(${HOME_FILES_CHANNEL}, ${path})`.catch(() => undefined);
    return { ok: true, version: Number(rows[0]!.version) };
  }

  decrypt(path: string, cipher: Buffer): Buffer {
    return decryptFile(this.key, path, cipher);
  }

  /** Encrypted rows for paths and/or an account (plus extra paths), for the gateway's admin route. */
  async getCipher(query: { paths?: string[]; account?: string; extraPaths?: string[] }): Promise<HomeCipherRow[]> {
    const toCipher = (rows: Array<Record<string, unknown>>): HomeCipherRow[] => rows.map((r) => ({ ...toMeta(r), cipher: toBuffer(r.cipher) }));
    if (query.account !== undefined) {
      const extra = query.extraPaths ?? [];
      return toCipher(await this.sql`SELECT path, account, kind, sha256, version, cipher FROM gateway_home_files WHERE account = ${query.account} OR path IN ${this.sql(extra.length > 0 ? extra : [""])}`);
    }
    const paths = query.paths ?? [];
    if (paths.length === 0) return [];
    return toCipher(await this.sql`SELECT path, account, kind, sha256, version, cipher FROM gateway_home_files WHERE path IN ${this.sql(paths)}`);
  }

  /** Removes a row, only while it is still at `expectedVersion` (compare-and-swap). True when a row went. */
  async delete(path: string, expectedVersion: number): Promise<boolean> {
    assertRelPath(path);
    const rows = await this.sql`DELETE FROM gateway_home_files WHERE path = ${path} AND version = ${expectedVersion} RETURNING version`;
    return rows.length > 0;
  }

  /** Accounts ("tool/identity") with at least one login row: the logins the gateway's store owns. */
  async ownedAccounts(): Promise<Set<string>> {
    const rows = await this.sql`SELECT DISTINCT account FROM gateway_home_files WHERE kind = 'login' AND account IS NOT NULL`;
    return new Set(rows.map((r: { account: string }) => r.account));
  }

  /** Subscribers of the shared LISTEN. One entry per `listen` call, so leaving twice is harmless. */
  private readonly listeners = new Set<{ cb: (path: string) => void }>();
  /** The live LISTEN, present while at least one subscriber is. Read and changed only inside `serial`. */
  private handle: { unlisten?: () => unknown } | undefined;
  private chain: Promise<void> = Promise.resolve();

  /** Runs `fn` after every earlier start or stop of the shared LISTEN has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Calls `onPath` for every change NOTIFY. Resolves once listening; returns an unlisten function. All callers share one
   * database connection. Starts and stops run one at a time: the first subscriber starts the LISTEN, the last to leave
   * ends the handle that is current at that moment, and a subscriber that joins after that gets a fresh LISTEN.
   */
  async listen(onPath: (path: string) => void): Promise<() => Promise<void>> {
    if (this.listener) return this.listener.listen(HOME_FILES_CHANNEL, onPath);
    const sub = { cb: onPath };
    await this.serial(async () => {
      this.listeners.add(sub);
      if (this.handle) return;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Bun's SQL listen is not in the published types yet
        this.handle = await (this.sql as any).listen(HOME_FILES_CHANNEL, (payload: string) => {
          for (const l of [...this.listeners]) l.cb(payload);
        });
      } catch (err) {
        this.listeners.delete(sub);
        throw err;
      }
    });
    return () =>
      this.serial(async () => {
        if (!this.listeners.delete(sub) || this.listeners.size > 0) return;
        const h = this.handle;
        this.handle = undefined;
        await Promise.resolve(h?.unlisten?.()).catch(() => undefined);
      });
  }
}
