import { SQL } from "bun";
import { bounded } from "./refresh-guard.ts";

const LEADER_LOCK = "ais-gateway-leader";

/**
 * One leader among the gateway replicas: a session-level advisory lock on a reserved connection. The leader runs the idle
 * keep-alive pass and writes the ownership heartbeat; every replica serves and refreshes on demand (the refresh guard keeps
 * those safe). A leader that dies loses its session, so the database frees the lock and another replica takes it on its
 * next try. A connection error drops leadership at once.
 */
export class PgLeader {
  private readonly sql: SQL;
  private conn: Awaited<ReturnType<SQL["reserve"]>> | undefined;
  private leader = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(url: string, private readonly tryMs = 10_000, private readonly callMs = 5_000) {
    this.sql = new SQL(url, { max: 1 });
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** One attempt (also checks that a held lock's connection still answers). */
  async tick(): Promise<boolean> {
    if (this.busy) return this.leader;
    this.busy = true;
    try {
      this.conn ??= await bounded(this.sql.reserve(), this.callMs, "leader connection");
      const c = this.conn;
      if (this.leader) {
        await bounded(c`SELECT 1`, this.callMs, "leader ping");
        return true;
      }
      const rows = await bounded(c`SELECT pg_try_advisory_lock(hashtextextended(${LEADER_LOCK}, 0)) AS got`, this.callMs, "leader lock");
      this.leader = rows[0]?.got === true;
    } catch {
      this.leader = false;
      const c = this.conn;
      this.conn = undefined;
      if (c) await Promise.race([c.close().catch(() => undefined), new Promise((r) => setTimeout(r, this.callMs))]);
    } finally {
      this.busy = false;
    }
    return this.leader;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tryMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.leader = false;
    const c = this.conn;
    this.conn = undefined;
    if (c) await Promise.race([c.close().catch(() => undefined), new Promise((r) => setTimeout(r, this.callMs))]);
    await this.sql.close().catch(() => undefined);
  }
}
