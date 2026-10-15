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

test('Other providers expands to a title plus session and week rows of equal bar width', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  await ui.press({ key: 'others' })
  expect(await ui.find({ type: 'Text', text: /^codex$/ })).toBeDefined()
  const bars = [await ui.find({ type: 'Text', text: /^session\s+\[/ }), await ui.find({ type: 'Text', text: /^week\s+\[/ })]
  const widths = bars.map(b => (JSON.stringify(b).match(/\\u2588/g) ?? JSON.stringify(b).match(/█/g) ?? []).length)
  expect(widths[0]).toBeGreaterThan(10)
  expect(widths[0]).toBe(widths[1])
  await ui.unmount()
})

test('a provider added to the limits appears in Other providers', async ($, on) => {
  const extra = { ...entry('team-pool', '/x/swap', { swapPool: { active: 'a', accounts: ['a', 'b'] } }), toolName: 'grok' }
  const ui = await mountBand($, on, [...poolLimits, extra], dir)
  await ui.press({ key: 'others' })
  expect(await ui.find({ type: 'Text', text: /^grok$/ })).toBeDefined()
  await ui.unmount()
})

test('nothing renders for AbovePrompt', async ($, on) => {
  await mountBand($, on, poolLimits, dir)
  await expect(
    $.ui.mount({ plugin: 'ais-usage', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 80 } } as never),
  ).rejects.toThrow(/no implementation for ui.render/)
})

const mountBand = async ($: any, on: any, lims: unknown[], cfg: string) => {
  mock.env(on, { CLAUDE_CONFIG_DIR: cfg, HOME: '/h' })
  const clock = mock.clock(on)
  mock.store(on)
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
  } as never)
}
const poolLimits = [...limits, { ...entry('a', '/x/a'), toolName: 'codex' }, { ...entry('team-pool', '/x/swap', { swapPool: { active: 'a', accounts: ['a', 'b'] } }), toolName: 'codex' }]

test('Other providers toggles open and closed', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  expect(await ui.find({ type: 'Button', text: /Other providers/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s*codex/ })).toBeUndefined()
  await ui.press({ key: 'others' })
  expect(await ui.find({ type: 'Text', text: /^\s*codex/ })).toBeDefined()
  await ui.press({ key: 'others' })
  expect(await ui.find({ type: 'Text', text: /^\s*codex/ })).toBeUndefined()
  await ui.unmount()
})

test('Pool members toggles open and closed in a pool', async ($, on) => {
  const ui = await mountBand($, on, poolLimits, dir)
  expect(await ui.find({ type: 'Button', text: /Pool members/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s*b\s+5h/ })).toBeUndefined()
  await ui.press({ key: 'members' })
  expect(await ui.find({ type: 'Text', text: /^\s*b\s+5h/ })).toBeDefined()
  await ui.press({ key: 'members' })
  expect(await ui.find({ type: 'Text', text: /^\s*b\s+5h/ })).toBeUndefined()
  await ui.unmount()
})

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

test('a member added to the pool appears at the next refresh, no reload', async ($, on) => {
  mock.env(on, { CLAUDE_CONFIG_DIR: dir, HOME: '/h' })
  const clock = mock.clock(on)
  mock.store(on)
  let members = ['a', 'b']
  on('session.start', ($$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ais-usage' } }))
  on('process.run', ($$: any, e: any) => {
    const out = e.argv.includes('limits')
      ? [
          { ...entry('team-pool', dir, { swapPool: { active: 'a', accounts: members } }), windows: [], status: 'unavailable' },
          ...members.map(n => entry(n, `/c/${n}`)),
        ]
      : { ...status, accounts: members.map(name => ({ name, active: name === 'a', allowed: true })) }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } } as never
  })
  await $.session.start?.({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'ais-usage', surface: 'terminal', component: 'PromptHint', props: HINT } as never)
  await ui.press({ key: 'members' })
  expect(await ui.find({ type: 'Text', text: /^\s*c\s+5h/ })).toBeUndefined()
  members = ['a', 'b', 'c']
  await clock.advance(300_000)
  expect(await ui.find({ type: 'Text', text: /^\s*c\s+5h/ })).toBeDefined()
  await ui.unmount()
})
