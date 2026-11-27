import type { SQL } from "bun";

type Setting = "pool" | "identity";
type ClaimStatus = "pending" | "reset" | "rejected" | "unknown";
type TerminalStatus = Exclude<ClaimStatus, "pending">;

type ChoiceReason = "only_candidate" | "earliest_expiry" | "latest_weekly_reset" | "identity_order" | "pool_order" | "credit_id_order";

export interface AutoResetCreditEvidence {
  reason: ChoiceReason;
  imminentResetAt?: string;
  inventories: Array<{
    identity: string;
    pools: string[];
    weeklyResetAt: string;
    availableCount?: number;
    readAt?: string;
    credits: Array<{ id: string; expiresAt: string }>;
  }>;
}

export interface AutoResetClaimSummary {
  pool: string;
  identity: string;
  creditId: string;
  creditExpiresAt: string;
  startedAt: string;
  status: ClaimStatus;
  creditedId?: string;
}

export interface AutoResetClaim extends AutoResetClaimSummary {
  generation: number;
  redeemRequestId: string;
  finishedAt?: string;
  recoveredAt?: string;
}

export interface AutoResetClaimInput extends Omit<AutoResetClaimSummary, "status" | "creditedId"> {
  eventKey: string;
  redeemRequestId: string;
  provider429At?: number;
  usageEvidence: Array<{ identity: string; resetAt: string; capturedAt: string; weeklyUtilisation: number; codexRateLimitAllowed?: boolean }>;
  creditEvidence: AutoResetCreditEvidence;
}

type ClaimResult =
  | { kind: "created" }
  | { kind: "existing"; claim: AutoResetClaim }
  | { kind: "blocked" };

interface ClaimFinish {
  redeemRequestId: string;
  finishedAt: string;
  outcome: string;
}

export interface AutoResetStore {
  enabled(kind: Setting, name: string): Promise<boolean>;
  setEnabled(kind: Setting, name: string, enabled: boolean): Promise<void>;
  lastClaim(kind: Setting, name: string): Promise<AutoResetClaimSummary | undefined>;
  findClaim(eventKey: string, generation?: number): Promise<AutoResetClaim | undefined>;
  claim(input: AutoResetClaimInput): Promise<ClaimResult>;
  recordReportedCredit(redeemRequestId: string, creditId: string): Promise<void>;
  finish(eventKey: string, status: TerminalStatus, creditedId?: string, result?: ClaimFinish): Promise<void>;
  markRecovered(eventKey: string, redeemRequestId: string, recoveredAt: string): Promise<void>;
}

/** A short guard against concurrent requests with different evidence for overlapping routes. */
const OVERLAP_MS = 25_000;
const CLAIM_LOCK_KEY = 7_410_103;

export function canRearmClaim(
  claim: AutoResetClaim,
  provider429At: number | undefined,
  checkedAt: number,
  evidence: AutoResetClaimInput["usageEvidence"],
): boolean {
  return claim.status === "reset" && claim.recoveredAt !== undefined &&
    provider429At !== undefined && Number.isSafeInteger(provider429At) &&
    provider429At > Date.parse(claim.recoveredAt) && provider429At <= checkedAt &&
    checkedAt - provider429At < OVERLAP_MS && evidence.length > 0 &&
    evidence.every(({ capturedAt, resetAt, weeklyUtilisation, codexRateLimitAllowed }) => {
      const captured = Date.parse(capturedAt);
      return captured >= provider429At && captured <= checkedAt && Date.parse(resetAt) > checkedAt &&
        Number.isFinite(weeklyUtilisation) && weeklyUtilisation >= 100 && codexRateLimitAllowed !== true;
    });
}

interface MemoryClaim {
  input: AutoResetClaimInput;
  summary: AutoResetClaim;
  recordedAt: number;
}

