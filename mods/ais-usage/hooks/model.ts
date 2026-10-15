import type { LimitsEntry, SwapAccount, SwapStatus, SwapUsage, Win } from '../types'

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

const CAT = { fiveHour: 'session', sevenDay: 'week' } as const

/** One member's window: from status when it carries usage, else from its own `claude` limits entry (live preferred, cached accepted). */
export const memberWindow = (
  status: SwapStatus | null,
  limits: LimitsEntry[] | null,
  name: string,
  key: 'fiveHour' | 'sevenDay',
): { pct: number; resetsAt?: string | number } | undefined => {
  const u = status?.accounts.find(a => a.name === name)?.usage?.[key]
  if (u) return { pct: u.utilization, resetsAt: u.resetsAt }
  const es = entriesFor(limits, name).filter(l => l.toolName === 'claude')
  const w = [...es.filter(l => l.status === 'live'), ...es].map(l => pick(l.windows, CAT[key])).find(Boolean)
  return w ? { pct: w.usedPercent, resetsAt: w.resetsAtMs ?? w.resetsAt } : undefined
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

const clamp01 = (p: number) => Math.min(100, Math.max(0, Number.isFinite(p) ? p : 0))
const cells = (p: number, width: number) => Math.round((clamp01(p) / 100) * width)

/** Single-colour bar body (no brackets) as [filled, empty] full-block runs. */
export const bar = (p: number, width: number): [string, string] => {
  const n = cells(p, width)
  return ['\u2588'.repeat(n), '\u2588'.repeat(Math.max(0, width - n))]
}

export type Window5 = 'fiveHour' | 'sevenDay'

/** Mean utilization of one window across allowed members that report it. */
export const poolWindowPct = (
  accounts: SwapAccount[],
  key: Window5,
): { pct: number | undefined; reporting: number; total: number } => {
  const allowed = accounts.filter(a => a.allowed)
  const vals = allowed.flatMap(a => {
    const u = a.usage?.[key]?.utilization
    return typeof u === 'number' ? [u] : []
  })
  return {
    pct: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : undefined,
    reporting: vals.length,
    total: allowed.length,
  }
}

export type BarSegment = { kind: 'active' | 'pool' | 'empty'; len: number }

/** Overlay bar: cells up to the lower value take its colour, up to the higher value the higher one's, then empty. Equal values draw as active. */
export const twoToneBar = (activePct: number, poolPct: number | undefined, width: number): BarSegment[] => {
  const a = cells(activePct, width)
  const p = poolPct === undefined ? 0 : cells(poolPct, width)
  const [lo, hi] = a <= p ? (['active', 'pool'] as const) : (['pool', 'active'] as const)
  const segs: BarSegment[] = [
    { kind: lo, len: Math.min(a, p) },
    { kind: hi, len: Math.abs(a - p) },
    { kind: 'empty', len: width - Math.max(a, p) },
  ]
  return segs.filter(s => s.len > 0)
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** Window rows a band can show; codex plans report `week` or `month`. */
export type RowName = 'session' | 'week' | 'month'
const ROW_NAMES: readonly RowName[] = ['session', 'week', 'month']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Reset moment as `HH:MM` (session) or `Mon D` (week); raw text when unparseable. */
export const resetLabel = (at: string | number | undefined, kind: RowName): string => {
  if (at === undefined || at === '') return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return String(at)
  return kind === 'session' ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export type BandRow = {
  name: RowName
  active: number
  resets: string
  /** Pool case only. */
  pool?: { pct: number | undefined; reporting: number; total: number }
}

/** Rows for the band above the prompt, or [] when there is nothing to show. */
export const bandRows = (r: Resolved, status: SwapStatus | null, limits: LimitsEntry[] | null): BandRow[] => {
  if (!r.current) return []
  const out: BandRow[] = []
  if (r.kind === 'pool') {
    const accounts = status?.accounts ?? []
    for (const [name, key] of [['session', 'fiveHour'], ['week', 'sevenDay']] as const) {
      const w = memberWindow(status, limits, r.current, key)
      if (!w) continue
      // Members without usage in status (it is fetched without usage to spare the endpoint) report from limits.
      const synth = accounts.map(a => {
        const m = memberWindow(status, limits, a.name, key)
        return { ...a, usage: m ? { [key]: { utilization: m.pct } } : undefined } as SwapAccount
      })
      out.push({ name, active: w.pct, resets: resetLabel(w.resetsAt, name), pool: poolWindowPct(synth, key) })
    }
  } else {
    const e = entriesFor(limits, r.current).find(l => l.toolName === 'claude')
    for (const name of ['session', 'week'] as const) {
      const w = e && pick(e.windows, name)
      if (w) out.push({ name, active: w.usedPercent, resets: resetLabel(w.resetsAtMs ?? w.resetsAt, name) })
    }
  }
  return out
}

/** Plain texts of one row: pool text, current text, label, and the non-bar tail (resets, reporting). */
export function rowText(r: Resolved, row: BandRow) {
  const pool = row.pool
  const left = pool?.pct === undefined ? undefined : Math.max(0, 100 - Math.round(pool.pct))
  const poolText = pool ? (pool.pct === undefined ? 'pool n/a' : `pool ${pct(pool.pct)} used, ${left}% left`) : ''
  const curText = pool ? `${r.current} ${pct(row.active)}` : pct(row.active)
  const labelLen = pool ? poolText.length + 5 + curText.length : curText.length
  const resets = row.resets ? `  resets ${row.resets}` : ''
  const reporting = pool && pool.reporting < pool.total ? ` (${pool.reporting}/${pool.total} reporting)` : ''
  return { pool, poolText, curText, labelLen, resets, reporting }
}

export const NAME_COL = 8
const MARGIN = 3 // safety so a row never wraps

/** Bar width shared by every row: the columns left after the longest row's non-bar text. */
export function barWidth(r: Resolved, rows: BandRow[], cols: number): number {
  const fixed = Math.max(
    ...rows.map(row => {
      const t = rowText(r, row)
      return NAME_COL + 2 + 1 + t.labelLen + t.resets.length + t.reporting.length
    }),
  )
  return Math.max(10, cols - MARGIN - fixed)
}

/** Longest label among `rows`; shorter ones are right-padded to it. */
export const labelPad = (r: Resolved, rows: BandRow[]): number =>
  Math.max(...rows.map(row => rowText(r, row).labelLen))

export type Seg = { text: string; color?: Tone | 'blue' | 'cyan' | 'gray'; dim?: boolean }

/** One band row as coloured segments; `width` is the bar width, `pad` the longest label. */
export function rowSegments(r: Resolved, row: BandRow, width: number, pad = 0): Seg[] {
  const t = rowText(r, row)
  const pool = t.pool
  const body: Seg[] = pool
    ? twoToneBar(row.active, pool.pct, width).map(s => ({
        text: '\u2588'.repeat(s.len),
        color: ({ active: 'cyan', pool: 'blue', empty: 'gray' } as const)[s.kind],
      }))
    : [
        { text: bar(row.active, width)[0], color: tone(row.active) },
        { text: bar(row.active, width)[1], color: 'gray' },
      ]
  const label: Seg[] = pool
    ? [
        { text: t.poolText, color: tone(pool.pct ?? 0) },
        { text: '  |  ' },
        { text: t.curText, color: tone(row.active) },
      ]
    : [{ text: t.curText, color: tone(row.active) }]
  return [
    { text: row.name.padEnd(NAME_COL) + '[' },
    ...body,
    { text: '] ' },
    ...label,
    { text: ' '.repeat(Math.max(0, pad - t.labelLen)) },
    { text: t.resets, dim: true },
    { text: t.reporting, dim: true },
  ].filter(g => g.text)
}

export type ProviderBlock = { tool: string; rows: BandRow[] }

/** Per non-claude tool of the pool (or of the current identity): session and week rows; no rows when it reports no windows. */
export const providerBlocks = (limits: LimitsEntry[] | null, r: Resolved): ProviderBlock[] => {
  const all = limits ?? []
  const tools = [...new Set(all.map(l => l.toolName))].filter(t => t !== 'claude').sort()
  const out: ProviderBlock[] = []
  for (const tool of tools) {
    const ofTool = all.filter(l => l.toolName === tool)
    const members = r.pool ? ofTool.filter(l => !l.identity.swapPool && r.members?.includes(l.identity.name)) : []
    // A pool entry of this tool mirrors its own active member (empty windows); take that member's windows.
    const mirror = ofTool.find(l => l.identity.swapPool && l.identity.name === r.pool)?.identity.swapPool?.active
    const act = r.pool
      ? (members.find(l => l.identity.name === r.current) ??
        members.find(l => l.identity.name === mirror) ??
        ofTool.find(l => l.identity.name === r.pool))
      : ofTool.find(l => l.identity.name === r.current && !l.identity.swapPool)
    if (!act && !members.length) continue
    const rows: BandRow[] = []
    for (const name of ROW_NAMES) {
      const w = act && pick(act.windows, name)
      if (!w) continue
      const vals = members.flatMap(l => pick(l.windows, name)?.usedPercent ?? [])
      rows.push({
        name,
        active: w.usedPercent,
        resets: resetLabel(w.resetsAtMs ?? w.resetsAt, name),
        pool: r.pool
          ? { pct: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined, reporting: vals.length, total: members.length }
          : undefined,
      })
    }
    out.push({ tool, rows })
  }
  return out
}

/** Notice text when the pool's active member changed since `prev`; none on first sight or no change. */
export const switchNotice = (prev: string, status: SwapStatus | null): string | undefined =>
  status && prev && prev !== status.active
    ? `AIS pool ${status.pool} switched account from ${prev} to ${status.active} since your last turn; limits shown now refer to ${status.active}.`
    : undefined

export type MemberBlock = { tool: string; members: { name: string; rows: BandRow[] }[] }

const memberBand = (name: RowName, pctUsed: number, at: string | number | undefined): BandRow => ({
  name,
  active: pctUsed,
  resets: resetLabel(at, name),
})

/** Pool case: per tool (claude first, then the other providers), each member's own session and week rows; a member without windows has no rows. */
export const memberBlocks = (status: SwapStatus | null, limits: LimitsEntry[] | null, r: Resolved): MemberBlock[] => {
  const claude = (status?.accounts ?? []).map(a => ({
    name: a.name,
    rows: ([['session', 'fiveHour'], ['week', 'sevenDay']] as const).flatMap(([n, k]) => {
      const w = memberWindow(status, limits, a.name, k)
      return w ? [memberBand(n, w.pct, w.resetsAt)] : []
    }),
  }))
  const out: MemberBlock[] = claude.length ? [{ tool: 'claude', members: claude }] : []
  for (const g of poolProviders(limits, r)) {
    const names = [...new Set(g.rows.map(l => l.identity.name))]
    out.push({
      tool: g.tool,
      members: names.map(name => ({
        name,
        rows: ROW_NAMES.flatMap(n => {
          const w = g.rows.filter(l => l.identity.name === name).map(l => pick(l.windows, n)).find(Boolean)
          return w ? [memberBand(n, w.usedPercent, w.resetsAtMs ?? w.resetsAt)] : []
        }),
      })),
    })
  }
  return out
}

export type Snapshot = {
  othersOpen: boolean
  membersOpen: boolean
  limits: LimitsEntry[] | null
  status: SwapStatus | null
  updatedAt: number
}

/** Snapshot file name for an identity: the CLAUDE_CONFIG_DIR basename, sanitised. */
export const snapshotName = (configDir: string | undefined): string => {
  const base = norm(configDir ?? '').split('/').pop() ?? ''
  return `${base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'default'}.json`
}

/** Where the mod writes the snapshot `ais statusline` reads. */
export const snapshotPath = (home: string, configDir: string | undefined): string =>
  `${norm(home)}/.ais/cache/ais-usage/${snapshotName(configDir)}`
