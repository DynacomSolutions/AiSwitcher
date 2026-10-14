import { expect, mock, test } from 'claude-code/testing'

const dir = '/c/swap'
const win = (category: string, usedPercent: number) => ({ label: category, category, usedPercent })
const entry = (name: string, configDir: string, extra = {}) => ({
  toolName: 'claude',
  identity: { name, configDir, ...extra },
  windows: [win('session', 12), win('week', 34)],
  status: 'live',
})
// Live shape: the pool entry is unavailable and every member's usage answered HTTP 429.
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
    usage: { status: 'rate-limited', error: 'usage endpoint answered HTTP 429' },
  })),
}

test('AbovePrompt band draws rows when pool usage is rate-limited', async ($, on) => {
  mock.env(on, { CLAUDE_CONFIG_DIR: dir, HOME: '/h' })
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ais-usage' } }))
  on('ui.status', () => ({ value: undefined }) as never)
  on(['process', 'run'].join('.') as never, ($$: unknown, e: { argv: string[] }) => {
    const out = e.argv.includes('limits') ? limits : status
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } } as never
  })
  await $.session.start?.({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(1)
  const ui = await $.ui.mount({
    plugin: 'ais-usage',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 },
  } as never)
  expect(await ui.find({ type: 'Text', text: /session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /week/ })).toBeDefined()
  await ui.unmount()
})
