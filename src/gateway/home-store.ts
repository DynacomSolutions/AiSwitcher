import { SQL } from "bun";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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
  constructor(
    url: string,
    private readonly key: Buffer,
    readonly holder: string = `${process.env.HOSTNAME ?? "gateway"}:${process.pid}`,
    private readonly warn: (message: string) => void = (m) => console.warn(`gateway store: ${m}`),
  ) {
    this.sql = new SQL(url, { max: 4 });
  }

  async close(): Promise<void> {
    await this.sql.close();
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
    const cipher = encryptFile(this.key, path, content);
    const sha = sha256Hex(content);
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

  /** Accounts ("tool/identity") with at least one login row: the logins the gateway's store owns. */
  async ownedAccounts(): Promise<Set<string>> {
    const rows = await this.sql`SELECT DISTINCT account FROM gateway_home_files WHERE kind = 'login' AND account IS NOT NULL`;
    return new Set(rows.map((r: { account: string }) => r.account));
  }

  /** Calls `onPath` for every change NOTIFY. Resolves once listening; returns an unlisten function. */
  async listen(onPath: (path: string) => void): Promise<() => Promise<void>> {
    // biome-ignore lint/suspicious/noExplicitAny: Bun's SQL listen is not in the published types yet
    const handle: any = await (this.sql as any).listen(HOME_FILES_CHANNEL, (payload: string) => onPath(payload));
    return async () => {
      await Promise.resolve(handle?.unlisten?.()).catch(() => undefined);
    };
  }
}

/**
 * Accounts the gateway's PostgreSQL store owns, for processes that must stand down (the console's refresh scheduler).
 * A short cache. `undefined` means the database could not be read (callers fail closed).
 */
export function createOwnershipCheck(url: string, ttlMs = 60_000, now: () => number = Date.now): { owned(): Promise<Set<string> | undefined>; close(): Promise<void> } {
  let sql: SQL | undefined;
  let cache: { at: number; set: Set<string> } | undefined;
  let failedAt: number | undefined;
  return {
    async owned() {
      if (cache && now() - cache.at < ttlMs) return cache.set;
      // A failed read is not retried for a while, so a down database does not stall every caller.
      if (failedAt !== undefined && now() - failedAt < 15_000) return undefined;
      try {
        sql ??= new SQL(url, { max: 1, idleTimeout: 30 });
        const q = sql`SELECT DISTINCT account FROM gateway_home_files WHERE kind = 'login' AND account IS NOT NULL`;
        const rows = await Promise.race([q, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5_000))]);
        cache = { at: now(), set: new Set((rows as Array<{ account: string }>).map((r) => r.account)) };
        failedAt = undefined;
        return cache.set;
      } catch (err) {
        // A database without the table (store never used) owns nothing.
        if ((err as { errno?: unknown })?.errno === "42P01") {
          cache = { at: now(), set: new Set() };
          return cache.set;
        }
        failedAt = now();
        return undefined;
      }
    },
    async close() {
      await sql?.close().catch(() => undefined);
    },
  };
}
