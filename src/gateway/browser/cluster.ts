import { SQL } from "bun";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CallRequest, CallResult } from "../../browser/protocol.ts";
import type { BrowserBinding } from "../../browser/types.ts";
import { sanitiseResult, type BrowserHub, type HubSocket } from "./hub.ts";

export const BROWSER_CHANNEL = "ais_gateway_browser";
export const RELAY_PATH = "/internal/browser/relay";
const MAX_RELAY_TIMEOUT_MS = 130_000;
const FORWARD_GRACE_MS = 5_000;

export interface ClusterOptions {
  hub: BrowserHub;
  databaseUrl: string;
  replicaId: string;
  /** This replica's admin base URL, reachable from the other replicas (no trailing path). */
  replicaUrl: string;
  adminToken: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Presence upsert and remote refresh period. Default 5000. */
  presenceMs?: number;
  /** A presence row not refreshed for this long belongs to a dead replica and is ignored. Default 20000. */
  staleMs?: number;
}

interface Remote {
  binding: BrowserBinding;
  replicaId: string;
  replicaUrl: string;
  extensionVersion?: string;
  paused: boolean;
  attachedAt: number;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
/**
 * What replicas present to each other, derived from the admin token, so the admin token itself never leaves the process
 * (a relay URL taken from the presence table only ever sees this secret, which opens nothing but the relay endpoint).
 */
export const relaySecret = (adminToken: string): string => createHmac("sha256", adminToken).update("ais-gateway-browser-relay").digest("hex");

/**
 * Browser relay hub for several gateway replicas.
 *
 * Each replica owns the extension sockets that connected to it and publishes them in
 * `gateway_browser_presence` (PostgreSQL). A call for a binding held by another replica is forwarded
 * over that replica's admin endpoint (`POST /internal/browser/relay`, bearer admin token), which runs
 * it on its local hub. The serving replica counts the call metric. The remote view is a cache refreshed
 * every `presenceMs` and on NOTIFY, so `connected()` stays synchronous.
 *
 * Duplicate binding across replicas: the newer attach wins. A replica that sees a remote row with a
 * later `attached_at` than its own socket closes its socket with 4409 (clocks are assumed roughly in
 * sync; a tie keeps both until the next hello). A replica never overwrites a newer row of another one.
 *
 * A database outage degrades to local-only behaviour and is logged once per outage.
 */
export class ClusterBrowserHub {
  private readonly hub: BrowserHub;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly presenceMs: number;
  private readonly staleMs: number;
  private readonly token: Buffer;
  private readonly relayBearer: string;
  private readonly forwarded = new Map<string, AbortController>();
  private remote = new Map<string, Remote>();
  private sql?: SQL;
  private timer?: ReturnType<typeof setInterval>;
  private listening = false;
  private stopped = true;
  private outage = false;
  private lastOk = 0;
  private flushing?: Promise<void>;
  private dirty = false;
  private publish = false;

  constructor(private readonly opts: ClusterOptions) {
    this.hub = opts.hub;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.presenceMs = opts.presenceMs ?? 5_000;
    this.staleMs = opts.staleMs ?? 20_000;
    this.relayBearer = relaySecret(opts.adminToken);
    this.token = digest(this.relayBearer);
    this.hub.onChange = () => this.schedule(true);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.sql = new SQL(this.opts.databaseUrl);
    await this.listen();
    await this.sync(true);
    this.timer = setInterval(() => {
      void this.listen().then(() => this.sync(true));
    }, this.presenceMs);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const sql = this.sql;
    this.sql = undefined;
    await this.flushing?.catch(() => undefined);
    if (sql) {
      try {
        await sql`DELETE FROM gateway_browser_presence WHERE replica_id = ${this.opts.replicaId}`;
        await sql`SELECT pg_notify(${BROWSER_CHANNEL}, ${JSON.stringify({ t: "presence" })})`;
      } catch {
        // rows go stale on their own
      }
      await Promise.race([sql.close().catch(() => undefined), new Promise((r) => setTimeout(r, 2_000))]);
    }
    this.listening = false;
    this.remote = new Map();
  }

  // --- local hub surface ---------------------------------------------------

