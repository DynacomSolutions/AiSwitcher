import { expect, test } from 'claude-code/testing'

import { snapshotName, bar, bandRows, poolWindowPct, twoToneBar, poolProviders, humanise, resolveCurrent, shares, switchNotice, others, entriesFor, providerBlocks, memberBlocks, memberCards, resetLabel, rowText, stamp } from './model'
import type { LimitsEntry, SwapAccount, SwapStatus, SwapUsage } from '../types'

const live = (tool: string, name: string, dir: string, pool = false): LimitsEntry => ({
  toolName: tool,
  identity: {
    name,
    configDir: dir,
    ...(pool ? { swapPool: { active: 'workco', accounts: ['workco', 'personal', 'acme', 'studioco'] } } : {}),
  },
  windows: [
    { label: 'session (5h)', category: 'session', usedPercent: 4 },
    { label: 'week (all)', category: 'week', usedPercent: 1 },
  ],
  status: 'live',
})

const limits = [
  live('claude', 'workco', '/c/workco'),
  live('claude', 'workco-team', '/c/swap', true),
  live('codex', 'workco', '/x/workco'),
  live('claude', 'acme', '/c/acme'),
  live('claude', 'outsider', '/c/outsider'),
  live('codex', 'personal', '/x/p'),
  live('codex', 'acme', '/x/d'),
  live('codex', 'studioco', '/x/z'),
  live('codex', 'retailco', '/x/m'),
  live('kimi', 'acme', '/k/d'),
  live('kimi', 'personal', '/k/p'),
]
const swap = { active: 'workco', accounts: [{ name: 'workco', active: true, allowed: true,
  usage: { fiveHour: { utilization: 4 }, sevenDay: { utilization: 1 } } }] } as unknown as SwapStatus

test('pool resolution', async () => {
  const r = resolveCurrent(limits, '/c/swap/', swap)
  expect(r.kind).toBe('pool')
  expect(r.pool).toBe('workco-team')
  expect(r.current).toBe('workco')
  expect(entriesFor(limits, 'workco').map(l => l.toolName)).toContain('codex')
  const g = poolProviders(limits, r)
  const names = (t: string) => g.find(x => x.tool === t)!.rows.map(l => l.identity.name).sort()
  expect(names('codex')).toEqual(['acme', 'personal', 'studioco', 'workco'])
  expect(names('kimi')).toEqual(['acme', 'personal'])
  expect(others(limits, [r.pool, r.current, ...(r.members ?? [])]).map(o => o.name)).toEqual(['outsider', 'retailco'].sort())
})

test('non-pool and unknown', async () => {
  const r = resolveCurrent(limits, '/c/acme', null)
  expect(r.kind).toBe('identity')
  expect(resolveCurrent(limits, '/nope', null).kind).toBe('unknown')
})

test('shares sum to 100 and humanise', async () => {
  const u = { pool: 'p', days: 30, members: [
    { member: 'a', messages: 1, input: 0, output: 300 },
    { member: 'b', messages: 2, input: 0, output: 700 },
  ] } as SwapUsage
  const total = Object.values(shares(u)).reduce((s, v) => s + v, 0)
  expect(Math.round(total)).toBe(100)
  expect(humanise(950)).toBe('950')
  expect(humanise(9760032)).toBe('9.8M')
  expect(humanise(2_500_000_000)).toBe('2.5B')
  expect(humanise(12_300)).toBe('12.3k')
})

test('bar', async () => {
  expect(bar(42, 20)).toEqual(['\u2588'.repeat(8), '\u2588'.repeat(12)])
  expect(bar(0, 10)).toEqual(['', '\u2588'.repeat(10)])
  expect(bar(150, 10)).toEqual(['\u2588'.repeat(10), ''])
})

const acc = (name: string, five: number | undefined, allowed = true) =>
  ({ name, active: false, allowed, usage: five === undefined ? undefined : { fiveHour: { utilization: five } } }) as SwapAccount

test('poolWindowPct', async () => {
  const r = poolWindowPct([acc('a', 10), acc('b', 30), acc('c', undefined), acc('d', 90, false)], 'fiveHour')
  expect(r).toEqual({ pct: 20, reporting: 2, total: 3 })
  expect(poolWindowPct([acc('a', undefined)], 'fiveHour').pct).toBeUndefined()
  expect(poolWindowPct([acc('a', 50, false)], 'fiveHour')).toEqual({ pct: undefined, reporting: 0, total: 0 })
})

