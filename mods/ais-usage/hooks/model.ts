import type { LimitsEntry, SwapStatus, SwapUsage, Win } from '../types'

export type Resolved = {
  kind: 'pool' | 'identity' | 'unknown'
  pool?: string
  members?: string[]
  current?: string
  configDir: string
}

export const parseJson = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

const norm = (dir: string) => dir.replace(/\/+$/, '')

export const resolveCurrent = (
  limits: LimitsEntry[] | null,
  configDir: string | undefined,
  status: SwapStatus | null,
): Resolved => {
  const dir = norm(configDir ?? '')
  const hit = (limits ?? []).find(
    l => l.toolName === 'claude' && norm(l.identity.configDir) === dir,
  )
  if (!hit) return { kind: 'unknown', configDir: dir }
  const sp = hit.identity.swapPool
  if (sp) {
    return {
      kind: 'pool',
      pool: hit.identity.name,
      members: Array.isArray(sp.accounts) ? sp.accounts : [],
      current: status?.active ?? sp.active,
      configDir: dir,
    }
  }
  return { kind: 'identity', current: hit.identity.name, configDir: dir }
}

export const humanise = (n: number): string => {
  const a = Math.abs(n)
  const f = (v: number, s: string) => `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${s}`
  if (a >= 1e9) return f(n / 1e9, 'B')
  if (a >= 1e6) return f(n / 1e6, 'M')
  if (a >= 1e3) return f(n / 1e3, 'k')
  return String(Math.round(n))
}

/** Share of output tokens per member, in percent (0 when the total is 0). */
export const shares = (usage: SwapUsage | null): Record<string, number> => {
  const out: Record<string, number> = {}
  const total = (usage?.members ?? []).reduce((s, m) => s + m.output, 0)
  for (const m of usage?.members ?? []) out[m.member] = total ? (m.output / total) * 100 : 0
  return out
}

export const totals = (usage: SwapUsage | null) => ({
  messages: (usage?.members ?? []).reduce((s, m) => s + m.messages, 0),
  output: (usage?.members ?? []).reduce((s, m) => s + m.output, 0),
})

export const entriesFor = (limits: LimitsEntry[] | null, name: string): LimitsEntry[] =>
  (limits ?? []).filter(l => l.identity.name === name && !l.identity.swapPool)

export const maxPercent = (entries: LimitsEntry[]): number =>
  Math.max(0, ...entries.flatMap(e => e.windows.map(w => w.usedPercent)))

/** Identities other than the excluded names, skipping pools, sorted by name. */
export const others = (limits: LimitsEntry[] | null, exclude: (string | undefined)[]) => {
  const names = new Set<string>()
  const pools = new Set<string>()
  for (const l of limits ?? []) {
    if (l.identity.swapPool) pools.add(l.identity.name)
    else names.add(l.identity.name)
  }
  return [...names]
    .filter(n => !pools.has(n) && !exclude.includes(n))
    .sort()
    .map(name => {
      const entries = entriesFor(limits, name)
      return { name, entries, max: maxPercent(entries) }
    })
}

export type Tone = 'red' | 'yellow' | 'green'
export const tone = (p: number): Tone => (p >= 95 ? 'red' : p >= 75 ? 'yellow' : 'green')

export const pct = (p: number | undefined) => `${Math.round(p ?? 0)}%`

export const shortError = (s: string | undefined, max = 60) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

const pick = (ws: Win[], cat: string) => ws.find(w => w.category === cat)

/** Status line text, or undefined when there is nothing to show. */
export const statusLine = (
  r: Resolved,
  status: SwapStatus | null,
  limits: LimitsEntry[] | null,
): string | undefined => {
  if (!r.current) return undefined
  let five: number | undefined
  let week: number | undefined
  if (r.kind === 'pool') {
    const acc = status?.accounts.find(a => a.name === r.current)
    five = acc?.usage?.fiveHour?.utilization
    week = acc?.usage?.sevenDay?.utilization
  } else {
    const e = entriesFor(limits, r.current).find(l => l.toolName === 'claude')
    five = e && pick(e.windows, 'session')?.usedPercent
    week = e && pick(e.windows, 'week')?.usedPercent
  }
  const parts = [r.current]
  if (five !== undefined) parts.push(`5h ${pct(five)}`)
  if (week !== undefined) parts.push(`wk ${pct(week)}`)
  const body = parts.join(' ')
  return r.pool ? `${r.pool} > ${body}` : body
}

export type ProviderGroup = { tool: string; rows: LimitsEntry[] }

/** Pool case: per non-claude tool, the identities that are members of the pool. */
export const poolProviders = (limits: LimitsEntry[] | null, r: Resolved): ProviderGroup[] => {
  const tools = [...new Set((limits ?? []).map(l => l.toolName))].filter(t => t !== 'claude').sort()
  const out: ProviderGroup[] = []
  for (const tool of tools) {
    const own = (limits ?? []).find(l => l.toolName === tool && l.identity.swapPool)
    const names = Array.isArray(own?.identity.swapPool?.accounts)
      ? own!.identity.swapPool!.accounts!
      : (r.members ?? [])
    const rows = names.flatMap(n =>
      (limits ?? []).filter(l => l.toolName === tool && l.identity.name === n && !l.identity.swapPool),
    )
    if (rows.length) out.push({ tool, rows })
  }
  return out
}