  open(ws: HubSocket): void {
    this.hub.open(ws);
  }
  message(ws: HubSocket, raw: string): Promise<void> {
    return this.hub.message(ws, raw);
  }
  detach(ws: HubSocket): void {
    this.hub.detach(ws);
  }
  closeAll(code: number): void {
    this.hub.closeAll(code);
  }
  activeSessions(): number {
    return this.hub.activeSessions();
  }

  /** Local bindings plus fresh remote ones; the local one wins on a duplicate name. */
  connected(): BrowserBinding[] {
    const out = new Map<string, BrowserBinding>();
    for (const [name, r] of this.remote) out.set(name, r.binding);
    for (const b of this.hub.connected()) out.set(b.name, b);
    return [...out.values()];
  }

  extensionVersion(binding: string): string | undefined {
    return this.hub.extensionVersion(binding) ?? this.remote.get(binding)?.extensionVersion;
  }

  async call(binding: string, req: CallRequest, timeoutMs: number): Promise<CallResult> {
    const local = this.hub.connected().some((b) => b.name === binding);
    const row = this.remote.get(binding);
    if (local || !row) return this.hub.call(binding, req, timeoutMs);
    const ctl = new AbortController();
    this.forwarded.set(req.id, ctl);
    const timer = setTimeout(() => ctl.abort(), timeoutMs + FORWARD_GRACE_MS);
    try {
      const res = await this.doFetch(`${row.replicaUrl}${RELAY_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.relayBearer}`, "content-type": "application/json" },
        body: JSON.stringify({ binding, req, timeoutMs }),
        signal: ctl.signal,
      });
      if (res.status !== 200) return this.unreachable(req.id);
      const result = sanitiseResult(await res.json());
      return result && result.id === req.id ? result : this.unreachable(req.id);
    } catch {
      return this.callerGone.has(req.id) ? { id: req.id, ok: false, error: "timeout", message: "The caller went away." } : this.unreachable(req.id);
    } finally {
      clearTimeout(timer);
      this.forwarded.delete(req.id);
      this.callerGone.delete(req.id);
    }
  }

  private readonly callerGone = new Set<string>();

  private unreachable(id: string): CallResult {
    return { id, ok: false, error: "browser_disconnected", message: "The browser's gateway replica did not answer." };
  }

  abort(id: string): void {
    const ctl = this.forwarded.get(id);
    if (ctl) {
      this.callerGone.add(id);
      ctl.abort();
    }
    this.hub.abort(id);
  }

  /** Revokes locally and tells every replica to drop its socket for the binding. */
  revoke(binding: string): void {
    this.hub.revoke(binding);
    this.remote.delete(binding);
    void this.notify({ t: "revoke", binding });
  }

  // --- relay endpoint ------------------------------------------------------

  /** `POST /internal/browser/relay` on the admin server. */
  async handleRelay(req: Request): Promise<Response> {
    if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const m = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m?.[1] || !timingSafeEqual(digest(m[1].trim()), this.token)) return Response.json({ error: "unauthorised" }, { status: 401 });
    let body: { binding?: unknown; req?: unknown; timeoutMs?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const r = body.req as Partial<CallRequest> | null | undefined;
    if (typeof body.binding !== "string" || typeof r !== "object" || r === null || typeof r.id !== "string" || typeof r.session?.id !== "string" || typeof body.timeoutMs !== "number" || !(body.timeoutMs > 0)) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const id = r.id;
    const onAbort = (): void => this.hub.abort(id);
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.hub.call(body.binding, r as CallRequest, Math.min(body.timeoutMs, MAX_RELAY_TIMEOUT_MS));
      return Response.json(result);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  // --- presence ------------------------------------------------------------

  private schedule(publish: boolean): void {
    if (this.stopped) return;
    void this.sync(publish);
  }

  /** Serialised presence flush and remote refresh; coalesces bursts. Never throws. */
  private sync(publish: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    this.publish ||= publish;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.dirty && !this.stopped) {
          this.dirty = false;
          const pub = this.publish;
          this.publish = false;
          await this.flushOnce(pub);
        }
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private async flushOnce(publish: boolean): Promise<void> {
    const sql = this.sql;
    if (!sql) return;
    try {
      const id = this.opts.replicaId;
      const local = this.hub.localPresence();
      for (const p of local) {
        await sql`
          INSERT INTO gateway_browser_presence (binding, replica_id, replica_url, binding_json, extension_version, paused, attached_at, updated_at)
          VALUES (${p.binding.name}, ${id}, ${this.opts.replicaUrl}, ${JSON.stringify(p.binding)}::jsonb, ${p.extensionVersion ?? null}, ${p.paused}, to_timestamp(${p.attachedAt}::float8 / 1000.0), now())
          ON CONFLICT (binding) DO UPDATE SET
            replica_id = EXCLUDED.replica_id, replica_url = EXCLUDED.replica_url, binding_json = EXCLUDED.binding_json,
            extension_version = EXCLUDED.extension_version, paused = EXCLUDED.paused, attached_at = EXCLUDED.attached_at, updated_at = now()
          WHERE gateway_browser_presence.replica_id = EXCLUDED.replica_id
             OR gateway_browser_presence.attached_at <= EXCLUDED.attached_at
             OR gateway_browser_presence.updated_at < now() - make_interval(secs => ${this.staleMs / 1000}::float8)`;
      }
      const mine = await sql`SELECT binding FROM gateway_browser_presence WHERE replica_id = ${id}`;
      const live = new Set(local.map((p) => p.binding.name));
      for (const row of mine as Array<{ binding: string }>) {
        if (!live.has(row.binding)) await sql`DELETE FROM gateway_browser_presence WHERE binding = ${row.binding} AND replica_id = ${id}`;
      }
      if (publish) await this.notify({ t: "presence" });
      await this.refreshRemote(sql);
      this.lastOk = this.now();
      this.outage = false;
    } catch (err) {
      this.failed(err);
    }
  }

  private async refreshRemote(sql: SQL): Promise<void> {
    const rows = (await sql`
      SELECT binding, replica_id, replica_url, binding_json, extension_version, paused,
             (extract(epoch FROM attached_at) * 1000)::float8 AS attached_ms
      FROM gateway_browser_presence
      WHERE replica_id <> ${this.opts.replicaId}
        AND updated_at > now() - make_interval(secs => ${this.staleMs / 1000}::float8)`) as Array<Record<string, unknown>>;
    const next = new Map<string, Remote>();
    for (const r of rows) {
      const raw = r.binding_json;
      const binding = (typeof raw === "string" ? JSON.parse(raw) : raw) as BrowserBinding;
      next.set(String(r.binding), {
        binding,
        replicaId: String(r.replica_id),
        replicaUrl: String(r.replica_url),
        paused: r.paused === true,
        attachedAt: Number(r.attached_ms),
        ...(typeof r.extension_version === "string" ? { extensionVersion: r.extension_version } : {}),
      });
    }
    this.remote = next;
    // A newer attach elsewhere replaces our older socket.
    for (const p of this.hub.localPresence()) {
      const other = next.get(p.binding.name);
      if (other && other.attachedAt > p.attachedAt) this.hub.closeBinding(p.binding.name, 4409, "replaced by a newer connection");
    }
  }

  private failed(err: unknown): void {
    if (this.now() - this.lastOk > this.staleMs) this.remote = new Map();
    if (this.outage) return;
    this.outage = true;
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`browser cluster: database unavailable, serving local browsers only${typeof code === "string" ? ` (${code})` : ""}`);
  }

  private async notify(payload: { t: "presence" } | { t: "revoke"; binding: string }): Promise<void> {
    const sql = this.sql;
    if (!sql) return;
    try {
      await sql`SELECT pg_notify(${BROWSER_CHANNEL}, ${JSON.stringify(payload)})`;
    } catch (err) {
      this.failed(err);
    }
  }

  private async listen(): Promise<void> {
    const sql = this.sql;
    if (!sql || this.listening || this.stopped) return;
    try {
      // Bun implements listen on SQL; its published types lag behind.
      await (sql as unknown as { listen(channel: string, cb: (payload: string) => void): Promise<unknown> }).listen(BROWSER_CHANNEL, (payload) => this.onNotify(payload));
      this.listening = true;
    } catch (err) {
      this.failed(err);
    }
  }

  private onNotify(payload: string): void {
    let msg: { t?: unknown; binding?: unknown };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.t === "revoke" && typeof msg.binding === "string") {
      this.hub.closeBinding(msg.binding, 4401, "binding revoked");
      this.remote.delete(msg.binding);
    } else if (msg.t === "presence") void this.sync(false);
  }
}
