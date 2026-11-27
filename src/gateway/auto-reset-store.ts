import type { SQL } from "bun";
import type { CodexResetOutcome } from "./account.ts";
import type { AutoResetProvider } from "./auto-reset-view.ts";

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
  spendPending?: true;
}

export interface AutoResetClaim extends AutoResetClaimSummary {
  generation: number;
  redeemRequestId: string;
  finishedAt?: string;
  recoveredAt?: string;
}

export interface AutoResetClaimInput extends Omit<AutoResetClaimSummary, "status" | "creditedId" | "spendPending"> {
  provider: AutoResetProvider;
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
  knownOutcome?: CodexResetOutcome;
  unsent?: boolean;
}

/**
 * Automatic reset is a setting of a pool. No identity can be set. `lastMemberClaim` only reads the claim that a pool made on a member.
 */
export interface AutoResetStore {
  enabled(provider: AutoResetProvider, pool: string): Promise<boolean>;
  setEnabled(provider: AutoResetProvider, pool: string, enabled: boolean): Promise<void>;
  lastClaim(provider: AutoResetProvider, pool: string): Promise<AutoResetClaimSummary | undefined>;
  lastMemberClaim(provider: AutoResetProvider, identity: string): Promise<AutoResetClaimSummary | undefined>;
  findClaim(eventKey: string, generation?: number): Promise<AutoResetClaim | undefined>;
  claim(input: AutoResetClaimInput): Promise<ClaimResult>;
  beginSpend(redeemRequestId: string, identity: string, accountId?: string): Promise<boolean>;
  recordReportedCredit(redeemRequestId: string, creditId: string, knownOutcome?: CodexResetOutcome): Promise<void>;
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
  private readonly settings = new Map<string, boolean>();
  private readonly claims = new Map<string, MemoryClaim[]>();
  private readonly claimedCredits = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  async enabled(provider: AutoResetProvider, pool: string): Promise<boolean> {
    return this.settings.get(JSON.stringify([provider, pool])) === true;
  }

  async setEnabled(provider: AutoResetProvider, pool: string, enabled: boolean): Promise<void> {
    this.settings.set(JSON.stringify([provider, pool]), enabled);
  }

  async lastClaim(provider: AutoResetProvider, pool: string): Promise<AutoResetClaimSummary | undefined> {
    return this.latest(provider, "pool", pool);
  }

  async lastMemberClaim(provider: AutoResetProvider, identity: string): Promise<AutoResetClaimSummary | undefined> {
    return this.latest(provider, "identity", identity);
  }

