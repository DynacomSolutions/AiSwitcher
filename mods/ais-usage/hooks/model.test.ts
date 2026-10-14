import { expect, test } from 'claude-code/testing'

import { poolProviders, humanise, resolveCurrent, shares, statusLine, others, entriesFor } from './model'
import type { LimitsEntry, SwapStatus, SwapUsage } from '../types'

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
