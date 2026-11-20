import { decryptFile, encryptFile, sha256Hex, STORE_KEY_ENV, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PutResult } from "./home-store.ts";
import type { JournalEntry, RefreshAccount, RefreshGuardBackend, RefreshLockHandle } from "./refresh-guard.ts";
import { STORE_WAIT_MAX_MS } from "./admin-store.ts";

/**
 * The host's view of the gateway credential store over the gateway's admin API (admin-store.ts), in place of a direct
 * PostgreSQL connection. It offers what PgHomeStore offers to the host mirror and the import (`HomeStoreClient`).
 *
 * Encryption is unchanged: the host holds AIS_GATEWAY_STORE_KEY and encrypts and decrypts here (AES-256-GCM, the path as
 * AAD, same as PgHomeStore). The gateway only sees ciphertext. Nothing here logs or throws a token, a key, a URL with
 * credentials or a file's contents.
 */

export interface HttpStoreOptions {
  /** Admin base URL, no trailing slash (AIS_GATEWAY_ADMIN_URL). */
  url: string;
  /** Admin bearer token (AIS_GATEWAY_ADMIN_TOKEN). */
  token: string;
  key: Buffer;
  fetch?: typeof fetch;
  /** Time limit for one ordinary call (default 15 s). */
  timeoutMs?: number;
  /** How long one change poll waits at the gateway (default 25 s, at most STORE_WAIT_MAX_MS). */
  waitMs?: number;
  /** Pause after a failed change poll (default 2 s). */
  retryMs?: number;
  warn?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_MS = 25_000;
const DEFAULT_RETRY_MS = 2_000;

/** An answer the gateway refused or could not give. Carries the status only. */
export class StoreApiError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`gateway store API ${what} answered ${status}`);
    this.name = "StoreApiError";
  }
}

// biome-ignore lint/suspicious/noExplicitAny: wire rows are checked field by field
const toMeta = (r: any): HomeFileMeta => ({ path: String(r.path), account: r.account ?? null, kind: r.kind as HomeFileKind, sha256: String(r.sha256), version: Number(r.version) });