/** Test implementation. Claim checks and insertion run together without an await. */
export class MemoryAutoResetStore implements AutoResetStore {
  private readonly settings = { pool: new Map<string, boolean>(), identity: new Map<string, boolean>() };
  private readonly claims = new Map<string, MemoryClaim[]>();
  private readonly claimedCredits = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  async enabled(kind: Setting, name: string): Promise<boolean> {
    return this.settings[kind].get(name) === true;
  }

  async setEnabled(kind: Setting, name: string, enabled: boolean): Promise<void> {
    this.settings[kind].set(name, enabled);
  }

  async lastClaim(kind: Setting, name: string): Promise<AutoResetClaimSummary | undefined> {
    let latest: { key: string; summary: AutoResetClaim } | undefined;
    for (const [key, generations] of this.claims) {
      for (const { summary } of generations) {
        if (summary[kind] !== name) continue;
        if (!latest || summary.startedAt > latest.summary.startedAt || (summary.startedAt === latest.summary.startedAt &&
          (key < latest.key || (key === latest.key && summary.generation > latest.summary.generation)))) latest = { key, summary };
      }
    }
    if (!latest) return undefined;
    const { generation, redeemRequestId, finishedAt, recoveredAt, ...publicSummary } = latest.summary;
    return publicSummary;
  }

  async findClaim(eventKey: string, generation?: number): Promise<AutoResetClaim | undefined> {
    const generations = this.claims.get(eventKey);
    const claim = generation === undefined ? generations?.at(-1) : generations?.[generation - 1];
    return claim && { ...claim.summary };
  }

  async claim(input: AutoResetClaimInput): Promise<ClaimResult> {
    const generations = this.claims.get(input.eventKey) ?? [];
    const existing = generations.at(-1)?.summary;
    if (existing && !canRearmClaim(existing, input.provider429At, Date.parse(input.startedAt), input.usageEvidence)) {
      return { kind: "existing", claim: { ...existing } };
    }
    if (!this.settings.pool.get(input.pool) || !this.settings.identity.get(input.identity) ||
      this.claimedCredits.has(input.creditId)) return { kind: "blocked" };
    const recordedAt = this.now();
    const members = new Set(input.usageEvidence.map((row) => row.identity));
    for (const claims of this.claims.values()) {
      if (claims.some((claim) => claim.recordedAt > recordedAt - OVERLAP_MS &&
        claim.input.usageEvidence.some((row) => members.has(row.identity)))) return { kind: "blocked" };
    }
    const { pool, identity, creditId, creditExpiresAt, startedAt } = input;
    generations.push({
      input: structuredClone(input), recordedAt,
      summary: {
        pool, identity, creditId, creditExpiresAt, startedAt, status: "pending",
        generation: generations.length + 1, redeemRequestId: input.redeemRequestId,
      },
    });
    this.claims.set(input.eventKey, generations);
    this.claimedCredits.add(creditId);
    return { kind: "created" };
  }

  async recordReportedCredit(redeemRequestId: string, creditId: string): Promise<void> {
    for (const claims of this.claims.values()) {
      const claim = claims.find(({ input }) => input.redeemRequestId === redeemRequestId);
      if (!claim) continue;
      claim.summary.creditedId = creditId;
      this.claimedCredits.add(creditId);
      return;
    }
    throw new Error("The automatic reset claim is missing");
  }

  async finish(eventKey: string, status: TerminalStatus, creditedId?: string, result?: ClaimFinish): Promise<void> {
    const claims = this.claims.get(eventKey);
    const claim = result ? claims?.find(({ input }) => input.redeemRequestId === result.redeemRequestId) : claims?.[0];
    if (claim?.summary.status !== "pending") return;
    claim.summary.status = status;
    claim.summary.finishedAt = result?.finishedAt ?? new Date(this.now()).toISOString();
    if (creditedId !== undefined) {
      claim.summary.creditedId = creditedId;
      this.claimedCredits.add(creditedId);
    }
  }

