/** Providers with a reset credit or grant API that the gateway can spend. */
export const AUTO_RESET_PROVIDERS = ["codex", "claude"] as const;
export type AutoResetProvider = (typeof AUTO_RESET_PROVIDERS)[number];

/** Gateway providers that have no reset API. The console shows them as not supported. */
export const AUTO_RESET_UNSUPPORTED = ["kimi", "zai", "grok", "ali", "opencode"] as const;
export type AutoResetUnsupportedProvider = (typeof AUTO_RESET_UNSUPPORTED)[number];

export const AUTO_RESET_UNSUPPORTED_REASON = "This provider has no reset credit or grant API.";

/** Provider-generic list of every provider and pool. */
export const AUTO_RESET_PATH = "/limits/auto-reset";

/** One provider: `GET` lists its pools, `PUT <path>/pool` sets a pool. Codex used this path first, so it stays valid. */
export const autoResetProviderPath = (provider: string): string => `/limits/${provider}/auto-reset`;

/** The path that Codex used before every provider had a setting. It is the Codex form of `autoResetProviderPath`. */
export const CODEX_AUTO_RESET_PATH = autoResetProviderPath("codex");

export function isAutoResetProvider(value: string): value is AutoResetProvider {
  return (AUTO_RESET_PROVIDERS as readonly string[]).includes(value);
}

export interface AutoResetLastClaim {
  pool: string;
  identity: string;
  startedAt: string;
  creditExpiresAt?: string;
  status: "pending" | "reset" | "rejected" | "unknown";
  spendPending?: true;
}

/** The setting of one pool. Automatic reset is a pool setting only. */
export interface AutoResetStatus {
  name: string;
  enabled: boolean;
  lastClaim?: AutoResetLastClaim;
}

export interface AutoResetPoolStatus extends AutoResetStatus {
  members: string[];
}

export interface AutoResetProviderView {
  provider: AutoResetProvider;
  supported: true;
  pools: AutoResetPoolStatus[];
  /** The last claim that a pool made on each member. It is read only and has no setting. */
  memberClaims: Record<string, AutoResetLastClaim>;
}

export interface AutoResetUnsupportedView {
  provider: AutoResetUnsupportedProvider;
  supported: false;
  reason: string;
}

export interface AutoResetView {
  providers: Array<AutoResetProviderView | AutoResetUnsupportedView>;
}
