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
  providerBlocks,
  snapshotPath,
  pct,
  resolveCurrent,
  shares,
  shortError,
  switchNotice,
  tone,
  totals,
} from './model'
import { createContinuationLimiter, createRecoveryLifecycle, createTurnRecoveryState, recoveryDelay, runRateLimitRecoveryHook, runRecoveryCycle, runSessionEndHook } from './recovery'
import type { RecoveryStatus } from './recovery'
import type { Section } from './model'

const PANE = 'ais-usage'

const status = atom({ plugin: 'ais-usage', key: 'status' } as const, null)
const usage = atom({ plugin: 'ais-usage', key: 'usage' } as const, null)
const limits = atom({ plugin: 'ais-usage', key: 'limits' } as const, null)
const expanded = atom({ plugin: 'ais-usage', key: 'expanded' } as const, [])
// The one expanded section; opening one closes the other.
const open = atom({ plugin: 'ais-usage', key: 'open' } as const, null as Section | null)
const updatedAt = atom({ plugin: 'ais-usage', key: 'updatedAt' } as const, 0)
const loading = atom({ plugin: 'ais-usage', key: 'loading' } as const, 0)
const errors = atom({ plugin: 'ais-usage', key: 'errors' } as const, [])

// Last pool member seen at a prompt; '' until the first prompt.
const lastMember = atom({ plugin: 'ais-usage', key: 'lastMember' } as const, '')

/**
 * Shares toggles and data with `ais statusline`, which draws the expanded blocks.
 * One file per session (identity + session id), so sessions on one identity keep their own toggles.
 * shortcut: $.fs has no rename or delete, so the write is not atomic (the reader ignores a torn file) and dead sessions'
 * files stay until the reader's staleness check ignores them; upgrade when $.fs can delete.
 */
const writeSnapshot = async ($: any) => {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    // Read per write: /clear starts a new session id without a new session.start. No id: the identity file.
    const id = await $.session.id().catch(() => undefined)
    const path = snapshotPath(home, await $.env.get('CLAUDE_CONFIG_DIR'), id || undefined)
    const lim = await read($, limits)
    const st = await read($, status)
    const r = resolveCurrent(lim, await $.env.get('CLAUDE_CONFIG_DIR'), st)
    const raw = await read($, open)
    const o = raw === 'others' && !providerBlocks(lim, r).length ? null : raw
    await $.fs.write(
      path,
      JSON.stringify({
        open: o,
        othersOpen: o === 'others',
        membersOpen: o === 'members',
        limits: lim,
        status: st,
        updatedAt: Date.now(),
      }),
    )
  } catch {
    // The status line is optional; a failed write must never break the mod.
  }
}

/** Runs `ais` (on PATH, else ~/.local/bin/ais). */
const runAis = async ($: any, args: string[], timeoutMs: number) => {
  try {
    return await $.process.run(['ais', ...args], { timeoutMs })
  } catch {
    return await $.process.run([`${(await $.env.get('HOME')) ?? ''}/.local/bin/ais`, ...args], { timeoutMs })
  }
}

