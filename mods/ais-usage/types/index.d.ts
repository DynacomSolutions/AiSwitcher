export type Win = { label: string; category?: string; usedPercent: number; resetsAt?: string; resetsAtMs?: number }
export type SwapPool = { accounts?: string[]; active?: string; auto?: boolean; thresholdPercent?: number }
export type LimitsEntry = {
  toolName: string
  provider?: string
  identity: { name: string; label?: string; configDir: string; aliases?: string[]; swapPool?: SwapPool }
  windows: Win[]
  status: string
  error?: string
  capturedAt?: string
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
export type SwapUsage = { pool: string; days: number; members: SwapMember[] }

declare module 'claude-code' {
  interface PluginState {
    'ais-usage': {
      status: SwapStatus | null
      usage: SwapUsage | null
      limits: LimitsEntry[] | null
      /** Names of expanded "other identities" rows. */
      expanded: string[]
      /** Epoch ms of the last completed fetch, 0 for none. */
      updatedAt: number
      /** Fetches in flight. */
      loading: number
      errors: string[]
    }
  }
}
