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

test('Pool members button is hidden outside a pool', async ($, on) => {
  const ui = await mountBand($, on, [entry('a', '/c/a')], '/c/a')
  expect(await ui.find({ type: 'Button', text: /Other providers/ })).toBeDefined()
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

test('pressing Other providers writes the snapshot with othersOpen', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  await ui.press({ key: 'others' })
  expect(writes[writes.length - 1]!.path).toBe('/h/.ais/cache/ais-usage/swap.json')
  expect(lastWrite()).toMatchObject({ othersOpen: true, membersOpen: false })
  expect(lastWrite().limits).toHaveLength(poolLimits.length)
  await ui.press({ key: 'others' })
  expect(lastWrite().othersOpen).toBe(false)
  await ui.unmount()
})

test('pressing Pool members writes the snapshot with membersOpen', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  await ui.press({ key: 'members' })
  expect(lastWrite()).toMatchObject({ othersOpen: false, membersOpen: true })
  expect(typeof lastWrite().updatedAt).toBe('number')
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
