import { expect, mock, test } from 'claude-code/testing'

const dir = '/c/swap'
const HINT = { hint: '? for shortcuts', isDraft: false, isWorking: false }
const win = (category: string, usedPercent: number) => ({ label: category, category, usedPercent })
const entry = (name: string, configDir: string, extra = {}) => ({
  toolName: 'claude',
  identity: { name, configDir, ...extra },
  windows: [win('session', 12), win('week', 34)],
  status: 'live',
})
// Live shape: the pool entry is unavailable and status is fetched without usage, so windows come from limits.
const limits = [
  { ...entry('team-pool', dir, { swapPool: { active: 'a', accounts: ['a', 'b'] } }), windows: [], status: 'unavailable' },
  entry('a', '/c/a'),
  entry('b', '/c/b'),
]
const status = {
  pool: 'team-pool',
  active: 'a',
  auto: true,
  thresholdPercent: 95,
  accounts: ['a', 'b'].map(name => ({
    name,
    active: name === 'a',
    allowed: true,
  })),
}

test('PromptHint shows the toggles row, then the hint, in a pool', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  expect(await ui.find({ type: 'Text', text: /\? for shortcuts/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Other providers/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Pool members/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pool 12% used/ })).toBeUndefined()
  await ui.unmount()
})

test('nothing renders for AbovePrompt', async ($, on) => {
  await mountBand($, on, poolLimits, dir)
  await expect(
    $.ui.mount({ plugin: 'ais-usage', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 80 } } as never),
  ).rejects.toThrow(/no implementation for ui.render/)
})

const writes: { path: string; text: string }[] = []
const lastWrite = () => JSON.parse(writes[writes.length - 1]!.text)

const mountBand = async ($: any, on: any, lims: unknown[], cfg: string, columns?: number) => {
  mock.env(on, { CLAUDE_CONFIG_DIR: cfg, HOME: '/h' })
  const clock = mock.clock(on)
  mock.store(on)
  writes.length = 0
  on('fs.write', (_$: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined } as never
  })
  on('session.start', ($$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ais-usage' } }))
  on('process.run', ($$: any, e: any) => {
    const out = e.argv.includes('limits') ? lims : status
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } } as never
  })
  await $.session.start?.({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1)
  return $.ui.mount({
    plugin: 'ais-usage',
    surface: 'terminal',
    component: 'PromptHint',
    props: HINT,
    ...(columns ? { viewport: { columns, rows: 40 } } : {}),
  } as never)
}
const poolLimits = [...limits, { ...entry('a', '/x/a'), toolName: 'codex' }, { ...entry('team-pool', '/x/swap', { swapPool: { active: 'a', accounts: ['a', 'b'] } }), toolName: 'codex' }]

test('Both buttons are hidden outside a pool with no other providers', async ($, on) => {
  const ui = await mountBand($, on, [entry('a', '/c/a')], '/c/a')
  expect(await ui.find({ type: 'Button', text: /Other providers/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Pool members/ })).toBeUndefined()
  await ui.unmount()
})

test('PromptHint passes through when there are no rows', async ($, on) => {
  mock.env(on, { CLAUDE_CONFIG_DIR: dir, HOME: '/h' })
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ais-usage' } }))
  on('process.run', ($$, e) => {
    const out = e.argv.includes('limits') ? [{ ...entry('a', '/c/a'), windows: [] }] : status
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } } as never
  })
  await $.session.start?.({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1)
  // Passing through reaches the engine, which this harness does not implement.
  await expect(
    $.ui.mount({
      plugin: 'ais-usage',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, bodyColumns: 80 },
    } as never),
  ).rejects.toThrow(/no implementation for ui.render/)
})

test('pressing Other providers writes the snapshot with open others', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  await ui.press({ key: 'others' })
  expect(writes[writes.length - 1]!.path).toBe('/h/.ais/cache/ais-usage/swap.json')
  expect(lastWrite()).toMatchObject({ open: 'others', othersOpen: true, membersOpen: false })
  expect(lastWrite().limits).toHaveLength(poolLimits.length)
  await ui.press({ key: 'others' })
  expect(lastWrite()).toMatchObject({ open: null, othersOpen: false })
  await ui.unmount()
})

