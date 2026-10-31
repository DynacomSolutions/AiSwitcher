export type Win = { label: string; category?: string; usedPercent: number; resetsAt?: string; resetsAtMs?: number }
export type SwapPool = { accounts?: string[]; disallowed?: string[]; active?: string; auto?: boolean; thresholdPercent?: number }
export type ExtraUsage = { enabled: boolean; available: boolean; usedPercent?: number; label: string }
export type LimitsEntry = {
  toolName: string
  provider?: string
  identity: { name: string; label?: string; configDir: string; aliases?: string[]; swapPool?: SwapPool }
  windows: Win[]
  status: string
  error?: string
  capturedAt?: string
  extraUsage?: ExtraUsage
}
export type SwapAccount = {
  name: string
  active: boolean
  allowed: boolean
  usage?: {
    status?: string
    fiveHour?: { utilization: number; resetsAt?: string }
    sevenDay?: { utilization: number; resetsAt?: string }
    maxUtilization?: number
    extraUsage?: ExtraUsage
  }
}
export type SwapStatus = {
  pool: string
  active: string
  auto: boolean
  thresholdPercent: number
  accounts: SwapAccount[]
}
export type SwapMember = { member: string; messages: number; input: number; output: number }
/** From the collector's snapshot: generatedAt is when it computed the split, stale once that is over 30 minutes old. */
export type SwapUsage = { pool: string; days: number; members: SwapMember[]; generatedAt?: string; stale?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ais-usage': {
      status: SwapStatus | null
      usage: SwapUsage | null
      limits: LimitsEntry[] | null
      /** Names of expanded "other identities" rows. */
      expanded: string[]
      /** Band toggles: "Other providers" and "Pool members" open. */
      open: 'others' | 'members' | null
      /** Epoch ms of the last completed fetch, 0 for none. */
      updatedAt: number
      /** Fetches in flight. */
      loading: number
      errors: string[]
      /** Pool member seen at the previous prompt, '' for none. */
      lastMember: string
    }
  }
}
