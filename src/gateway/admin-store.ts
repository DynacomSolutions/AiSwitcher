import type { Hono } from "hono";
import type { JournalEntry } from "./refresh-guard.ts";
import { assertRelPath, type HomeFileKind, type HomeStoreServer } from "./home-store.ts";
import { losesLogin, refreshFingerprints } from "./home-mirror.ts";
import { droppedIdentities } from "./registry-sync.ts";

/**
 * Admin routes of the host credential sync: a host reads and writes the gateway's file store through these instead of
 * opening its own database connections. They sit behind the admin bearer token (admin.ts) and are absent (404) when the
 * gateway has no credential store.
 *
 * Rows travel encrypted. The host holds the store key and encrypts and decrypts itself, so the admin token alone never
 * reads a credential. The gateway only checks that a pushed row decrypts with its own key and matches its checksum.
 *
 * - GET  /store/files?since=N          metadata of the rows past version N (all rows when N is 0)
 * - POST /store/files/read             encrypted rows: {paths} or {account, extraPaths}
 * - PUT  /store/files                  compare-and-swap write of one encrypted row: `expectedVersion` is required (null creates).
 *                                       200 {version}; 409 {current} when the row moved; 409 "rotated" for a login whose refresh token the journal shows rotated out;
 *                                       422 "placeholder" for a login that is not refreshable over one that is; 422 "drops-identities" for a registry that drops an identity (422, not 409: an old host client reads 409 as a lost race and retries for ever)
 * - GET  /store/wait?since=N&ms=M      long poll: answers at once when a row is past version N, else when a change arrives or after M ms
 * - GET  /store/journal?provider&identity&oldFp   refresh journal entries for one refresh-token fingerprint
 */

export interface StoreAdminDeps {
  /** The credential store behind the routes (the gateway's PgHomeStore). */
  homeStore: HomeStoreServer;
  /** Journal entries of one account for a refresh-token fingerprint, read under the account's refresh lock. */
  journal?: (provider: string, identity: string, oldFp: string) => Promise<JournalEntry[]>;
}

/** Longest a long poll may wait. The client asks for less. */
/** Request header of a host client that understands the 422 refusals of `PUT /store/files`. */
export const STORE_REFUSALS_HEADER = "x-ais-store-refusals";
export const STORE_WAIT_MAX_MS = 30_000;
const KINDS: readonly HomeFileKind[] = ["registry", "login", "hostfile", "heartbeat", "marker", "meta", "derived"];
/** Rows one read may name. The host mirror asks for the changed paths of one account at a time. */
const MAX_READ_PATHS = 500;
const MAX_CIPHER_BYTES = 8 * 1024 * 1024;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

type Fail = (status: 400 | 404 | 409 | 422 | 503, message: string, extra?: object) => Response;

function b64(raw: unknown): Buffer | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CIPHER_BYTES * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return undefined;
  const b = Buffer.from(raw, "base64");
  return b.length <= MAX_CIPHER_BYTES ? b : undefined;
}

/**
 * Wraps the admin server's fetch so a long poll (`/store/wait`, `/favourites`) is never cut by Bun's idle timeout (10 s by default, shorter than the
 * 25 s poll). The wait itself is capped at STORE_WAIT_MAX_MS by the route. Other requests keep the default.
 */
export function withStoreWaitTimeout<S extends { timeout(req: Request, seconds: number): void }>(handler: (req: Request) => Response | Promise<Response>): (req: Request, server: S) => Response | Promise<Response> {
  return (req, server) => {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && (path === "/store/wait" || path === "/favourites")) server.timeout(req, 0);
    return handler(req);
  };
}

