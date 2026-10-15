import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LimitsEntry, SwapStatus, SwapUsage } from '../types'
import {
  bandRows,
  entriesFor,
  humanise,
  memberWindow,
  others,
  parseJson,
  poolProviders,
  snapshotPath,
  pct,
  resolveCurrent,
  shares,
  shortError,
  switchNotice,
  tone,
  totals,
} from './model'

const PANE = 'ais-usage'

const status = atom({ plugin: 'ais-usage', key: 'status' } as const, null)
const usage = atom({ plugin: 'ais-usage', key: 'usage' } as const, null)
const limits = atom({ plugin: 'ais-usage', key: 'limits' } as const, null)
const expanded = atom({ plugin: 'ais-usage', key: 'expanded' } as const, [])
const othersOpen = atom({ plugin: 'ais-usage', key: 'othersOpen' } as const, false)
const membersOpen = atom({ plugin: 'ais-usage', key: 'membersOpen' } as const, false)
const updatedAt = atom({ plugin: 'ais-usage', key: 'updatedAt' } as const, 0)
const loading = atom({ plugin: 'ais-usage', key: 'loading' } as const, 0)
const errors = atom({ plugin: 'ais-usage', key: 'errors' } as const, [])

// Last pool member seen at a prompt; '' until the first prompt.
const lastMember = atom({ plugin: 'ais-usage', key: 'lastMember' } as const, '')

/**
 * Shares toggles and data with `ais statusline`, which draws the expanded blocks.
 * shortcut: the file is per identity (CLAUDE_CONFIG_DIR), not per session, so two sessions on one identity share toggles
 * and last writer wins; $.fs has no rename, so the write is not atomic and the reader ignores a torn file.
 * Upgrade to a per-session key if that bites.
 */
const writeSnapshot = async ($: any) => {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const path = snapshotPath(home, await $.env.get('CLAUDE_CONFIG_DIR'))
    await $.fs.write(
      path,
      JSON.stringify({
        othersOpen: await read($, othersOpen),
        membersOpen: await read($, membersOpen),
        limits: await read($, limits),
        status: await read($, status),
        updatedAt: Date.now(),
      }),
    )
  } catch {
    // The status line is optional; a failed write must never break the mod.
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export const register: Register = on => {
  let isLimitsBusy = false
  // Set by session.start; the command and the Refresh button call it.
  let refreshHandle: (() => Promise<void>) | undefined

  on('session.start', async ($, e, next) => {
    // Clears a status left by an older loaded version after /reload-plugins.
    $.ui.status(undefined)

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

    const refreshStatus = async () => {
      const v = await fetchJson<SwapStatus>('status', ['claude-swap', 'status', '--json', '--no-usage'], 20000)
      if (v) {
        await update($, status, () => v)
        await writeSnapshot($)
      }
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
        if (Array.isArray(v)) {
          await update($, limits, () => v)
          await writeSnapshot($)
        }
      } finally {
        isLimitsBusy = false
      }
    }
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

  on('prompt.submit', async ($, e, next) => {
    const st = await read($, status)
    const notice = switchNotice(await read($, lastMember), st)
    if (st) await update($, lastMember, () => st.active)
    if (!notice) return next(e)
    $.ui.toast(notice)
    return next({ ...e, context: [...(e.context ?? []), notice] })
  })

  on('command.run', { command: 'ais-usage' }, async $ => {
    await $.ui.open({ id: PANE, title: 'AIS usage' })
    void refreshHandle?.()

    return { text: 'AIS usage pane opened.' }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const st = await read($, status)
    const lim = await read($, limits)
    const r = resolveCurrent(lim, await $.env.get('CLAUDE_CONFIG_DIR'), st)
    if (!lim || !bandRows(r, st, lim).length) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    const isOthers = await read($, othersOpen)
    const isMembers = await read($, membersOpen)

    return (
      <Box flexDirection="column" alignSelf="flex-start">
        <Box flexDirection="row">
          <Button key="others" plain onPress={async () => {
              await update($, othersOpen, v => !v)
              await writeSnapshot($)
            }}>
            {isOthers ? '▾' : '▸'} Other providers
          </Button>
          {r.kind === 'pool' && <Text>{'  '}</Text>}
          {r.kind === 'pool' && (
            <Button key="members" plain onPress={async () => {
              await update($, membersOpen, v => !v)
              await writeSnapshot($)
            }}>
              {isMembers ? '▾' : '▸'} Pool members
            </Button>
          )}
        </Box>
        <Text dimColor>{e.props.hint}</Text>
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
        l.windows.length ? (
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
