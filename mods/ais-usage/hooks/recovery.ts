export type RecoveryStatus = {
  active?: string
  lastSwapAt?: string
  accounts?: Array<{ name?: string; allowed?: boolean; usage?: { status?: string; maxUtilization?: number; windows?: Array<{ utilization?: number; resetsAt?: string }> } }>
}

export const createRecoveryLifecycle = () => {
  let generation = 0
  return {
    capture: () => generation,
    cancel: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
  }
}

export const runSessionEndHook = <T>(lifecycle: ReturnType<typeof createRecoveryLifecycle>, event: unknown, next: (event: unknown) => T, cancelTimer: () => void): T => {
  lifecycle.cancel()
  cancelTimer()
  return next(event)
}

const stringField = (record: Record<string, unknown>, key: string): string => typeof record[key] === 'string' ? record[key] as string : ''

export const isUsageLimitFailure = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) return false
  const details = stringField(event as Record<string, unknown>, 'error_details')
  return /(?:hit|reached|exceeded)\s+(?:your\s+)?(?:\w+\s+){0,2}(?:usage\s+)?limit|(?:usage\s+)?quota\s+(?:is\s+)?(?:exhausted|reached)|limit\s+(?:will\s+)?reset|resets?\s+(?:at|in)\b/i.test(details)
}

export const isRateLimitFailure = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) return false
  const record = event as Record<string, unknown>
  return /^rate[_ -]?limit$/i.test(stringField(record, 'error')) || isUsageLimitFailure(event)
}

export const changedToAllowedMember = (before: RecoveryStatus, after: RecoveryStatus): boolean =>
  Boolean(
    before.active &&
    after.active &&
    before.active !== after.active &&
    after.accounts?.some(account => account.name === after.active && account.allowed),
  )

export const activeMemberHasHeadroom = (status: RecoveryStatus): boolean => {
  const active = status.accounts?.find(account => account.name === status.active)
  return active?.allowed === true && active.usage?.status === 'live' && typeof active.usage.maxUtilization === 'number' && active.usage.maxUtilization < 100
}

export const swapRecordedSinceFailure = (status: RecoveryStatus, failureAtMs: number | undefined): boolean => {
  if (typeof failureAtMs !== 'number' || !Number.isFinite(failureAtMs)) return false
  const lastSwap = Date.parse(status.lastSwapAt ?? '')
  return Number.isFinite(lastSwap) && lastSwap >= failureAtMs
}

export const canResumeActiveAfterReset = (status: RecoveryStatus, activeRetryAtMs: number | undefined, now: number): boolean =>
  typeof activeRetryAtMs === 'number' && Number.isFinite(activeRetryAtMs) && activeRetryAtMs <= now && activeMemberHasHeadroom(status)

export const createContinuationLimiter = (floorMs = 60_000, ceilingMs = 600_000) => {
  const states = new Map<string, { attempts: number; nextAllowedAt: number; pending: boolean }>()
  const maxAttempts = Math.ceil(Math.log2(ceilingMs / floorMs))
  return {
    reserve(member: string, now: number): number | undefined {
      if (!member) return undefined
      const state = states.get(member) ?? { attempts: 0, nextAllowedAt: 0, pending: false }
      if (state.pending) return undefined
      const backoff = Math.min(ceilingMs, floorMs * 2 ** Math.min(state.attempts, maxAttempts))
      const deadline = now + Math.max(backoff, state.nextAllowedAt - now)
      state.nextAllowedAt = deadline
      state.pending = true
      states.set(member, state)
      return deadline - now
    },
    fired(member: string): void {
      const state = states.get(member)
      if (!state) return
      state.pending = false
      state.attempts = Math.min(maxAttempts, state.attempts + 1)
    },
    cancelled(member: string): void {
      const state = states.get(member)
      if (state) state.pending = false
    },
    reset(member: string | undefined): void {
      if (member) states.delete(member)
    },
  }
}