const ANSI = /\u001b\[[0-9;]*m/g
const USAGE = 'Usage: /ais-swap [next | <account>]'

const pad2 = (n: number) => String(n).padStart(2, '0')

export const register: Register = on => {
  let isLimitsBusy = false
  let recoveryTimer: { cancel: () => void } | undefined
  let recoverySubmitMember: string | undefined
  const recoveryLifecycle = createRecoveryLifecycle()
  const continuationLimiter = createContinuationLimiter()
  const turnRecovery = createTurnRecoveryState()
  let observedPoolActive: string | undefined
  let mainTurnId: string | undefined
  const cancelRecovery = () => {
    recoveryLifecycle.cancel()
    recoveryTimer?.cancel()
    recoveryTimer = undefined
    if (recoverySubmitMember) continuationLimiter.cancelled(recoverySubmitMember)
    recoverySubmitMember = undefined
  }
  const poolStatus = async ($: any, configDir: string): Promise<RecoveryStatus | undefined> => {
    try {
      const r = await runAis($, ['claude-swap', 'status', '--json', `--config-dir=${configDir}`], 20000)
      const value = r.exitCode === 0 ? parseJson<RecoveryStatus>(r.stdout) : undefined
      if (value?.active) observedPoolActive = value.active
      return value
    } catch {
      return undefined
    }
  }
  const queueContinuation = ($: any) => {
    // Prompt submission from inside a working hook is rejected. The timer
    // runs after the classic hook chain has returned and the turn is idle.
    void $.prompt.submit({ text: 'Continue the interrupted request now that an allowed pool member is available.' }).catch(() => undefined)
  }
  const scheduleContinuation = ($: any, active: string | undefined) => {
    if (!active) return
    if (recoverySubmitMember === active && recoveryTimer) return
    cancelRecovery()
    const delay = continuationLimiter.reserve(active, Date.now())
    if (delay === undefined) return
    const generation = recoveryLifecycle.capture()
    recoverySubmitMember = active
    recoveryTimer = $.clock.after(delay, async () => {
      recoveryTimer = undefined
      recoverySubmitMember = undefined
      continuationLimiter.fired(active)
      if (recoveryLifecycle.isCurrent(generation)) queueContinuation($)
    })
  }
  const scheduleRecovery = ($: any, configDir: string, before: RecoveryStatus, failureAtMs: number, assumeLimited: boolean, retryAtMs?: number, activeRetryAtMs?: number, immediate = false, submitOnly = false, trustLimitEvidence = false) => {
    if (submitOnly) return scheduleContinuation($, before.active)
    cancelRecovery()
    const generation = recoveryLifecycle.capture()
    recoveryTimer = $.clock.after(recoveryDelay(retryAtMs, Date.now(), immediate ? 0 : 60_000), async () => {
      recoveryTimer = undefined
      const isCurrent = () => recoveryLifecycle.isCurrent(generation)
      void runRecoveryCycle({
        before,
        failureAtMs,
        activeRetryAtMs,
        trustLimitEvidence,
        isCurrent,
        readStatus: () => poolStatus($, configDir),
        swap: async () => {
          try {
            const r = await runAis($, [
              'claude-swap', 'next', '--if-limited', ...(assumeLimited ? ['--assume-limited'] : []), '--reason=auto', '--json',
              ...(trustLimitEvidence ? ['--trust-limit-evidence'] : []),
              `--failure-at-ms=${failureAtMs}`,
              `--config-dir=${configDir}`, `--expected-active=${before.active}`,
            ], 60000)
            return r.exitCode === 0 ? parseJson<{ action?: string; retryAtMs?: number; activeRetryAtMs?: number }>(r.stdout) : undefined
          } catch {
            return undefined
          }
        },
        submit: active => { if (isCurrent()) scheduleContinuation($, active) },
        retry: (nextRetryAtMs, nextActiveRetryAtMs, nextTrustLimitEvidence) => {
          if (isCurrent()) scheduleRecovery($, configDir, before, failureAtMs, assumeLimited, nextRetryAtMs, nextActiveRetryAtMs, false, false, nextTrustLimitEvidence)
        },
      }).catch(() => undefined)
    })
  }
  // Set by session.start; the command and the Refresh button call it.
  let refreshHandle: (() => Promise<void>) | undefined

  on('session.start', async ($, e, next) => {
    cancelRecovery()
    // Clears a status left by an older loaded version after /reload-plugins.
    $.ui.status(undefined)

    const run = (args: string[], timeoutMs: number) => runAis($, args, timeoutMs)

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
        if (v.active) observedPoolActive = v.active
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
    await $.command.register({
      name: 'ais-swap',
      description: 'Switch the active account of the AIS swap pool',
      argumentHint: '[next | <account>]',
    })
    void refreshAll()
    $.clock.every(60_000, () => void refreshStatus())
    $.clock.every(600_000, () => void refreshUsage())
    $.clock.every(300_000, () => void refreshLimits())
    refreshHandle = refreshAll

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    let configDir: string | undefined
    const generation = recoveryLifecycle.capture()
    const failureAtMs = turnRecovery.stopFailure()
    return runRateLimitRecoveryHook(e, () => next(e), async () => {
      try {
        configDir = await $.env.get('CLAUDE_CONFIG_DIR')
        return configDir ? await poolStatus($, configDir) : undefined
      } catch {
        return undefined
      }
    }, (before, failureAtMs, assumeLimited, submitOnly, trustLimitEvidence) => {
      if (configDir && recoveryLifecycle.isCurrent(generation)) scheduleRecovery($, configDir, before, failureAtMs, assumeLimited, undefined, undefined, true, submitOnly, trustLimitEvidence)
    }, Date.now, failureAtMs)
  })

  on('turn.start', ($, e, next) => {
    mainTurnId = e.turnId
    turnRecovery.start(Date.now())
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.turnId === mainTurnId) {
      const st = await read($, status)
      turnRecovery.complete(e.reason, observedPoolActive ?? st?.active, continuationLimiter)
      mainTurnId = undefined
    }
    return result
  })

  on('session.end', (_$, e, next) => runSessionEndHook(recoveryLifecycle, e, next, () => {
    recoveryTimer?.cancel()
    recoveryTimer = undefined
    if (recoverySubmitMember) continuationLimiter.cancelled(recoverySubmitMember)
    recoverySubmitMember = undefined
  }))

  on('prompt.submit', async ($, e, next) => {
    cancelRecovery()
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

  on('command.run', { command: 'ais-swap' }, async ($, e) => {
    const arg = e.args.trim()
    const words = arg.split(/\s+/).filter(Boolean)
    if (words.length > 1) return { text: USAGE }
    const word = words[0] ?? ''
    const swap = word === '' || word === 'status' ? ['status'] : word === 'next' ? ['next', '--reason=manual'] : ['to', word]
    const r = await runAis($, ['claude-swap', ...swap], 60000)
    const out = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).replace(ANSI, '').trim()
    if (r.exitCode !== 0) return { text: out || `ais claude-swap ${swap[0]} failed (exit ${r.exitCode})` }
    if (swap[0] === 'status') return { text: out }
    await refreshHandle?.()
    const active = (await read($, status))?.active ?? (word === 'next' ? '' : word)
    return {
      text: `${out}\nA running session picks the new login up on its next message.`,
      ...(active ? { context: [`The AIS swap pool's active account changed to ${active}.`] } : {}),
    }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const st = await read($, status)
    const lim = await read($, limits)
    const r = resolveCurrent(lim, await $.env.get('CLAUDE_CONFIG_DIR'), st)
    if (!lim || !bandRows(r, st, lim).length) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    const hasOthers = providerBlocks(lim, r).length > 0
    const o = await read($, open)
    // A section that cannot show anything counts as closed.
    const isOthers = o === 'others' && hasOthers
    const isMembers = o === 'members' && r.kind === 'pool'
    const toggle = (s: Section) => async () => {
      await update($, open, v => (v === s ? null : s))
      await writeSnapshot($)
    }

    return (
      <Box flexDirection="column" alignSelf="flex-start">
        <Box flexDirection="row">
          {hasOthers && (
            <Button key="others" plain onPress={toggle('others')}>
              {isOthers ? '▾' : '▸'} Other providers
            </Button>
          )}
          {hasOthers && r.kind === 'pool' && <Text>{'  '}</Text>}
          {r.kind === 'pool' && (
            <Button key="members" plain onPress={toggle('members')}>
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
