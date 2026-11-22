/**
 * One LISTEN connection per gateway process.
 *
 * Every channel (apps changed, home files, browser cluster) shares this connection. It dispatches each notice to the
 * subscribers of its channel. The pooler runs in session mode, so each extra LISTEN connection would pin one more
 * server connection. When the connection drops, the next `ensure` call opens a new one and listens on every channel again.
 */
import { SQL } from "bun";
import { pgPoolOptions } from "./pg-pool.ts";

/** One open LISTEN connection. `onNotify` and `onClose` are given when it opens. */
export interface ListenConn {
  listen(channel: string): Promise<void>;
  unlisten(channel: string): Promise<void>;
  close(): Promise<void>;
}

export type OpenListenConn = (onNotify: (channel: string, payload: string) => void, onClose: () => void) => Promise<ListenConn>;

/** What components use: subscribe to a channel and get back an unsubscribe function. */
export interface PgListener {
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  /** Runs after the connection came back and every channel is listened on again. Returns a function that removes the handler. */
  onReconnect?(h: () => void): () => void;
}

type Subscriber = (payload: string) => void;

export class SharedListener implements PgListener {
  private conn: ListenConn | undefined;
  private opening: Promise<ListenConn> | undefined;
  private generation = 0;
  private closed = false;
  private everConnected = false;
  private readonly reconnectHandlers = new Set<() => void>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly subs = new Map<string, Set<Subscriber>>();

  constructor(private readonly open: OpenListenConn, private readonly warn: (message: string) => void = (m) => console.warn(`gateway listener: ${m}`), private readonly retryMs = 2_000) {}

  onReconnect(h: () => void): () => void {
    this.reconnectHandlers.add(h);
    return () => void this.reconnectHandlers.delete(h);
  }

  /** Number of channels with at least one subscriber (tests and metrics). */
  get channels(): number {
    return this.subs.size;
  }

  private dispatch(channel: string, payload: string): void {
    for (const fn of [...(this.subs.get(channel) ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        this.warn(`subscriber on ${channel} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** After a drop, tries again until the connection is back, so subscribers that listen only once keep their notices. */
  private scheduleReconnect(): void {
    if (this.closed || this.retry || this.subs.size === 0) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.closed || this.conn || this.subs.size === 0) return;
      this.ensure().catch((err) => {
        this.warn(`reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        this.scheduleReconnect();
      });
    }, this.retryMs);
    this.retry.unref?.();
  }

  /** Returns the live connection, opening one and listening on every subscribed channel when there is none. */
  private async ensure(): Promise<ListenConn> {
    if (this.closed) throw new Error("listener closed");
    if (this.conn) return this.conn;
    this.opening ??= (async () => {
      const gen = ++this.generation;
      const conn = await this.open(
        (channel, payload) => {
          if (gen === this.generation) this.dispatch(channel, payload);
        },
        () => {
          // A dropped connection is forgotten. The next `listen` or `reconnect` opens a new one.
          if (gen !== this.generation || !this.conn) return;
          this.conn = undefined;
          this.scheduleReconnect();
        },
      );
      try {
        for (const channel of this.subs.keys()) await conn.listen(channel);
      } catch (err) {
        await conn.close().catch(() => undefined);
        throw err;
      }
      if (this.closed) {
        await conn.close().catch(() => undefined);
        throw new Error("listener closed");
      }
      this.conn = conn;
      const again = this.everConnected;
      this.everConnected = true;
      // Notices sent while the connection was down are gone. Tell the components, so they read their state again.
      if (again) {
        for (const h of [...this.reconnectHandlers]) {
          try {
            h();
          } catch (err) {
            this.warn(`reconnect handler threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return conn;
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /**
   * Opens the connection again if it dropped, and listens on every subscribed channel. Components call this from their
   * own periodic check. It is cheap when the connection is up.
   */
  async reconnect(): Promise<void> {
    await this.ensure();
  }

  async listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>> {
    const conn = await this.ensure();
    let set = this.subs.get(channel);
    const first = !set;
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(onPayload);
    if (first) {
      try {
        await conn.listen(channel);
      } catch (err) {
        set.delete(onPayload);
        if (set.size === 0) this.subs.delete(channel);
        // The connection is not trusted any more: the next call opens a fresh one.
        this.conn = undefined;
        this.generation += 1;
        await conn.close().catch(() => undefined);
        throw err;
      }
    }
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      const current = this.subs.get(channel);
      if (!current) return;
      current.delete(onPayload);
      if (current.size > 0) return;
      this.subs.delete(channel);
      await this.conn?.unlisten(channel).catch(() => undefined);
    };
  }

  /** Closes the connection. Later `listen` calls fail. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const conn = this.conn;
    this.conn = undefined;
    this.generation += 1;
    this.subs.clear();
    await this.opening?.then((c) => c.close(), () => undefined).catch(() => undefined);
    await conn?.close().catch(() => undefined);
  }
}

/**
 * The real connection. Bun runs `listen` on one dedicated connection per SQL instance, outside the pool, and shares it
 * across channels. This instance never runs a query, so it holds exactly one server connection. It has no idle timeout,
 * which would otherwise close the listener without a sound. Bun itself listens again after a server drop.
 */
export function bunListenConn(url: string): OpenListenConn {
  return async (onNotify) => {
    const sql = new SQL(url, pgPoolOptions({ maxCap: 1, idle: false }));
    // biome-ignore lint/suspicious/noExplicitAny: Bun's SQL listen is not in the published types yet
    const raw = sql as any;
    const handles = new Map<string, { unlisten?: () => unknown }>();
    return {
      async listen(channel) {
        handles.set(channel, await raw.listen(channel, (payload: string) => onNotify(channel, payload)));
      },
      async unlisten(channel) {
        const handle = handles.get(channel);
        handles.delete(channel);
        await Promise.resolve(handle?.unlisten?.());
      },
      async close() {
        handles.clear();
        await sql.close();
      },
    };
  };
}

const shared = new Map<string, { listener: SharedListener; users: number }>();

/**
 * The process-wide listener for a database URL, created on first use. It opens no connection until the first `listen`.
 * Each caller counts as one user and calls `releaseGatewayListener` once. The last release closes the connection.
 */
export function getGatewayListener(url: string): SharedListener {
  let entry = shared.get(url);
  if (!entry) {
    entry = { listener: new SharedListener(bunListenConn(url)), users: 0 };
    shared.set(url, entry);
  }
  entry.users += 1;
  return entry.listener;
}

/** Gives a user's hold back. Closes the listener when no user is left. */
export async function releaseGatewayListener(url: string): Promise<void> {
  const entry = shared.get(url);
  if (!entry) return;
  entry.users -= 1;
  if (entry.users > 0) return;
  shared.delete(url);
  await entry.listener.close().catch(() => undefined);
}
