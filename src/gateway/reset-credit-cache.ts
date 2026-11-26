import type { SQL } from "bun";

/** Shared generations make every gateway replica discard a local reset-credit read after a spend. */
export interface ResetCreditInvalidations {
  version(identity: string): Promise<string>;
  invalidate(identity: string): Promise<void>;
}

export class MemoryResetCreditInvalidations implements ResetCreditInvalidations {
  private readonly versions = new Map<string, number>();
  async version(identity: string): Promise<string> { return String(this.versions.get(identity) ?? 0); }
  async invalidate(identity: string): Promise<void> { this.versions.set(identity, (this.versions.get(identity) ?? 0) + 1); }
}

export class PgResetCreditInvalidations implements ResetCreditInvalidations {
  constructor(private readonly sql: SQL) {}
  async version(identity: string): Promise<string> {
    const rows = await this.sql`SELECT version::text AS version FROM reset_credit_invalidations WHERE provider = 'codex' AND identity = ${identity}`;
    return String(rows[0]?.version ?? "0");
  }
  async invalidate(identity: string): Promise<void> {
    await this.sql`INSERT INTO reset_credit_invalidations (provider, identity, version) VALUES ('codex', ${identity}, 1)
      ON CONFLICT (provider, identity) DO UPDATE SET version = reset_credit_invalidations.version + 1`;
  }
}