test('twoToneBar', async () => {
  const sum = (s: { len: number }[]) => s.reduce((n, x) => n + x.len, 0)
  expect(twoToneBar(10, 50, 20)).toEqual([
    { kind: 'active', len: 2 }, { kind: 'pool', len: 8 }, { kind: 'empty', len: 10 },
  ])
  expect(twoToneBar(50, 50, 20)).toEqual([{ kind: 'active', len: 10 }, { kind: 'empty', len: 10 }])
  const over = twoToneBar(80, 50, 20)
  expect(over).toEqual([{ kind: 'pool', len: 10 }, { kind: 'active', len: 6 }, { kind: 'empty', len: 4 }])
  expect(sum(over)).toBe(20)
  expect(twoToneBar(25, undefined, 20)).toEqual([{ kind: 'active', len: 5 }, { kind: 'empty', len: 15 }])
  expect(twoToneBar(0, 0, 10)).toEqual([{ kind: 'empty', len: 10 }])
})

test('bandRows', async () => {
  const st = { active: 'workco', accounts: [
    { name: 'workco', active: true, allowed: true, usage: { fiveHour: { utilization: 4 }, sevenDay: { utilization: 1 } } },
    acc('personal', 20),
  ] } as unknown as SwapStatus
  const rp = bandRows(resolveCurrent(limits, '/c/swap', st), st, limits)
  expect(rp.map(x => x.name)).toEqual(['session', 'week'])
  expect(rp[0]!.pool).toEqual({ pct: 12, reporting: 2, total: 2 })
  const bare = { active: 'workco', accounts: ['workco', 'personal'].map(name => ({ name, active: name === 'workco', allowed: true })) } as unknown as SwapStatus
  const rb = bandRows(resolveCurrent(limits, '/c/swap', bare), bare, limits)
  expect(rb[0]!.active).toBe(4)
  expect(rb[0]!.pool?.pct).toBeDefined()
  const ri = bandRows(resolveCurrent(limits, '/c/acme', null), null, limits)
  expect(ri.map(x => [x.name, x.active])).toEqual([['session', 4], ['week', 1]])
  expect(bandRows(resolveCurrent(limits, '/nope', null), null, limits)).toEqual([])
})

test('bandRows accepts cached member limits', async () => {
  const cached = limits.map(l => (l.toolName === 'claude' && !l.identity.swapPool ? { ...l, status: 'cached' } : l)) as LimitsEntry[]
  const rows = bandRows(resolveCurrent(cached, '/c/swap', null), null, cached)
  expect(rows.map(x => x.name)).toEqual(['session', 'week'])
  expect(rows[0]!.active).toBe(4)
})

test('switchNotice: first observation, no change, change', () => {
  const st = { pool: 'p', active: 'b', auto: true, thresholdPercent: 90, accounts: [] } as SwapStatus
  expect(switchNotice('', st)).toBeUndefined()
  expect(switchNotice('b', st)).toBeUndefined()
  expect(switchNotice('a', null)).toBeUndefined()
  expect(switchNotice('a', st)).toBe(
    'AIS pool p switched account from a to b since your last turn; limits shown now refer to b.',
  )
})

test('providerBlocks: session and week per tool, none for unknown identity', () => {
  const acme = resolveCurrent(limits, '/c/acme', null)
  expect(providerBlocks(limits, acme).map(g => [g.tool, g.rows.map(x => x.name)])).toEqual([
    ['codex', ['session', 'week']],
    ['kimi', ['session', 'week']],
  ])
  expect(providerBlocks(limits, resolveCurrent(limits, '/nope', null))).toEqual([])
})

test('memberBlocks: only the current pool members of claude, in pool order, no other tool', () => {
  const r = resolveCurrent(limits, '/c/swap', swap)
  const bs = memberBlocks(swap, limits, r)
  expect(bs.map(b => b.tool)).toEqual(['claude'])
  expect(bs[0].members.map(m => m.name)).toEqual(r.members)
  expect(memberBlocks(null, limits, r).map(b => b.tool)).toEqual(['claude'])
})

test('providerBlocks: codex pool totals aggregate week and month over members', () => {
  const cx = (name: string, category: string, usedPercent: number, resetsAtMs: number): LimitsEntry => ({
    toolName: 'codex',
    identity: { name, configDir: `/x/${name}` },
    windows: [{ label: category, category, usedPercent, resetsAtMs }],
    status: 'live',
  })
  const members = ['alpha', 'personal', 'beta', 'gamma', 'outsider']
  const lim: LimitsEntry[] = [
    live('claude', 'big-pool', '/c/bigpool', true),
    cx('alpha', 'week', 10, 1792652277000),
    cx('personal', 'week', 30, 1792552277000),
    cx('beta', 'month', 32, 1792652277000),
    cx('gamma', 'month', 0, 1792652277000),
    cx('stranger', 'week', 99, 1792652277000),
    {
      toolName: 'codex',
      identity: { name: 'big-pool', configDir: '/x/pool', swapPool: { accounts: members.slice(0, 4), active: 'gamma' } },
      windows: [],
      status: 'unavailable',
    },
  ]
  const r = resolveCurrent(lim, '/c/bigpool', null)
  const codex = providerBlocks(lim, r).find(g => g.tool === 'codex')!
  expect(codex.rows.map(x => [x.name, x.active])).toEqual([['week', 20], ['month', 16]])
  expect(codex.rows[0]!.resets).toBe(resetLabel(1792552277000, 'week'))
  // No same-named pool on the other tool: no block.
  expect(providerBlocks(lim.filter(l => !l.identity.swapPool || l.toolName === 'claude'), r)).toEqual([])
})

