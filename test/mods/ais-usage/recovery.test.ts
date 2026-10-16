import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeMemberHasHeadroom, canResumeActiveAfterReset, changedToAllowedMember, createContinuationLimiter, createRecoveryLifecycle, createTurnRecoveryState, isRateLimitFailure, isUsageLimitFailure, recoveryDelay, runRateLimitRecoveryHook, runRecoveryCycle, runSessionEndHook } from '../../../mods/ais-usage/hooks/recovery'

describe('usage mod recovery', () => {
  it('passes explicit quota evidence from the StopFailure classifier into recovery scheduling', () => {
    const source = readFileSync(join(import.meta.dir, '../../../mods/ais-usage/hooks/register.tsx'), 'utf8')
    expect(source).toMatch(/\(before, failureAtMs, assumeLimited, submitOnly, trustLimitEvidence\) => \{\s*if \(configDir && recoveryLifecycle\.isCurrent\(generation\)\) scheduleRecovery\([^\n]*submitOnly, trustLimitEvidence\)/)
    expect(source).toMatch(/on\('turn\.start',[\s\S]*?turnRecovery\.start\(Date\.now\(\)\)/)
    expect(source).toMatch(/on\('turn\.complete',[\s\S]*?!e\.agentId && e\.turnId === mainTurnId[\s\S]*?turnRecovery\.complete\(e\.reason,[^\n]*continuationLimiter\)/)
    expect(source).toMatch(/const failureAtMs = turnRecovery\.stopFailure\(\)[\s\S]*?Date\.now, failureAtMs\)/)
    const promptHook = source.slice(source.indexOf("on('prompt.submit'"), source.indexOf("on('command.run'"))
    expect(promptHook).not.toMatch(/observedPoolActive\s*=/)
  })

  it('recognises usage quota prose and does not mistake a generic throttle for quota exhaustion', () => {
    expect(isRateLimitFailure({ error: 'rate_limit', error_details: 'weekly limit reached' })).toBe(true)
    expect(isUsageLimitFailure({ error: 'rate_limit', error_details: "You've hit your weekly limit. It resets at 00:00." })).toBe(true)
    expect(isUsageLimitFailure({ error: 'rate_limit', error_details: 'server throttle at 40%' })).toBe(false)
  })

  it('continues only after the active member changes to an allowed member', () => {
    const before = { active: 'alpha' }
    expect(changedToAllowedMember(before, { active: 'beta', accounts: [{ name: 'beta', allowed: true }] })).toBe(true)
    expect(changedToAllowedMember(before, { active: 'beta', accounts: [{ name: 'beta', allowed: false }] })).toBe(false)
  })

  it('recognises fresh headroom and uses reset time when available', () => {
    expect(activeMemberHasHeadroom({ active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 99 } }] })).toBe(true)
    expect(activeMemberHasHeadroom({ active: 'alpha', accounts: [{ name: 'alpha', allowed: false, usage: { status: 'live', maxUtilization: 99 } }] })).toBe(false)
    const staleActive = { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 14 } }] }
    expect(canResumeActiveAfterReset(staleActive, undefined, 30_000)).toBe(false)
    expect(canResumeActiveAfterReset(staleActive, 60_000, 30_000)).toBe(false)
    expect(canResumeActiveAfterReset(staleActive, 60_000, 60_000)).toBe(true)
    expect(recoveryDelay(30_000, 0)).toBe(60_000)
    expect(recoveryDelay(undefined, 0)).toBe(60_000)
  })

  it('waits for the classic hook chain before scheduling recovery', async () => {
    const sequence: string[] = []
    await runRateLimitRecoveryHook(
      { error: 'rate_limit', error_details: 'weekly quota reached' },
      async () => { sequence.push('next'); return 'done' },
      async () => { sequence.push('status'); return { active: 'alpha' } },
      (_before, _failureAtMs, assumeLimited) => sequence.push(assumeLimited ? 'schedule-hard' : 'schedule'),
    )
    expect(sequence).toEqual(['next', 'status', 'schedule-hard'])
  })

  it('does not assume a server throttle when the active member has fresh headroom', async () => {
    const sequence: string[] = []
    await runRateLimitRecoveryHook(
      { error: 'rate_limit', error_details: 'server throttle at 40%' },
      async () => { sequence.push('next'); return 'done' },
      async () => ({ active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 40 } }] }),
      (_before, _failureAtMs, assumeLimited, submitOnly) => sequence.push(`${assumeLimited}:${submitOnly}`),
    )
    expect(sequence).toEqual(['next', 'false:true'])
  })

  it('trusts explicit weekly limit text over live 60 percent and carries it into recovery', async () => {
    let decision: [boolean, boolean, boolean] | undefined
    await runRateLimitRecoveryHook(
      { error: 'rate_limit', error_details: "You've hit your weekly limit · resets 3pm" },
      async () => 'done',
      async () => ({ active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 60 } }] }),
      (_before, _failureAtMs, assumeLimited, submitOnly, trustEvidence) => { decision = [assumeLimited, submitOnly, trustEvidence] },
    )
    expect(decision).toEqual([true, false, true])

    let swaps = 0
    let submitted: string | undefined
    let reads = 0
    await runRecoveryCycle({
      before: { active: 'alpha' },
      trustLimitEvidence: true,
      isCurrent: () => true,
      readStatus: async () => ++reads === 1
        ? { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 60 } }] }
        : { active: 'beta', accounts: [{ name: 'beta', allowed: true, usage: { status: 'live', maxUtilization: 10 } }] },
      swap: async () => { swaps++; return { action: 'swapped' } },
      submit: active => { submitted = active },
      retry: () => {},
    })
    expect({ swaps, submitted }).toEqual({ swaps: 1, submitted: 'beta' })
  })

  it('keeps repeated weekly failures at live 60 percent on the hard-limit swap path', async () => {
    let swaps = 0
    let submissions = 0
    const status = { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 60 } }] }
    for (const failureAtMs of [100, 200]) {
      let trustEvidence = false
      await runRateLimitRecoveryHook(
        { error: 'rate_limit', error_details: "You've hit your weekly limit. It resets later." },
        async () => 'done',
        async () => status,
        (_before, _failureAt, assumeLimited, submitOnly, trust) => {
          expect(assumeLimited).toBe(true)
          expect(submitOnly).toBe(false)
          trustEvidence = trust
        },
        () => failureAtMs,
      )
      await runRecoveryCycle({
        before: status,
        failureAtMs,
        trustLimitEvidence: trustEvidence,
        isCurrent: () => true,
        readStatus: async () => status,
        swap: async () => { swaps++; return { action: 'no-candidate', retryAtMs: failureAtMs + 60_000 } },
        submit: () => { submissions++ },
        retry: (_retryAt, _activeRetryAt, trusted) => { expect(trusted).toBe(true) },
      })
    }
    expect({ swaps, submissions }).toEqual({ swaps: 2, submissions: 0 })
  })

  it('limits repeated throttle continuations per member across cancellation and backoff windows', async () => {
    const limiter = createContinuationLimiter()
    const status = { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 40 } }] }
    let now = 0
    const request = async () => {
      let delay: number | undefined
      await runRateLimitRecoveryHook(
        { error: 'rate_limit', error_details: 'Server is temporarily limiting requests (not your usage limit)' },
        async () => 'done',
        async () => status,
        (_before, _failureAtMs, assumeLimited, submitOnly) => {
          expect(assumeLimited).toBe(false)
          expect(submitOnly).toBe(true)
          delay = limiter.reserve(status.active, now)
        },
        () => now,
      )
      return delay
    }

    expect(await request()).toBe(60_000)
    expect(await request()).toBeUndefined()
    limiter.cancelled('alpha')
    now = 10_000
    expect(await request()).toBe(60_000)
    limiter.fired('alpha')
    now = 70_000
    expect(await request()).toBe(120_000)
  })

  it('keeps continuation caps across cancellation and bounds exponential backoff at ten minutes', () => {
    const limiter = createContinuationLimiter()
    let now = 0
    const delays: number[] = []
    for (const expected of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      const delay = limiter.reserve('alpha', now)
      expect(delay).toBe(expected)
      delays.push(delay!)
      limiter.fired('alpha')
      now += expected
    }
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])

    const another = createContinuationLimiter()
    expect(another.reserve('beta', 0)).toBe(60_000)
    another.fired('beta')
    expect(another.reserve('beta', 60_000)).toBe(120_000)
    another.cancelled('beta')
    expect(another.reserve('beta', 179_000)).toBe(120_000)
  })

  it('treats a non-headroom active member as exhausted even without quota prose', async () => {
    const scheduled: boolean[] = []
    await runRateLimitRecoveryHook(
      { error: 'rate_limit', error_details: 'server throttle' },
      async () => 'done',
      async () => ({ active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 100 } }] }),
      (_before, _failureAtMs, assumeLimited, submitOnly) => { scheduled.push(assumeLimited, submitOnly) },
    )
    expect(scheduled).toEqual([true, false])
  })

  it('continues after a swap recorded since failure without scheduling another swap', async () => {
    const sequence: string[] = []
    await runRateLimitRecoveryHook(
      { error: 'rate_limit', error_details: 'weekly quota reached' },
      async () => { sequence.push('next'); return 'done' },
      async () => ({ active: 'beta', lastSwapAt: new Date(101).toISOString(), accounts: [{ name: 'beta', allowed: true, usage: { status: 'live', maxUtilization: 100 } }] }),
      (_before, _failureAtMs, _assumeLimited, submitOnly) => sequence.push(submitOnly ? 'submit-only' : 'swap'),
      () => 100,
    )
    expect(sequence).toEqual(['next', 'submit-only'])
  })

  it('uses turn start as the ledger lower bound when the StopFailure hook arrives later', async () => {
    const turn = createTurnRecoveryState(100)
    turn.start(100)
    const sequence: string[] = []
    const failureAtMs = turn.stopFailure()
    await runRateLimitRecoveryHook(
      { error: 'rate_limit', error_details: "You've hit your weekly limit. It resets later." },
      async () => { sequence.push('next'); return 'done' },
      async () => ({
        active: 'beta',
        lastSwapAt: new Date(300).toISOString(),
        accounts: [{ name: 'beta', allowed: true, usage: { status: 'live', maxUtilization: 60 } }],
      }),
      (_before, passedFailureAt, assumeLimited, submitOnly) => {
        expect(passedFailureAt).toBe(100)
        expect(assumeLimited).toBe(false)
        sequence.push(submitOnly ? 'continue' : 'swap')
      },
      () => 500,
      failureAtMs,
    )
    expect(sequence).toEqual(['next', 'continue'])
  })

  it('resets continuation attempts after an answered turn without StopFailure', () => {
    const limiter = createContinuationLimiter()
    const turn = createTurnRecoveryState(0)
    expect(limiter.reserve('alpha', 0)).toBe(60_000)
    limiter.fired('alpha')
    expect(limiter.reserve('alpha', 60_000)).toBe(120_000)
    limiter.cancelled('alpha')
    turn.start(60_000)
    turn.complete('answer', 'alpha', limiter)
    expect(limiter.reserve('alpha', 60_000)).toBe(60_000)

    limiter.cancelled('alpha')
    limiter.fired('alpha')
    turn.start(120_000)
    turn.stopFailure()
    turn.complete('answer', 'alpha', limiter)
    expect(limiter.reserve('alpha', 120_000)).toBe(120_000)
  })

  it('continues for the same active member when the ledger proves this failure was handled', async () => {
    let submitted = 0
    let swapped = 0
    await runRecoveryCycle({
      before: { active: 'beta' },
      failureAtMs: 100,
      isCurrent: () => true,
      readStatus: async () => ({ active: 'beta', lastSwapAt: new Date(101).toISOString(), accounts: [{ name: 'beta', allowed: true, usage: { status: 'unavailable' } }] }),
      swap: async () => { swapped++; return undefined },
      submit: () => { submitted++ },
      retry: () => {},
    })
    expect({ submitted, swapped }).toEqual({ submitted: 1, swapped: 0 })
  })

  it('session end cancels pending work, forwards the event, and permits a later failure', async () => {
    const lifecycle = createRecoveryLifecycle()
    const beforeEnd = lifecycle.capture()
    const event = { session_id: 'SYNTHETIC_FIXTURE_session', reason: 'clear' }
    let received: unknown
    let timerCancelled = false
    const forwarded = runSessionEndHook(lifecycle, event, (e) => { received = e; return 'next-result' }, () => { timerCancelled = true })
    expect(lifecycle.isCurrent(beforeEnd)).toBe(false)
    expect(received).toBe(event)
    expect(timerCancelled).toBe(true)
    expect(forwarded).toBe('next-result')
    const afterEnd = lifecycle.capture()
    expect(lifecycle.isCurrent(afterEnd)).toBe(true)
    let scheduled = false
    await runRateLimitRecoveryHook(
      { error: 'rate_limit', error_details: 'weekly quota reached' },
      async () => 'continued',
      async () => ({ active: 'alpha' }),
      () => { scheduled = true },
    )
    expect(scheduled).toBe(true)
  })

  it('continues on fresh live headroom instead of rotating at a polling deadline', async () => {
    let submitted = 0
    let swapped = 0
    let retried = 0
    const before = { active: 'alpha' }
    const current = { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 14 } }] }
    await runRecoveryCycle({
      before,
      readStatus: async () => current,
      activeRetryAtMs: undefined,
      isCurrent: () => true,
      swap: async () => { swapped++; return { action: 'no-candidate', retryAtMs: 30_000 } },
      submit: () => { submitted++ },
      retry: () => { retried++ },
      now: () => 30_000,
    })
    expect({ submitted, swapped, retried }).toEqual({ submitted: 1, swapped: 0, retried: 0 })
  })

  it('does not start a recovery swap after cancellation during status lookup', async () => {
    let current = true
    let swapped = false
    await runRecoveryCycle({
      before: { active: 'alpha' },
      isCurrent: () => current,
      readStatus: async () => { current = false; return { active: 'alpha' } },
      swap: async () => { swapped = true; return undefined },
      submit: () => {},
      retry: () => {},
    })
    expect(swapped).toBe(false)
  })

  it('schedules a backoff retry when the recovery swap command fails', async () => {
    let retriedWith: [number | undefined, number | undefined] | undefined
    await runRecoveryCycle({
      before: { active: 'alpha' },
      isCurrent: () => true,
      readStatus: async () => ({ active: 'alpha' }),
      swap: async () => undefined,
      submit: () => { throw new Error('must not submit') },
      retry: (retryAtMs, activeRetryAtMs) => { retriedWith = [retryAtMs, activeRetryAtMs] },
    })
    expect(retriedWith).toEqual([undefined, undefined])
  })

  it('submits instead of swapping when a reread shows the same active member has headroom', async () => {
    let submitted = 0
    let swapped = 0
    await runRecoveryCycle({
      before: { active: 'alpha' },
      isCurrent: () => true,
      readStatus: async () => ({ active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 14 } }] }),
      swap: async () => { swapped++; return undefined },
      submit: () => { submitted++ },
      retry: () => {},
    })
    expect({ submitted, swapped }).toEqual({ submitted: 1, swapped: 0 })
  })

  it('submits when headroom appears during the recovery swap call', async () => {
    let submitted = 0
    let reads = 0
    await runRecoveryCycle({
      before: { active: 'alpha' },
      isCurrent: () => true,
      readStatus: async () => ++reads === 1
        ? { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 100 } }] }
        : { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 40 } }] },
      swap: async () => ({ action: 'not-limited' }),
      submit: () => { submitted++ },
      retry: () => {},
    })
    expect(submitted).toBe(1)
  })

  it('keeps prior active reset evidence when a later poll omits it', async () => {
    let retryActiveReset: number | undefined
    await runRecoveryCycle({
      before: { active: 'alpha' },
      activeRetryAtMs: 60_000,
      isCurrent: () => true,
      readStatus: async () => ({ active: 'alpha' }),
      swap: async () => ({ action: 'no-candidate', retryAtMs: 30_000 }),
      submit: () => {},
      retry: (_poll, activeReset) => { retryActiveReset = activeReset },
    })
    expect(retryActiveReset).toBe(60_000)
  })

  it('retains trusted quota evidence when a recovery retry is scheduled', async () => {
    let retryArgs: [number | undefined, number | undefined, boolean | undefined] | undefined
    let reads = 0
    await runRecoveryCycle({
      before: { active: 'alpha' },
      failureAtMs: 100,
      trustLimitEvidence: true,
      isCurrent: () => true,
      readStatus: async () => ++reads === 1
        ? { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 60 } }] }
        : { active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 60 } }] },
      swap: async () => ({ action: 'no-candidate', retryAtMs: 60_000 }),
      submit: () => { throw new Error('trusted quota recovery must wait for retry') },
      retry: (retryAt, activeRetryAt, trustEvidence) => { retryArgs = [retryAt, activeRetryAt, trustEvidence] },
    })
    expect(retryArgs).toEqual([60_000, undefined, true])
  })

  it('resumes a trusted hard-limit failure when the same active member reset is confirmed', async () => {
    let submitted: string | undefined
    await runRecoveryCycle({
      before: { active: 'alpha' },
      activeRetryAtMs: 10_000,
      trustLimitEvidence: true,
      isCurrent: () => true,
      readStatus: async () => ({ active: 'alpha', accounts: [{ name: 'alpha', allowed: true, usage: { status: 'live', maxUtilization: 60 } }] }),
      swap: async () => ({ action: 'not-limited' }),
      submit: active => { submitted = active },
      retry: () => {},
      now: () => 10_000,
    })
    expect(submitted).toBe('alpha')
  })
})