/** Authenticated JSON calls to the gateway admin API. Shared by the store and the journal backend. */
export class StoreApi {
  private readonly doFetch: typeof fetch;
  private readonly base: string;
  private readonly timeoutMs: number;
  constructor(private readonly opts: Pick<HttpStoreOptions, "url" | "token" | "fetch" | "timeoutMs">) {
    this.doFetch = opts.fetch ?? fetch;
    this.base = opts.url.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Returns the status and body. Throws only when the gateway cannot be reached. */
  async call(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<{ status: number; json: Record<string, unknown> }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new Error(`gateway store API unreachable (${(err as Error).name})`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  /** Like `call`, and throws StoreApiError for any status outside `ok`. */
  async ok(method: string, path: string, body?: unknown, ok: number[] = [200]): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await this.call(method, path, body);
    if (!ok.includes(r.status)) throw new StoreApiError(r.status, `${method} ${path.split("?")[0]}`);
    return r;
  }
}

export class HttpHomeStore {
  private readonly api: StoreApi;
  private readonly key: Buffer;
  private readonly warn: (message: string) => void;
  private readonly waitMs: number;
  private readonly retryMs: number;
  private readonly stops = new Set<AbortController>();
  /** Highest row version seen in a list, the cursor of the change poll. */
  private cursor = 0;

  constructor(opts: HttpStoreOptions) {
    this.api = new StoreApi(opts);
    this.key = opts.key;
    this.warn = opts.warn ?? ((m) => console.warn(`gateway store: ${m}`));
    this.waitMs = Math.min(opts.waitMs ?? DEFAULT_WAIT_MS, STORE_WAIT_MAX_MS);
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  async close(): Promise<void> {
    for (const c of this.stops) c.abort();
    this.stops.clear();
  }

  /** Metadata of every row, or only those changed after `sinceVersion`. */
  async list(sinceVersion = 0): Promise<HomeFileMeta[]> {
    const { json } = await this.api.ok("GET", `/store/files?since=${Math.trunc(sinceVersion)}`);
    const metas = (Array.isArray(json.files) ? json.files : []).map(toMeta);
    for (const m of metas) if (m.version > this.cursor) this.cursor = m.version;
    return metas;
  }

  async get(paths: string[]): Promise<HomeFileRow[]> {
    if (paths.length === 0) return [];
    const out: HomeFileRow[] = [];
    // The gateway caps one read; the mirror's changed-path lists can be longer.
    for (let i = 0; i < paths.length; i += 200) out.push(...(await this.read({ paths: paths.slice(i, i + 200) })));
    return out;
  }

  async getAccount(account: string, extraPaths: string[] = []): Promise<HomeFileRow[]> {
    return this.read({ account, extraPaths });
  }

  private async read(body: object): Promise<HomeFileRow[]> {
    const { json } = await this.api.ok("POST", "/store/files/read", body);
    const out: HomeFileRow[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: wire rows are checked field by field
    for (const r of (Array.isArray(json.files) ? json.files : []) as any[]) {
      const meta = toMeta(r);
      try {
        out.push({ ...meta, content: decryptFile(this.key, meta.path, Buffer.from(String(r.cipher), "base64")) });
      } catch {
        // One row that does not decrypt is skipped (path only), so it cannot block the others.
        this.warn(`skipping row ${meta.path}: it does not decrypt with ${STORE_KEY_ENV}`);
      }
    }
    return out;
  }

  /**
   * Same contract as PgHomeStore.put, except that a version is required: null = only when absent, a number =
   * compare-and-swap. The gateway refuses an unconditional write, so a leaked admin token cannot roll a row back.
   */
  async put(path: string, content: Buffer, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    if (opts.expectedVersion === undefined) throw new Error("gateway store API: a write needs an expected version (null to create)");
    const body = { path, account: opts.account, kind: opts.kind, cipher: encryptFile(this.key, path, content).toString("base64"), sha256: sha256Hex(content), expectedVersion: opts.expectedVersion };
    const { status, json } = await this.api.ok("PUT", "/store/files", body, [200, 409]);
    if (status === 409) return { ok: false, ...(json.current ? { current: toMeta(json.current) } : {}) };
    return { ok: true, version: Number(json.version) };
  }

  /**
   * Replaces the database LISTEN with a long poll: the gateway answers when a row moves past the cursor or after its wait
   * time. `onPath` gets an empty path (the poll does not name the row; the mirror pulls everything). A failed poll waits
   * `retryMs` and tries again; the mirror's own interval poll covers the gap. Returns an unlisten function.
   */
  async listen(onPath: (path: string) => void): Promise<() => Promise<void>> {
    const stop = new AbortController();
    this.stops.add(stop);
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          const { status, json } = await this.api.call("GET", `/store/wait?since=${this.cursor}&ms=${this.waitMs}`, undefined, stop.signal, this.waitMs + 10_000);
          if (status !== 200) throw new StoreApiError(status, "GET /store/wait");
          if (json.changed === true) {
            onPath("");
            // The mirror's pass moves the cursor through list(); a short pause stops a hot loop if it does not.
            await new Promise((r) => setTimeout(r, 250));
          }
        } catch {
          if (stop.signal.aborted) return;
          await new Promise((r) => setTimeout(r, this.retryMs));
        }
      }
    })();
    return async () => {
      stop.abort();
      this.stops.delete(stop);
    };
  }
}

/**
 * The refresh journal over the admin API, for the host import's "was this refresh token already rotated out" check. It holds
 * no lock: the host cannot hold a database advisory lock over HTTP. The import's writes are compare-and-swap on the row
 * version, so a refresh the gateway completes in between makes the write fail and the row it left is judged by freshness.
 * Only `findByOldFp` works; the gateway's own guard never uses this backend.
 */
export class HttpRefreshBackend implements RefreshGuardBackend {
  private readonly api: StoreApi;
  constructor(opts: Pick<HttpStoreOptions, "url" | "token" | "fetch" | "timeoutMs">) {
    this.api = new StoreApi(opts);
  }

  async acquire(account: RefreshAccount): Promise<RefreshLockHandle> {
    const unsupported = (): never => {
      throw new Error("the refresh journal is read only over the gateway API");
    };
    return {
      waitedMs: 0,
      contended: false,
      release: async () => undefined,
      findByOldFp: async (fp) => {
        const q = new URLSearchParams({ provider: account.provider, identity: account.identity, oldFp: fp });
        const { json } = await this.api.ok("GET", `/store/journal?${q.toString()}`);
        return (Array.isArray(json.entries) ? json.entries : []) as JournalEntry[];
      },
      closeStale: async () => unsupported(),
      claim: async () => unsupported(),
      resolve: async () => unsupported(),
    };
  }
}
