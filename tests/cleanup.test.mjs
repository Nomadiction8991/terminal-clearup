import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startCleanup } from '../worker/main.mjs'

const terminal = {
  handle: 'term_1', ptyId: 'pty-1', worktreeId: 'workspace-1',
  tabId: 'tab-1', leafId: 'leaf-1', incarnationId: 'instance-1', lastOutputAt: 1
}
const completed = {
  id: 'run-1', automationId: 'automation-1', status: 'completed',
  workspaceId: 'workspace-1', terminalPaneKey: 'tab-1:leaf-1', terminalPtyId: null
}

async function fixture({ runs = [completed], terminals = [terminal], idleMinutes } = {}) {
  let time = 0
  let poll
  let listCalls = 0
  const closed = []
  const status = []
  const state = { terminals, transformList: (rows) => rows }
  await startCleanup({
    host: { call: async (_, value) => status.push(value) },
    storage: { get: async () => null, set: async () => {} },
    settings: { get: async (key) => key === "idleMinutes" ? idleMinutes : undefined, onDidChange() {} },
    log() {}
  }, {
    platform: 'linux',
    now: () => time,
    schedule: (callback) => { poll = callback },
    callCli: async (area, command, ...args) => {
      if (area === 'automations' && command === 'runs') return { runs }
      if (area === 'automations' && command === 'list') {
        return { automations: [{ id: 'automation-1', name: 'Manutenção' }] }
      }
      if (command === 'list') {
        return { terminals: state.transformList(state.terminals, ++listCalls), truncated: false }
      }
      assert.equal(command, 'close')
      closed.push(args[1])
      state.terminals = state.terminals.filter((row) => row.handle !== args[1])
      return { close: { ptyKilled: true } }
    }
  })
  return { state, closed, status, tick: async (ms) => { time += ms; await poll() } }
}

test('fecha execução antiga sem PTY no histórico após três minutos', async () => {
  const f = await fixture()
  await f.tick(179_999)
  assert.deepEqual(f.closed, [])
  await f.tick(1)
  assert.deepEqual(f.closed, ['term_1'])
  assert.match(f.status.at(-1).text, /1 aba fechada/)
  await f.tick(180_000)
  assert.equal(f.closed.length, 1)
})

for (const [label, runs] of [
  ['execução com falha', [{ ...completed, status: 'dispatch_failed' }]],
  ['painel compartilhado', [completed, { ...completed, id: 'run-2', status: 'dispatched' }]],
  ['PTY diferente', [{ ...completed, terminalPtyId: 'different' }]],
  ['workspace diferente', [{ ...completed, workspaceId: 'different' }]],
  ['terminal pessoal', []]
]) {
  test(`preserva ${label}`, async () => {
    const f = await fixture({ runs })
    await f.tick(180_000)
    assert.deepEqual(f.closed, [])
  })
}

test('reinicia a espera se o terminal muda durante a revalidação', async () => {
  const f = await fixture()
  f.state.transformList = (rows, call) => call === 3
    ? rows.map((row) => ({ ...row, lastOutputAt: 2 }))
    : rows
  await f.tick(180_000)
  await f.tick(60_000)
  assert.deepEqual(f.closed, [])
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
})

test('fecha na primeira varredura quando o prazo é zero', async () => {
  const f = await fixture({ idleMinutes: 0 })
  assert.deepEqual(f.closed, ['term_1'])
})