test('memberCards: k per row, equal widths filling the width, never over width', () => {
  const row = (name: 'session' | 'week', active: number) => ({ name, active, resets: 'Oct 17' })
  const blocks = [{ tool: 'claude', members: ['a', 'b', 'c', 'd', 'e', 'f'].map(n => ({ name: n, rows: [row('session', 40), row('week', 100)] })) }]
  const text = (cols: number) => memberCards(blocks, cols)[0]!.map(l => l.map(g => g.text).join(''))
  const wide = text(160) // k = floor(163 / 37) = 4, card = floor(151 / 4) = 37
  expect(wide).toHaveLength(2 * 3)
  expect(wide[1]!.length).toBe(4 * 37 + 3 * 3)
  expect(wide[0]!.match(/[a-f]/g)).toHaveLength(4)
  expect(wide[4]!.length).toBe(2 * 37 + 3) // last row keeps the card width
  const narrow = text(60)
  expect(narrow).toHaveLength(6 * 3)
  expect(narrow[1]!.length).toBe(60)
  for (const c of [160, 60, 30]) for (const l of text(c)) expect(l.length).toBeLessThanOrEqual(c)
})

const withExtra = (xs: Record<string, { enabled: boolean; usedPercent?: number }>) =>
  limits.map(l => {
    const x = l.toolName === 'claude' && !l.identity.swapPool ? xs[l.identity.name] : undefined
    return x ? { ...l, extraUsage: { available: true, label: 'x', ...x } } : l
  })

test('extra row: absent unless a member has extra usage enabled', () => {
  const r = resolveCurrent(limits, '/c/swap', swap)
  expect(bandRows(r, swap, limits).map(b => b.name)).toEqual(['session', 'week'])
  expect(bandRows(r, swap, withExtra({ workco: { enabled: false } })).map(b => b.name)).toEqual(['session', 'week'])
})

test('extra row: pool mean over enabled members, off label when current is not enabled', () => {
  const lims = withExtra({ acme: { enabled: true, usedPercent: 40 }, workco: { enabled: true, usedPercent: 20 } })
  const r = resolveCurrent(lims, '/c/swap', swap)
  const row = bandRows(r, swap, lims).find(b => b.name === 'extra')!
  expect(row.active).toBe(20)
  expect(row.pool).toEqual({ pct: 30, reporting: 2, total: 2 })
  expect(rowText(r, row).curText).toBe('workco 20%')
  const lims2 = withExtra({ acme: { enabled: true, usedPercent: 40 } })
  const row2 = bandRows(resolveCurrent(lims2, '/c/swap', swap), swap, lims2).find(b => b.name === 'extra')!
  expect(row2.active).toBe(0)
  expect(rowText(resolveCurrent(lims2, '/c/swap', swap), row2).curText).toBe('workco off')
})

test('extra row: single identity only when enabled; member cards list it', () => {
  const lims = withExtra({ acme: { enabled: true, usedPercent: 7 } })
  const row = bandRows(resolveCurrent(lims, '/c/acme', null), null, lims).find(b => b.name === 'extra')
  expect(row).toMatchObject({ active: 7, resets: '' })
  expect(bandRows(resolveCurrent(limits, '/c/acme', null), null, limits).map(b => b.name)).toEqual(['session', 'week'])
  const r = resolveCurrent(lims, '/c/swap', swap)
  const acme = memberBlocks(swap, lims, r)[0]!.members.find(m => m.name === 'acme')!
  expect(acme.rows.map(x => x.name)).toEqual(['session', 'week', 'extra'])
})

test('snapshotName: per identity, plus the sanitised session id when given', () => {
  expect(snapshotName('/c/swap')).toBe('swap.json')
  expect(snapshotName('/c/swap', 'abc-123')).toBe('swap.abc-123.json')
  expect(snapshotName('/c/swap', '../x/y')).toBe('swap.__x_y.json')
  expect(snapshotName('/c/swap', '')).toBe('swap.json')
})

test('stamp shows the time today and the date otherwise', () => {
  const now = new Date(2026, 9, 31, 15, 0).getTime()
  expect(stamp(new Date(2026, 9, 31, 9, 5).getTime(), now)).toBe('09:05')
  expect(stamp(new Date(2026, 9, 30, 23, 59).getTime(), now)).toBe('2026-10-30 23:59')
})
