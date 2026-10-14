import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LimitsEntry, SwapStatus, SwapUsage } from '../types'
import {
  bandRows,
  bar,
  entriesFor,
  humanise,
  memberWindow,
  others,
  parseJson,
  poolProviders,
  pct,
  resolveCurrent,
  shares,
  shortError,
  statusLine,
  tone,
  totals,
  twoToneBar,
} from './model'

const PANE = 'ais-usage'

const status = atom({ plugin: 'ais-usage', key: 'status' } as const, null)
const usage = atom({ plugin: 'ais-usage', key: 'usage' } as const, null)
const limits = atom({ plugin: 'ais-usage', key: 'limits' } as const, null)
const expanded = atom({ plugin: 'ais-usage', key: 'expanded' } as const, [])
const updatedAt = atom({ plugin: 'ais-usage', key: 'updatedAt' } as const, 0)
const loading = atom({ plugin: 'ais-usage', key: 'loading' } as const, 0)
const errors = atom({ plugin: 'ais-usage', key: 'errors' } as const, [])

const pad2 = (n: number) => String(n).padStart(2, '0')

export const register: Register = on => {
  let isLimitsBusy = false
  // Set by session.start; the command and the Refresh button call it.
  let refreshHandle: (() => Promise<void>) | undefined

  on('session.start', async ($, e, next) => {
    const run = async (args: string[], timeoutMs: number) => {
      try {
        return await $.process.run(['ais', ...args], { timeoutMs })
      } catch {
        return await $.process.run([`${(await $.env.get('HOME')) ?? ''}/.local/bin/ais`, ...args], { timeoutMs })
      }
    }

    const fetchJson = async <T,>(src: string, args: string[], timeoutMs: number) => {
      await update($, loading, n => n + 1)
      let value: T | undefined
      let err = ''
      try {
        const r = await run(args, timeoutMs)
        value = parseJson<T>(r.stdout)
        if (value === undefined) err = `exit ${r.exitCode}: ${shortError(r.stderr || r.stdout, 80)}`
      } catch (x) {
        err = shortError(String((x as Error)?.message ?? x), 80)
      }
      await update($, errors, list => [
        ...list.filter(s => !s.startsWith(`${src}:`)),
        ...(err ? [`${src}: ${err}`] : []),
      ])
      await update($, loading, n => n - 1)
      if (value !== undefined) await update($, updatedAt, () => Date.now())
      return value
    }

    const refreshStatusLine = async () => {
      const r = resolveCurrent(
        await read($, limits),
        await $.env.get('CLAUDE_CONFIG_DIR'),
        await read($, status),
      )
      await $.ui.status(statusLine(r, await read($, status), await read($, limits)))
    }

    const refreshStatus = async () => {
      const v = await fetchJson<SwapStatus>('status', ['claude-swap', 'status', '--json', '--no-usage'], 20000)
      if (v) await update($, status, () => v)
      await refreshStatusLine()
    }
    const refreshUsage = async () => {
      const v = await fetchJson<SwapUsage>('usage', ['claude-swap', 'usage', '--json'], 20000)
      if (v) await update($, usage, () => v)
    }
    const refreshLimits = async () => {
      if (isLimitsBusy) return
      isLimitsBusy = true
      try {
        const v = await fetchJson<LimitsEntry[]>('limits', ['limits', '--json'], 60000)
        if (Array.isArray(v)) await update($, limits, () => v)
        await refreshStatusLine()
      } finally {
        isLimitsBusy = false
      }
    }
    // Limits first: it resolves the identity that the status line needs.
    const refreshAll = async () => {
      await Promise.all([refreshLimits(), refreshStatus(), refreshUsage()])
    }

    await $.command.register({
      name: 'ais-usage',
      description: 'Show AIS pool and identity usage',
    })
    void refreshAll()
    $.clock.every(60_000, () => void refreshStatus())
    $.clock.every(600_000, () => void refreshUsage())
    $.clock.every(300_000, () => void refreshLimits())
    refreshHandle = refreshAll

    return next(e)
  })

  on('command.run', { command: 'ais-usage' }, async $ => {
    await $.ui.open({ id: PANE, title: 'AIS usage' })
    void refreshHandle?.()

    return { text: 'AIS usage pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const st = await read($, status)
    const lim = await read($, limits)
    const r = resolveCurrent(lim, await $.env.get('CLAUDE_CONFIG_DIR'), st)
    const rows = bandRows(r, st, lim)
    if (e.props.hasSurvey || !rows.length) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const fill = { active: 'cyan', pool: 'blue', marker: 'white', empty: undefined } as const
    const glyph = { active: '\u2588', pool: '\u2588', marker: '|', empty: '\u2591' } as const

    return (
      <Box flexDirection="column">
        {r.pool && (
          <Text dimColor>
            {r.pool} &gt; {r.current}
          </Text>
        )}
        {rows.map(row => {
          const pool = row.pool
          const left = pool?.pct === undefined ? undefined : Math.max(0, 100 - Math.round(pool.pct))
          const label = pool
            ? `${pool.pct === undefined ? 'pool n/a' : `pool ${pct(pool.pct)} used, ${left}% left`}  |  ${r.current} ${pct(row.active)}`
            : pct(row.active)
          const width = Math.min(40, Math.max(10, cols - 12 - label.length - (row.resets.length + 9) - (pool ? 16 : 0)))
          return (
            <Text key={row.name}>
              {row.name.padEnd(8)}[
              {pool ? (
                twoToneBar(row.active, pool.pct, width).map((s, i) => (
                  <Text key={i} color={fill[s.kind]} dimColor={s.kind === 'empty'}>
                    {glyph[s.kind].repeat(s.len)}
                  </Text>
                ))
              ) : (
                <Text color={tone(row.active)}>{bar(row.active, width)}</Text>
              )}
              ]{' '}
              {pool ? (
                <Text>
                  <Text color={tone(pool.pct ?? 0)}>{label.split('  |  ')[0]}</Text>  |  <Text color={tone(row.active)}>{r.current} {pct(row.active)}</Text>
                </Text>
              ) : (
                <Text color={tone(row.active)}>{label}</Text>
              )}
              {row.resets ? <Text dimColor>  resets {row.resets}</Text> : null}
              {pool && pool.reporting < pool.total ? <Text dimColor> ({pool.reporting}/{pool.total} reporting)</Text> : null}
            </Text>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const st = await read($, status)
    const us = await read($, usage)
    const lim = await read($, limits)
    const open = await read($, expanded)
    const errs = await read($, errors)
    const busy = (await read($, loading)) > 0
    const at = await read($, updatedAt)
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    const r = resolveCurrent(lim, dir, st)

    const P = ({ v }: { v: number | undefined }) => <Text color={tone(v ?? 0)}>{pct(v)}</Text>

    const rows = (entries: LimitsEntry[], withName = false) =>
      entries.map(l =>
        l.status === 'live' && l.windows.length ? (
          <Text key={`${l.toolName}-${l.identity.name}`}>
            {(withName ? `${l.identity.name === r.current ? '*' : ' '} ${l.identity.name}` : l.toolName).padEnd(withName ? 20 : 8)}
            {l.windows.map(w => (
              <Text>
                {' '}
                {w.label} <Text color={tone(w.usedPercent)}>{pct(w.usedPercent)}</Text>
                {w.resetsAt ? <Text dimColor> (resets {w.resetsAt})</Text> : null}
                {'  '}
              </Text>
            ))}
          </Text>
        ) : (
          <Text key={`${l.toolName}-${l.identity.name}`} dimColor>
            {(withName ? `${l.identity.name === r.current ? '*' : ' '} ${l.identity.name}` : l.toolName).padEnd(withName ? 20 : 8)} {l.status} {shortError(l.error)}
          </Text>
        ),
      )

    const share = shares(us)
    const msgs = new Map((us?.members ?? []).map(m => [m.member, m.messages]))
    const tot = totals(us)

    const sections = (
      <Box flexDirection="column">
        {r.kind === 'unknown' && (
          <Text color="yellow">unknown identity ({r.configDir || 'CLAUDE_CONFIG_DIR unset'})</Text>
        )}
        {r.kind === 'pool' && st && (
          <Box flexDirection="column">
            <Text bold>
              Pool {r.pool}  active: {st.active}  auto: {st.auto ? 'on' : 'off'} @
              {st.thresholdPercent}%
            </Text>
            {st.accounts.map(a => (
              <Text key={a.name} dimColor={!a.allowed}>
                {a.active ? '*' : ' '} {a.name.padEnd(18)} 5h{' '}
                <P v={memberWindow(st, lim, a.name, 'fiveHour')?.pct} /> wk <P v={memberWindow(st, lim, a.name, 'sevenDay')?.pct} />
                {'  '}30d share {pct(share[a.name])} ({humanise(msgs.get(a.name) ?? 0)} msgs)
              </Text>
            ))}
            <Text dimColor>
              30d total: {humanise(tot.messages)} messages, {humanise(tot.output)} output tokens
            </Text>
          </Box>
        )}
        {r.kind === 'pool' ? (
          <Box flexDirection="column">
            <Text bold>Same pool, other providers</Text>
            {poolProviders(lim, r).map(g => (
              <Box key={`g-${g.tool}`} flexDirection="column">
                <Text bold>{g.tool}</Text>
                {rows(g.rows, true)}
              </Box>
            ))}
          </Box>
        ) : (
          r.current && (
            <Box flexDirection="column">
              <Text bold>This identity: {r.current}</Text>
              {rows(entriesFor(lim, r.current))}
            </Box>
          )
        )}
        <Text bold>Other identities</Text>
        {others(lim, [r.pool, r.current, ...(r.members ?? [])]).map(o => {
          const isOpen = open.includes(o.name)
          return (
            <Box key={`o-${o.name}`} flexDirection="column">
              <Button
                key={`b-${o.name}`}
                onPress={() =>
                  update($, expanded, list =>
                    list.includes(o.name) ? list.filter(n => n !== o.name) : [...list, o.name],
                  )
                }
              >
                {isOpen ? '▾' : '▸'} {o.name}{'  '}
                <Text dimColor>
                  ({o.entries.length} tools, max <Text color={tone(o.max)}>{pct(o.max)}</Text>)
                </Text>
              </Button>
              {isOpen && rows(o.entries)}
            </Box>
          )
        })}
        {errs.map(s => (
          <Text dimColor>{shortError(s, 100)}</Text>
        ))}
        <Box>
          <Text dimColor>
            {busy && !lim ? 'loading...' : at ? `updated ${clock(at)}` : ''}{'  '}
          </Text>
          <Button key="refresh" onPress={() => void refreshHandle?.()}>
            Refresh
          </Button>
        </Box>
      </Box>
    )

    return sections
  })
}

const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
