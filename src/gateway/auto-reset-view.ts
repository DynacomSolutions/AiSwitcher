export const CODEX_AUTO_RESET_PATH = "/limits/codex/auto-reset";

export type AutoResetScope = "pool" | "identity";

export interface AutoResetStatus {
  name: string;
  enabled: boolean;
  lastClaim?: {
    pool: string;
    identity: string;
    startedAt: string;
    creditExpiresAt?: string;
    status: "pending" | "reset" | "rejected" | "unknown";
    spendPending?: true;
  };
}

export interface AutoResetView {
  pools: Array<AutoResetStatus & { members: string[] }>;
  identities: AutoResetStatus[];
}
