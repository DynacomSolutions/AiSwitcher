import type { SQL } from "bun";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { GatewayProvider } from "./types.ts";

export interface SharedReading {
  reading: PoolUsage;
  /** How old the reading is, by the store's own clock (ms). Negative means the stored time lies in the future: never trust it as live. */
  ageMs: number;
}

/** Usage readings shared by the gateway replicas. Ages come from one clock (the database), never from a replica clock. */
export interface UsageReadings {
  load(provider: GatewayProvider, identity: string): Promise<SharedReading | undefined>;
  loadAll(): Promise<Array<SharedReading & { provider: GatewayProvider; identity: string }>>;
  /** Stores the reading as taken `ageMs` ago. It replaces the stored one only when newer, or when the stored time lies in the future. */
  save(provider: GatewayProvider, identity: string, reading: PoolUsage, ageMs?: number): Promise<void>;
  /** Claims the right to poll upstream for `holdMs`. False when another replica holds a live claim. */
  claim(provider: GatewayProvider, identity: string, holdMs: number): Promise<boolean>;
  /** Gives the claim up (the poll ended with no figure to share), so another replica need not wait for the hold to run out. */
  release(provider: GatewayProvider, identity: string): Promise<void>;
}

interface MemRow {
  provider: GatewayProvider;
  identity: string;
  reading: PoolUsage;
  readAt: number;
  claimedAt?: number;
}

/** In memory: for tests and for a gateway with no database of its own. It mirrors the PG rules with its own clock. */
export class MemoryUsageReadings implements UsageReadings {
  private readonly rows = new Map<string, MemRow>();
  constructor(private readonly clock: () => number = Date.now) {}
  private key = (p: string, i: string): string => `${p}\u0000${i}`;
  async load(provider: GatewayProvider, identity: string): Promise<SharedReading | undefined> {
    const r = this.rows.get(this.key(provider, identity));
    return r && { reading: r.reading, ageMs: this.clock() - r.readAt };
  }
  async loadAll(): Promise<Array<SharedReading & { provider: GatewayProvider; identity: string }>> {
    return [...this.rows.values()].map((r) => ({ provider: r.provider, identity: r.identity, reading: r.reading, ageMs: this.clock() - r.readAt }));
  }
  async save(provider: GatewayProvider, identity: string, reading: PoolUsage, ageMs = 0): Promise<void> {
    const k = this.key(provider, identity);
    const cur = this.rows.get(k);
    const readAt = this.clock() - ageMs;
    if (!cur || readAt > cur.readAt || cur.readAt > this.clock()) this.rows.set(k, { provider, identity, reading, readAt, claimedAt: cur?.claimedAt });
  }
  async claim(provider: GatewayProvider, identity: string, holdMs: number): Promise<boolean> {
    const k = this.key(provider, identity);
    const cur = this.rows.get(k);
    const t = this.clock();
    if (cur?.claimedAt !== undefined && cur.claimedAt > t - holdMs) return false;
    if (cur) cur.claimedAt = t;
    else this.rows.set(k, { provider, identity, reading: { status: "unavailable", capturedAt: new Date(0).toISOString() }, readAt: 0, claimedAt: t });
    return true;
  }
  async release(provider: GatewayProvider, identity: string): Promise<void> {
    const cur = this.rows.get(this.key(provider, identity));
    if (cur) cur.claimedAt = undefined;
  }
}

interface Row {
  provider: string;
  identity: string;
  reading: unknown;
  age_ms: string | number;
}

const parse = (v: unknown): PoolUsage => (typeof v === "string" ? JSON.parse(v) : v) as PoolUsage;

/** PostgreSQL table `usage_readings` (migration 0010). Times use the database clock. */
export class PgUsageReadings implements UsageReadings {
  constructor(private readonly sql: SQL) {}
  async load(provider: GatewayProvider, identity: string): Promise<SharedReading | undefined> {
    const rows: Row[] = await this.sql`SELECT reading, extract(epoch from now() - read_at) * 1000 AS age_ms FROM usage_readings WHERE provider = ${provider} AND identity = ${identity}`;
    return rows[0] && { reading: parse(rows[0].reading), ageMs: Number(rows[0].age_ms) };
  }
  async loadAll(): Promise<Array<SharedReading & { provider: GatewayProvider; identity: string }>> {
    const rows: Row[] = await this.sql`SELECT provider, identity, reading, extract(epoch from now() - read_at) * 1000 AS age_ms FROM usage_readings`;
    return rows.map((r) => ({ provider: r.provider as GatewayProvider, identity: r.identity, reading: parse(r.reading), ageMs: Number(r.age_ms) }));
  }
  async save(provider: GatewayProvider, identity: string, reading: PoolUsage, ageMs = 0): Promise<void> {
    const json = JSON.stringify(reading);
    const secs = Math.max(0, ageMs) / 1000;
    await this.sql`INSERT INTO usage_readings (provider, identity, reading, read_at) VALUES (${provider}, ${identity}, ${json}::jsonb, now() - make_interval(secs => ${secs}::float8))
      ON CONFLICT (provider, identity) DO UPDATE SET reading = EXCLUDED.reading, read_at = EXCLUDED.read_at
      WHERE usage_readings.read_at < EXCLUDED.read_at OR usage_readings.read_at > now()`;
  }
  async claim(provider: GatewayProvider, identity: string, holdMs: number): Promise<boolean> {
    const secs = holdMs / 1000;
    const rows: unknown[] = await this.sql`INSERT INTO usage_readings (provider, identity, reading, read_at, claimed_at)
      VALUES (${provider}, ${identity}, '{"status":"unavailable","capturedAt":"1970-01-01T00:00:00.000Z"}'::jsonb, 'epoch', now())
      ON CONFLICT (provider, identity) DO UPDATE SET claimed_at = now()
      WHERE usage_readings.claimed_at IS NULL OR usage_readings.claimed_at < now() - make_interval(secs => ${secs}::float8)
      RETURNING 1 AS ok`;
    return rows.length > 0;
  }
  async release(provider: GatewayProvider, identity: string): Promise<void> {
    await this.sql`UPDATE usage_readings SET claimed_at = NULL WHERE provider = ${provider} AND identity = ${identity}`;
  }
}