test('opening one section closes the other', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  await ui.press({ key: 'others' })
  await ui.press({ key: 'members' })
  expect(lastWrite()).toMatchObject({ open: 'members', othersOpen: false, membersOpen: true })
  expect(typeof lastWrite().updatedAt).toBe('number')
  await ui.press({ key: 'others' })
  expect(lastWrite().open).toBe('others')
  await ui.unmount()
})

test('Other providers is hidden in a pool with no other-tool pool of the same name', async ($, on) => {
  const ui = await mountBand($, on, limits, dir)
  expect(await ui.find({ type: 'Button', text: /Other providers/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Pool members/ })).toBeDefined()
  await ui.press({ key: 'members' })
  expect(lastWrite()).toMatchObject({ open: 'members' })
  await ui.unmount()
})

test('PromptHint tree has the hint and buttons but no bar rows, open or closed', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  await ui.press({ key: 'others' })
  await ui.press({ key: 'members' })
  expect(await ui.find({ type: 'Text', text: /\? for shortcuts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(session|week)\s+\[/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^codex$/ })).toBeUndefined()
  await ui.unmount()
})

const runSwap = async ($: any, on: any, args: string, reply: { exitCode: number; stdout: string; stderr?: string }) => {
  mock.env(on, { CLAUDE_CONFIG_DIR: dir, HOME: '/h' })
  const clock = mock.clock(on)
  mock.store(on)
  const calls: string[][] = []
  on('fs.write', () => ({ value: undefined }) as never)
  on('session.start', ($$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ais-usage' } }))
  on('process.run', ($$: any, e: any) => {
    if (e.argv.includes('claude-swap') && !e.argv.includes('--json')) {
      calls.push(e.argv.slice(1))
      return { value: { stderr: '', ...reply } } as never
    }
    const out = e.argv.includes('limits') ? limits : status
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } } as never
  })
  await $.session.start?.({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1)
  const res = await $.command.run({ command: 'ais-swap', args })
  return { res, calls }
}

test('ais-swap status passes ais output through, stripping colour', async ($, on) => {
  const { res, calls } = await runSwap($, on, '', { exitCode: 0, stdout: '\u001b[32mactive a\u001b[0m\n' })
  expect(calls).toEqual([['claude-swap', 'status']])
  expect(res.text).toBe('active a')
  expect(res.context).toBeUndefined()
})

test('ais-swap next swaps manually and tells the model', async ($, on) => {
  const { res, calls } = await runSwap($, on, ' next ', { exitCode: 0, stdout: 'swapped to b' })
  expect(calls).toEqual([['claude-swap', 'next', '--reason=manual']])
  expect(res.text).toMatch(/swapped to b\nA running session picks the new login up on its next message/)
  expect(res.context?.[0]).toMatch(/active account changed to/)
})

test('ais-swap to <name> and error passthrough without retry', async ($, on) => {
  const ok = await runSwap($, on, 'b', { exitCode: 0, stdout: 'ok' })
  expect(ok.calls).toEqual([['claude-swap', 'to', 'b']])
})

test('ais-swap error text is returned, no force retry', async ($, on) => {
  const { res, calls } = await runSwap($, on, 'zed', { exitCode: 1, stdout: '', stderr: 'unknown account zed' })
  expect(calls).toEqual([['claude-swap', 'to', 'zed']])
  expect(res.text).toBe('unknown account zed')
  expect(res.context).toBeUndefined()
})

test('ais-swap rejects more than one word', async ($, on) => {
  const { res, calls } = await runSwap($, on, 'a b', { exitCode: 0, stdout: '' })
  expect(calls).toEqual([])
  expect(res.text).toMatch(/^Usage: \/ais-swap/)
})