  async markRecovered(eventKey: string, redeemRequestId: string, recoveredAt: string): Promise<void> {
    const claim = this.claims.get(eventKey)?.find(({ input }) => input.redeemRequestId === redeemRequestId)?.summary;
    if (claim?.status === "reset" && claim.finishedAt && !claim.recoveredAt &&
      (claim.creditedId === undefined || claim.creditedId === claim.creditId) && recoveredAt >= claim.finishedAt) {
      claim.recoveredAt = recoveredAt;
    }
  }
}

interface ClaimRow {
  pool: string;
  identity: string;
  credit_id: string;
  credit_expires_at: Date | string;
  started_at: Date | string;
  status: ClaimStatus;
  credited_id: string | null;
  generation: number;
  redeem_request_id: string;
  finished_at: Date | string | null;
  recovered_at: Date | string | null;
}

function summary(row: ClaimRow | undefined): AutoResetClaimSummary | undefined {
  if (!row) return undefined;
  return {
    pool: row.pool,
    identity: row.identity,
    creditId: row.credit_id,
    creditExpiresAt: new Date(row.credit_expires_at).toISOString(),
    startedAt: new Date(row.started_at).toISOString(),
    status: row.status,
    ...(row.credited_id === null ? {} : { creditedId: row.credited_id }),
  };
}

function claimSummary(row: ClaimRow | undefined): AutoResetClaim | undefined {
  const publicSummary = summary(row);
  if (!row || !publicSummary) return undefined;
  return {
    ...publicSummary,
    generation: row.generation,
    redeemRequestId: row.redeem_request_id,
    ...(row.finished_at === null ? {} : { finishedAt: new Date(row.finished_at).toISOString() }),
    ...(row.recovered_at === null ? {} : { recoveredAt: new Date(row.recovered_at).toISOString() }),
  };
}

export class PgAutoResetStore implements AutoResetStore {
  constructor(private readonly sql: SQL) {}

  async enabled(kind: Setting, name: string): Promise<boolean> {
    const rows = await this.sql`SELECT enabled FROM codex_auto_reset_settings WHERE kind = ${kind} AND name = ${name}`;
    return rows[0]?.enabled === true;
  }

  async setEnabled(kind: Setting, name: string, enabled: boolean): Promise<void> {
    await this.sql`INSERT INTO codex_auto_reset_settings (kind, name, enabled) VALUES (${kind}, ${name}, ${enabled})
      ON CONFLICT (kind, name) DO UPDATE SET enabled = EXCLUDED.enabled`;
  }

  async lastClaim(kind: Setting, name: string): Promise<AutoResetClaimSummary | undefined> {
    const rows = kind === "pool"
      ? await this.sql`SELECT * FROM codex_auto_reset_claims WHERE pool = ${name} ORDER BY started_at DESC, event_key, generation DESC LIMIT 1`
      : await this.sql`SELECT * FROM codex_auto_reset_claims WHERE identity = ${name} ORDER BY started_at DESC, event_key, generation DESC LIMIT 1`;
    return summary(rows[0]);
  }

  async findClaim(eventKey: string, generation?: number): Promise<AutoResetClaim | undefined> {
    const rows = generation === undefined
      ? await this.sql`SELECT * FROM codex_auto_reset_claims WHERE event_key = ${eventKey} ORDER BY generation DESC LIMIT 1`
      : await this.sql`SELECT * FROM codex_auto_reset_claims WHERE event_key = ${eventKey} AND generation = ${generation}`;
    return claimSummary(rows[0]);
  }