  private latest(provider: AutoResetProvider, field: "pool" | "identity", name: string): AutoResetClaimSummary | undefined {
    let latest: { key: string; summary: AutoResetClaim } | undefined;
    for (const [key, generations] of this.claims) {
      for (const { input, summary } of generations) {
        if (input.provider !== provider || summary[field] !== name) continue;
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
    if (this.settings.get(JSON.stringify([input.provider, input.pool])) !== true || this.claimedCredits.has(input.creditId)) return { kind: "blocked" };
    const recordedAt = this.now();
    const members = new Set(input.usageEvidence.map((row) => row.identity));
    for (const claims of this.claims.values()) {
      if (claims.some((claim) => claim.input.provider === input.provider && claim.recordedAt > recordedAt - OVERLAP_MS &&
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

  async beginSpend(redeemRequestId: string, identity: string): Promise<boolean> {
    for (const claims of this.claims.values()) {
      const claim = claims.find(({ summary }) => summary.redeemRequestId === redeemRequestId &&
        summary.identity === identity && summary.status === "pending" && !summary.spendPending && !summary.creditedId);
      if (!claim) continue;
      claim.summary.spendPending = true;
      return true;
    }
    return false;
  }

  async recordReportedCredit(redeemRequestId: string, creditId: string, knownOutcome?: CodexResetOutcome): Promise<void> {
    for (const claims of this.claims.values()) {
      const claim = claims.find(({ input }) => input.redeemRequestId === redeemRequestId);
      if (!claim) continue;
      claim.summary.creditedId = creditId;
      if (knownOutcome !== undefined) delete claim.summary.spendPending;
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
    if (result?.unsent || (result?.knownOutcome !== undefined && creditedId !== undefined)) delete claim.summary.spendPending;
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
  spend_pending: boolean;
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
    ...(row.spend_pending ? { spendPending: true as const } : {}),
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

// Codex pool rules stay in codex_auto_reset_settings (kind = 'pool'), where they were first stored.
// Other providers use auto_reset_settings. Nothing copies or rewrites a stored rule.
// Setting queries ignore historical kind = 'identity' rows and leave them in place.
export class PgAutoResetStore implements AutoResetStore {
  constructor(private readonly sql: SQL) {}

  async enabled(provider: AutoResetProvider, pool: string): Promise<boolean> {
    const rows = provider === "codex"
      ? await this.sql`SELECT enabled FROM codex_auto_reset_settings WHERE kind = 'pool' AND name = ${pool}`
      : await this.sql`SELECT enabled FROM auto_reset_settings WHERE provider = ${provider} AND name = ${pool}`;
    return rows[0]?.enabled === true;
  }

  async setEnabled(provider: AutoResetProvider, pool: string, enabled: boolean): Promise<void> {
    if (provider === "codex") {
      await this.sql`INSERT INTO codex_auto_reset_settings (kind, name, enabled) VALUES ('pool', ${pool}, ${enabled})
        ON CONFLICT (kind, name) DO UPDATE SET enabled = EXCLUDED.enabled`;
      return;
    }
    await this.sql`INSERT INTO auto_reset_settings (provider, name, enabled) VALUES (${provider}, ${pool}, ${enabled})
      ON CONFLICT (provider, name) DO UPDATE SET enabled = EXCLUDED.enabled`;
  }

  async lastClaim(provider: AutoResetProvider, pool: string): Promise<AutoResetClaimSummary | undefined> {
    const rows = await this.sql`SELECT * FROM codex_auto_reset_claims WHERE provider = ${provider} AND pool = ${pool}
      ORDER BY started_at DESC, event_key, generation DESC LIMIT 1`;
    return summary(rows[0]);
  }

  async lastMemberClaim(provider: AutoResetProvider, identity: string): Promise<AutoResetClaimSummary | undefined> {
    const rows = await this.sql`SELECT * FROM codex_auto_reset_claims WHERE provider = ${provider} AND identity = ${identity}
      ORDER BY started_at DESC, event_key, generation DESC LIMIT 1`;
    return summary(rows[0]);
  }

  async findClaim(eventKey: string, generation?: number): Promise<AutoResetClaim | undefined> {
    const rows = generation === undefined
      ? await this.sql`SELECT * FROM codex_auto_reset_claims WHERE event_key = ${eventKey} ORDER BY generation DESC LIMIT 1`
      : await this.sql`SELECT * FROM codex_auto_reset_claims WHERE event_key = ${eventKey} AND generation = ${generation}`;
    return claimSummary(rows[0]);
  }

  async claim(input: AutoResetClaimInput): Promise<ClaimResult> {
    const { provider, eventKey, pool, identity, creditId, creditExpiresAt, startedAt, redeemRequestId, usageEvidence, creditEvidence, provider429At } = input;
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

      // Lock the enabled pool row through insert and commit so an administrator's disable cannot race the check.
      const settings = provider === "codex"
        ? await tx`SELECT name FROM codex_auto_reset_settings WHERE enabled AND kind = 'pool' AND name = ${pool} FOR SHARE`
        : await tx`SELECT name FROM auto_reset_settings WHERE enabled AND provider = ${provider} AND name = ${pool} FOR SHARE`;
      if (settings.length !== 1) return { kind: "blocked" };

      const rows = await tx`WITH requested AS (
          SELECT ARRAY(SELECT jsonb_array_elements_text(${members}::text::jsonb)) AS members
        )
        INSERT INTO codex_auto_reset_claims
          (provider, event_key, generation, pool, identity, credit_id, credit_expires_at, started_at, provider_429_at, redeem_request_id, members, usage_evidence, credit_evidence)
        SELECT ${provider}, ${eventKey}, ${generation}, ${pool}, ${identity}, ${creditId}, ${creditExpiresAt}, ${startedAt},
          ${provider429At === undefined ? null : new Date(provider429At).toISOString()}, ${redeemRequestId},
          requested.members, ${JSON.stringify(usageEvidence)}::text::jsonb, ${JSON.stringify(creditEvidence)}::text::jsonb
        FROM requested WHERE (${provider}::text <> 'codex' OR NOT EXISTS (
          SELECT 1 FROM codex_pool_reset_attempts WHERE credit_id = ${creditId} OR credited_id = ${creditId}
            OR (outcome IS NULL AND consumed_at IS NULL AND identity = ${identity})
        )) AND NOT EXISTS (
          SELECT 1 FROM codex_auto_reset_claims AS earlier
          WHERE earlier.credited_id = ${creditId}
            OR (earlier.provider = ${provider} AND earlier.spend_pending AND earlier.identity = ${identity})
            OR (earlier.provider = ${provider} AND earlier.recorded_at > statement_timestamp() - ${OVERLAP_MS}::int * interval '1 ms'
              AND earlier.members && requested.members)
        )
        ON CONFLICT DO NOTHING RETURNING event_key`;
      return rows.length === 1 ? { kind: "created" } : { kind: "blocked" };
    });
  }

  async beginSpend(redeemRequestId: string, identity: string, accountId?: string): Promise<boolean> {
    const account = accountId?.trim() || null;
    const rows = await this.sql`UPDATE codex_auto_reset_claims SET account_id = ${account}, spend_pending = true
      WHERE redeem_request_id = ${redeemRequestId}::uuid AND status = 'pending' AND identity = ${identity}
        AND NOT spend_pending AND credited_id IS NULL
      RETURNING credit_id`;
    return rows.length === 1;
  }

  async recordReportedCredit(redeemRequestId: string, creditId: string, knownOutcome?: CodexResetOutcome): Promise<void> {
    const rows = await this.sql`UPDATE codex_auto_reset_claims SET credited_id = ${creditId},
        provider_outcome = COALESCE(${knownOutcome ?? null}, provider_outcome),
        spend_pending = spend_pending AND NOT ${knownOutcome !== undefined}
      WHERE redeem_request_id = ${redeemRequestId}::uuid AND (credited_id IS NULL OR credited_id = ${creditId})
      RETURNING credit_id`;
    if (rows.length !== 1) throw new Error("The automatic reset claim is missing");
  }

  async finish(eventKey: string, status: TerminalStatus, creditedId?: string, result?: ClaimFinish): Promise<void> {
    const requestId = result?.redeemRequestId ?? null;
    const resolved = result?.unsent === true || (result?.knownOutcome !== undefined && creditedId !== undefined);
    await this.sql`UPDATE codex_auto_reset_claims SET status = ${status}, credited_id = COALESCE(${creditedId ?? null}, credited_id),
      finished_at = COALESCE(${result?.finishedAt ?? null}::timestamptz, clock_timestamp()), outcome = ${result?.outcome ?? null},
      provider_outcome = COALESCE(${creditedId === undefined ? null : result?.knownOutcome ?? null}, provider_outcome),
      spend_pending = spend_pending AND NOT ${resolved}
      WHERE event_key = ${eventKey} AND status = 'pending' AND
        CASE WHEN ${requestId}::uuid IS NULL THEN generation = 1 ELSE redeem_request_id = ${requestId}::uuid END`;
  }

  async markRecovered(eventKey: string, redeemRequestId: string, recoveredAt: string): Promise<void> {
    await this.sql`UPDATE codex_auto_reset_claims SET recovered_at = ${recoveredAt}
      WHERE event_key = ${eventKey} AND redeem_request_id = ${redeemRequestId}::uuid AND status = 'reset' AND recovered_at IS NULL
        AND (credited_id IS NULL OR credited_id = credit_id) AND finished_at <= ${recoveredAt}::timestamptz`;
  }
}