export const createTurnRecoveryState = (initialStartedAtMs = Date.now()) => {
  let startedAtMs = initialStartedAtMs
  let hadStopFailure = false
  return {
    start(now: number): void {
      startedAtMs = now
      hadStopFailure = false
    },
    stopFailure(): number {
      hadStopFailure = true
      return startedAtMs
    },
    complete(reason: string, active: string | undefined, limiter: ReturnType<typeof createContinuationLimiter>): void {
      if (reason === 'answer' && !hadStopFailure) limiter.reset(active)
      hadStopFailure = false
    },
  }
}

export const runRateLimitRecoveryHook = async <T>(
  event: unknown,
  next: () => Promise<T>,
  readAfter: () => Promise<RecoveryStatus | undefined>,
  schedule: (before: RecoveryStatus, failureAtMs: number, assumeLimited: boolean, submitOnly: boolean, trustLimitEvidence: boolean) => void,
  now: () => number = Date.now,
  turnStartedAtMs?: number,
): Promise<T> => {
  const failureAtMs = turnStartedAtMs ?? now()
  const result = await next()
  if (!isRateLimitFailure(event)) return result
  const before = await readAfter().catch(() => undefined)
  if (!before?.active) return result
  if (swapRecordedSinceFailure(before, failureAtMs)) return void schedule(before, failureAtMs, false, true, false), result
  const trustLimitEvidence = isUsageLimitFailure(event)
  if (activeMemberHasHeadroom(before) && !trustLimitEvidence) return void schedule(before, failureAtMs, false, true, false), result
  const assumeLimited = trustLimitEvidence || !activeMemberHasHeadroom(before)
  schedule(before, failureAtMs, assumeLimited, false, trustLimitEvidence)
  return result
}

export const runRecoveryCycle = async (input: {
  before: RecoveryStatus
  failureAtMs?: number
  activeRetryAtMs?: number
  trustLimitEvidence?: boolean
  isCurrent: () => boolean
  readStatus: () => Promise<RecoveryStatus | undefined>
  swap: () => Promise<{ action?: string; retryAtMs?: number; activeRetryAtMs?: number } | undefined>
  submit: (active?: string) => void
  retry: (retryAtMs?: number, activeRetryAtMs?: number, trustLimitEvidence?: boolean) => void
  now?: () => number
}): Promise<void> => {
  const current = await input.readStatus()
  if (!input.isCurrent() || !current?.active) return
  if (swapRecordedSinceFailure(current, input.failureAtMs)) return input.submit(current.active)
  if (changedToAllowedMember(input.before, current)) return input.submit(current.active)
  if (current.active === input.before.active && activeMemberHasHeadroom(current) && !input.trustLimitEvidence) return input.submit(current.active)
  if (current.active === input.before.active && canResumeActiveAfterReset(current, input.activeRetryAtMs, (input.now ?? Date.now)())) return input.submit(current.active)
  if (current.active !== input.before.active) return
  const outcome = await input.swap()
  if (!input.isCurrent()) return
  const after = await input.readStatus()
  if (!input.isCurrent()) return
  if (after && swapRecordedSinceFailure(after, input.failureAtMs)) return input.submit(after.active)
  if (after && changedToAllowedMember(input.before, after)) return input.submit(after.active)
  if (after && after.active === input.before.active && activeMemberHasHeadroom(after) && !input.trustLimitEvidence) return input.submit(after.active)
  if (after && after.active === input.before.active && canResumeActiveAfterReset(after, outcome?.activeRetryAtMs ?? input.activeRetryAtMs, (input.now ?? Date.now)())) return input.submit(after.active)
  if (outcome?.action === 'no-candidate' || outcome === undefined) input.retry(outcome?.retryAtMs, outcome?.activeRetryAtMs ?? input.activeRetryAtMs, input.trustLimitEvidence)
}

export const recoveryDelay = (retryAtMs: number | undefined, now: number, fallbackMs = 60_000): number =>
  Math.max(fallbackMs, typeof retryAtMs === 'number' && Number.isFinite(retryAtMs) && retryAtMs > now ? retryAtMs - now : 0)