  async claim(input: AutoResetClaimInput): Promise<ClaimResult> {
    const { eventKey, pool, identity, creditId, creditExpiresAt, startedAt, redeemRequestId, usageEvidence, creditEvidence, provider429At } = input;
    const members = JSON.stringify(usageEvidence.map((row) => row.identity));
    return this.sql.begin(async (tx): Promise<ClaimResult> => {
      await tx`SET LOCAL statement_timeout = '2s'`;
      await tx`SET LOCAL lock_timeout = '1s'`;
      // Every Codex routing app shares this short transaction lock. Keep provider I/O outside it.
      await tx`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_KEY})`;
      const existing = claimSummary((await tx`SELECT * FROM codex_auto_reset_claims WHERE event_key = ${eventKey}
        ORDER BY generation DESC LIMIT 1`)[0]);
      if (existing && !canRearmClaim(existing, provider429At, Date.parse(startedAt), usageEvidence)) {
        return { kind: "existing", claim: existing };
      }
      const generation = (existing?.generation ?? 0) + 1;

      // Lock both enabled rows through insert and commit so an administrator's disable cannot race the check.
      const settings = await tx`SELECT kind FROM codex_auto_reset_settings
        WHERE enabled AND ((kind = 'pool' AND name = ${pool}) OR (kind = 'identity' AND name = ${identity}))
        ORDER BY kind FOR SHARE`;
      if (settings.length !== 2) return { kind: "blocked" };

      const rows = await tx`WITH requested AS (
          SELECT ARRAY(SELECT jsonb_array_elements_text(${members}::text::jsonb)) AS members
        )
        INSERT INTO codex_auto_reset_claims
          (event_key, generation, pool, identity, credit_id, credit_expires_at, started_at, provider_429_at, redeem_request_id, members, usage_evidence, credit_evidence)
        SELECT ${eventKey}, ${generation}, ${pool}, ${identity}, ${creditId}, ${creditExpiresAt}, ${startedAt},
          ${provider429At === undefined ? null : new Date(provider429At).toISOString()}, ${redeemRequestId},
          requested.members, ${JSON.stringify(usageEvidence)}::text::jsonb, ${JSON.stringify(creditEvidence)}::text::jsonb
        FROM requested WHERE NOT EXISTS (
          SELECT 1 FROM codex_pool_reset_attempts WHERE credit_id = ${creditId} OR credited_id = ${creditId}
        ) AND NOT EXISTS (
          SELECT 1 FROM codex_auto_reset_claims AS earlier
          WHERE earlier.credited_id = ${creditId}
            OR (earlier.recorded_at > statement_timestamp() - ${OVERLAP_MS}::int * interval '1 ms'
              AND earlier.members && requested.members)
        )
        ON CONFLICT DO NOTHING RETURNING event_key`;
      return rows.length === 1 ? { kind: "created" } : { kind: "blocked" };
    });
  }

  async recordReportedCredit(redeemRequestId: string, creditId: string): Promise<void> {
    const rows = await this.sql`UPDATE codex_auto_reset_claims SET credited_id = ${creditId}
      WHERE redeem_request_id = ${redeemRequestId}::uuid RETURNING credit_id`;
    if (rows.length !== 1) throw new Error("The automatic reset claim is missing");
  }

  async finish(eventKey: string, status: TerminalStatus, creditedId?: string, result?: ClaimFinish): Promise<void> {
    const requestId = result?.redeemRequestId ?? null;
    await this.sql`UPDATE codex_auto_reset_claims SET status = ${status}, credited_id = COALESCE(${creditedId ?? null}, credited_id),
      finished_at = COALESCE(${result?.finishedAt ?? null}::timestamptz, clock_timestamp()), outcome = ${result?.outcome ?? null}
      WHERE event_key = ${eventKey} AND status = 'pending' AND
        CASE WHEN ${requestId}::uuid IS NULL THEN generation = 1 ELSE redeem_request_id = ${requestId}::uuid END`;
  }

  async markRecovered(eventKey: string, redeemRequestId: string, recoveredAt: string): Promise<void> {
    await this.sql`UPDATE codex_auto_reset_claims SET recovered_at = ${recoveredAt}
      WHERE event_key = ${eventKey} AND redeem_request_id = ${redeemRequestId}::uuid AND status = 'reset' AND recovered_at IS NULL
        AND (credited_id IS NULL OR credited_id = credit_id) AND finished_at <= ${recoveredAt}::timestamptz`;
  }
}