export function registerStoreAdmin(hono: Hono, deps: StoreAdminDeps | undefined, err: Fail): void {
  const missing = (): Response => err(404, "the credential store is not available");

  hono.get("/store/files", async (c) => {
    if (!deps) return missing();
    const since = Number(c.req.query("since") ?? "0");
    if (!Number.isInteger(since) || since < 0) return err(400, "since must be a non-negative integer");
    return c.json({ files: await deps.homeStore.list(since) });
  });

  hono.post("/store/files/read", async (c) => {
    if (!deps) return missing();
    const body = (await c.req.json().catch(() => undefined)) as { paths?: unknown; account?: unknown; extraPaths?: unknown } | undefined;
    if (!body || typeof body !== "object") return err(400, "body must be a JSON object");
    let rows;
    if (typeof body.account === "string" && body.account !== "") {
      if (body.extraPaths !== undefined && !isStrings(body.extraPaths)) return err(400, "extraPaths must be a list of paths");
      rows = await deps.homeStore.getCipher({ account: body.account, ...(body.extraPaths ? { extraPaths: body.extraPaths } : {}) });
    } else {
      if (!isStrings(body.paths) || body.paths.length === 0 || body.paths.length > MAX_READ_PATHS) return err(400, `paths must be a list of 1 to ${MAX_READ_PATHS} paths`);
      try {
        for (const p of body.paths) assertRelPath(p);
      } catch {
        return err(400, "invalid relative path");
      }
      rows = await deps.homeStore.getCipher({ paths: body.paths });
    }
    return c.json({ files: rows.map((r) => ({ path: r.path, account: r.account, kind: r.kind, sha256: r.sha256, version: r.version, cipher: r.cipher.toString("base64") })) });
  });

  hono.put("/store/files", async (c) => {
    if (!deps) return missing();
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return err(400, "body must be a JSON object");
    const { path, account, kind, sha256, expectedVersion } = body;
    if (typeof path !== "string") return err(400, "path is required");
    try {
      assertRelPath(path);
    } catch {
      return err(400, "invalid relative path");
    }
    if (account !== null && typeof account !== "string") return err(400, "account must be a string or null");
    if (typeof kind !== "string" || !KINDS.includes(kind as HomeFileKind)) return err(400, "unknown kind");
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return err(400, "sha256 must be 64 hex digits");
    // A write without a version would let a leaked token roll a row back: the version is required, null creates.
    if (!("expectedVersion" in body) || (expectedVersion !== null && !(typeof expectedVersion === "number" && Number.isInteger(expectedVersion) && expectedVersion >= 0))) return err(400, "expectedVersion is required: a row version, or null to create");
    const cipher = b64(body.cipher);
    if (!cipher) return err(400, "cipher must be base64 and not empty");
    let result;
    try {
      // A login that holds a refresh token the journal shows rotated out is a lagging copy: never stored.
      if (kind === "login" && account && deps.journal) {
        const [provider, ...rest] = account.split("/");
        const text = deps.homeStore.decrypt(path, cipher).toString("utf8");
        for (const fp of refreshFingerprints(text)) {
          const entries = await deps.journal(provider!, rest.join("/"), fp);
          if (entries.some((e) => e.outcome === "refreshed" && e.newFp !== undefined && e.newFp !== e.oldFp)) return err(409, "rotated");
        }
      }
      // A login that is no refreshable login (a gateway placeholder, a blanked file) never replaces a refreshable one, and a registry push
      // never drops an identity the store registry holds (removal is `retire`, which keeps the entry). Both are host bugs, whatever the host version.
      const guarded = kind === "login" || (kind === "registry" && path.endsWith("identities.json"));
      if (guarded && typeof expectedVersion === "number") {
        const [cur] = await deps.homeStore.getCipher({ paths: [path] });
        // Only a write that would land is judged: a stale version gets the normal compare-and-swap conflict below.
        if (cur && cur.version === expectedVersion) {
          const next = deps.homeStore.decrypt(path, cipher).toString("utf8");
          const prev = deps.homeStore.decrypt(path, cur.cipher).toString("utf8");
          const refusal = kind === "login" ? (losesLogin(next, prev) ? "placeholder" : undefined) : droppedIdentities(next, prev).length > 0 ? "drops-identities" : undefined;
          if (refusal) {
            // A host that sends the capability header throws on the refusal (422). An older host reads any status but 200 and 409 as a
            // failure that stops its whole sync pass, so it gets 200 with the row's own version and nothing is written.
            if (c.req.header(STORE_REFUSALS_HEADER) === "1") return err(422, refusal);
            return c.json({ version: cur.version });
          }
        }
      }
      result = await deps.homeStore.putCipher(path, cipher, sha256, { account, kind: kind as HomeFileKind, expectedVersion: expectedVersion as number | null });
    } catch {
      // Names no path or content: a row that does not decrypt, or whose checksum differs.
      return err(400, "the row does not decrypt with the store key or does not match its checksum");
    }
    return result.ok ? c.json({ version: result.version }) : err(409, "the row changed", result.current ? { current: result.current } : {});
  });

  hono.get("/store/wait", async (c) => {
    if (!deps) return missing();
    const since = Number(c.req.query("since") ?? "0");
    const ms = Math.min(Number(c.req.query("ms") ?? STORE_WAIT_MAX_MS), STORE_WAIT_MAX_MS);
    if (!Number.isInteger(since) || since < 0 || !Number.isFinite(ms) || ms < 0) return err(400, "since and ms must be non-negative numbers");
    // Subscribe first, then look: a change between the two is never missed.
    let wake!: () => void;
    const changed = new Promise<void>((r) => (wake = r));
    const unlisten = await deps.homeStore.listen(() => wake()).catch(() => undefined);
    try {
      if ((await deps.homeStore.list(since)).length > 0) return c.json({ changed: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), unlisten ? ms : Math.min(ms, 1_000))));
      const who = await Promise.race([changed.then(() => "change" as const), timedOut, new Promise<"gone">((r) => c.req.raw.signal.addEventListener("abort", () => r("gone")))]);
      clearTimeout(timer);
      return c.json({ changed: who === "change" });
    } finally {
      await unlisten?.().catch(() => undefined);
    }
  });

  hono.get("/store/journal", async (c) => {
    if (!deps?.journal) return missing();
    const provider = c.req.query("provider");
    const identity = c.req.query("identity");
    const oldFp = c.req.query("oldFp");
    if (!provider || !identity || !oldFp) return err(400, "provider, identity and oldFp are required");
    return c.json({ entries: await deps.journal(provider, identity, oldFp) });
  });
}
