import { expect, test } from 'claude-code/testing'

import { bar, bandRows, poolWindowPct, twoToneBar, poolProviders, humanise, resolveCurrent, shares, statusLine, switchNotice, others, entriesFor } from './model'
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
  expect(statusLine(r, swap, limits)).toBe('workco-team > workco 5h 4% wk 1%')
  const g = poolProviders(limits, r)
  const names = (t: string) => g.find(x => x.tool === t)!.rows.map(l => l.identity.name).sort()
  expect(names('codex')).toEqual(['acme', 'personal', 'studioco', 'workco'])
  expect(names('kimi')).toEqual(['acme', 'personal'])
  expect(others(limits, [r.pool, r.current, ...(r.members ?? [])]).map(o => o.name)).toEqual(['outsider', 'retailco'].sort())
})

test('non-pool and unknown', async () => {
  const r = resolveCurrent(limits, '/c/acme', null)
  expect(r.kind).toBe('identity')
  expect(statusLine(r, null, limits)).toBe('acme 5h 4% wk 1%')
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
