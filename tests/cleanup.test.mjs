import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startCleanup } from '../worker/main.mjs'
import { readFileSync } from 'node:fs'

// CLAUDE.md é uma cópia de agent.md, não um symlink: o Orca recusa symlink dentro do plugin instalado a partir desta pasta.
// Este teste impede que as duas cópias divirjam.
test('CLAUDE.md tem o mesmo conteúdo de agent.md', () => {
  const agent = readFileSync(new URL('../agent.md', import.meta.url), 'utf8')
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8')
  assert.equal(claude, agent)
})

const terminal = {
  handle: 'term_1', ptyId: 'pty-1', worktreeId: 'workspace-1',
  tabId: 'tab-1', leafId: 'leaf-1', incarnationId: 'instance-1', lastOutputAt: 1
}
const completed = {
  id: 'run-1', automationId: 'automation-1', status: 'completed',
  workspaceId: 'workspace-1', terminalPaneKey: 'tab-1:leaf-1', terminalPtyId: null
}
const lost = {
  ...completed, id: 'run-lost', status: 'dispatch_failed',
  error: 'Orca stopped watching this run before it reported completion.', terminalPtyId: 'pty-1'
}

async function fixture({
  runs = [completed], terminals = [terminal], idleMinutes, settings: overrides = {},
  idle = true, memorySessions = null, closeReceipt = { ptyKilled: true },
  failClose = false, keepAfterClose = false, failListAfterClose = false,
  malformedListAfterClose = false, malformedList = false, failDailySet = false,
  syncDailySet = false, failDailyGet = false, failDailyGetAfterClose = false,
  closeFailsAfterRemoval = false, onStatus = null, onClose = null, onMemory = null
} = {}) {
  let time = 0
  let poll
  const closed = []
  const status = []
  const logs = []
  let postCloseLists = 0
  let dailyFailing = failDailySet
  const writes = []
  const reads = { afterClose: 0 }
  const changeHandlers = []
  const emit = (key) => { for (const callback of changeHandlers) callback({ key }) }
  const store = new Map()
  const state = { terminals }
  const values = { idleMinutes, ...overrides }
  await startCleanup({
    host: { call: async (_, value) => { onStatus?.(value, emit, values); status.push(value) } },
    storage: {
      get: async (key) => {
        if (failDailyGet && key === 'dailyClosures') throw new Error('storage read failed')
        if (key === 'dailyClosures' && closed.length > 0) reads.afterClose += 1
        if (failDailyGetAfterClose && key === 'dailyClosures' && closed.length > 0) {
          throw new Error('storage read failed after close')
        }
        return store.get(key) ?? null
      },
      set: (key, value) => {
        if (key === 'dailyClosures' && dailyFailing) {
          if (syncDailySet) throw new Error('storage full')
          return Promise.reject(new Error('storage full'))
        }
        if (key === 'dailyClosures') writes.push(JSON.parse(JSON.stringify(value)))
        store.set(key, value)
        return Promise.resolve()
      }
    },
    settings: { get: async (key) => values[key], onDidChange(callback) { changeHandlers.push(callback) } },
    log: (message) => logs.push(message)
  }, {
    platform: 'linux',
    now: () => time,
    schedule: (callback) => { poll = callback },
    callCli: async (area, command, ...args) => {
      if (area === 'automations' && command === 'runs') return { runs }
      if (area === 'automations' && command === 'list') {
        return { automations: [{ id: 'automation-1', name: 'Manutenção' }] }
      }
      if (area === 'diagnostics' && command === 'memory') {
        onMemory?.(state, values)
        return memorySessions
          ? { processMemoryMetric: 'rss', worktrees: [{ worktreeId: 'workspace-1', sessions: memorySessions }] }
          : { processMemoryMetric: 'none' }
      }
      if (command === 'list') {
        if (state.failNextList) {
          state.failNextList = false
          throw new Error('list unavailable')
        }
        if (malformedList) return { truncated: false }
        if (failListAfterClose && closed.length > 0 && postCloseLists++ === 0) throw new Error('list failed')
        if (malformedListAfterClose && closed.length > 0) return { truncated: false }
        return { terminals: state.terminals, truncated: false }
      }
      if (command === 'wait') return { wait: { satisfied: idle } }
      assert.equal(command, 'close')
      onClose?.((ms) => { time += ms })
      if (failClose) {
        if (closeFailsAfterRemoval) state.terminals = state.terminals.filter((row) => row.handle !== args[1])
        throw new Error('close failed')
      }
      closed.push(args[1])
      if (!keepAfterClose) state.terminals = state.terminals.filter((row) => row.handle !== args[1])
      return { close: closeReceipt }
    }
  })
  return {
    state, closed, status, logs, store, emit, fire: () => poll(),
    writes, reads, setDailyFailing: (value) => { dailyFailing = value },
    tick: async (ms) => { time += ms; await poll() }
  }
}

test('fecha execução antiga sem PTY no histórico após três minutos', async () => {
  const f = await fixture()
  await f.tick(179_999)
  assert.deepEqual(f.closed, [])
  await f.tick(1)
  assert.deepEqual(f.closed, ['term_1'])
  assert.match(f.status.at(-1).text, /1 aba fechada/)
  assert.equal(f.store.get('closureHistory')[0].outcome, 'Processo encerrado')
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
  let changed = false
  const f = await fixture({
    onMemory: (state) => {
      if (changed) return
      changed = true
      state.terminals = state.terminals.map((row) => ({ ...row, lastOutputAt: 2 }))
    }
  })
  await f.tick(180_000)
  assert.deepEqual(f.closed, [])
  await f.tick(60_000)
  assert.deepEqual(f.closed, [])
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
})

test('fecha na primeira varredura quando o prazo é zero', async () => {
  const f = await fixture({ idleMinutes: 0 })
  assert.deepEqual(f.closed, ['term_1'])
})

test('execução perdida fecha após confirmar ociosidade', async () => {
  const f = await fixture({ runs: [lost] })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
})

test('execução perdida não fecha se o terminal não ficar ocioso', async () => {
  const f = await fixture({ runs: [lost], idle: false })
  await f.tick(180_000)
  await f.tick(600_000)
  assert.deepEqual(f.closed, [])
})

test('execução perdida respeita desligar a observação de execuções sem vínculo', async () => {
  const f = await fixture({ runs: [lost], settings: { cleanupUnobservedRuns: false } })
  await f.tick(600_000)
  assert.deepEqual(f.closed, [])
})

test('falha no close não conta nem registra o fechamento e espera nova carência', async () => {
  const f = await fixture({ failClose: true })
  const failures = () => f.logs.filter((line) => line.includes('Falha ao fechar')).length
  await f.tick(180_000)
  assert.equal(failures(), 1)
  assert.equal(f.store.get('dailyClosures'), undefined)
  await f.tick(60_000)
  assert.equal(failures(), 1)
  await f.tick(180_000)
  assert.equal(failures(), 2)
})

test('não registra quando o processo não é encerrado e espera nova carência antes de tentar de novo', async () => {
  const f = await fixture({ closeReceipt: { ptyKilled: false }, keepAfterClose: true })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
  assert.equal(f.store.get('dailyClosures'), undefined)
  assert.equal(f.store.get('closureHistory'), undefined)
  assert.ok(f.logs.some((line) => line.includes('não confirmado')))
  await f.tick(60_000)
  assert.equal(f.closed.length, 1)
  await f.tick(180_000)
  assert.equal(f.closed.length, 2)
})

test('registra o fechamento mesmo se a listagem posterior falhar', async () => {
  const f = await fixture({ failListAfterClose: true })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
  assert.equal(f.store.get('dailyClosures').count, 1)
  assert.equal(f.store.get('closureHistory').length, 1)
  assert.match(f.status.at(-1).text, /1 aba fechada/)
})

test('conta fechamento confirmado pelo Orca mesmo se a listagem ainda mostrar o terminal', async () => {
  const f = await fixture({ keepAfterClose: true })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
  assert.equal(f.store.get('dailyClosures').count, 1)
  assert.equal(f.store.get('closureHistory').length, 1)
})

test('não conta duas vezes o mesmo terminal enquanto ele seguir listado', async () => {
  const f = await fixture({ keepAfterClose: true })
  await f.tick(180_000)
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
  assert.equal(f.store.get('dailyClosures').count, 1)
  assert.equal(f.store.get('closureHistory').length, 1)
})

test('listagem inesperada no início vira falha de listagem com aviso claro', async () => {
  const f = await fixture({ malformedList: true })
  assert.match(f.status.at(-1).text, /indisponível/)
  assert.ok(f.logs.some((line) => /resposta inesperada/i.test(line)))
  assert.deepEqual(f.closed, [])
})

test('mantém a contagem em memória se a gravação falhar', async () => {
  const f = await fixture({ failDailySet: true })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
  assert.match(f.status.at(-1).text, /1 aba fechada hoje/)
  assert.equal(f.store.get('dailyClosures'), undefined)
})

test('grava a contagem pendente na varredura seguinte quando a gravação volta', async () => {
  const f = await fixture({ failDailySet: true })
  await f.tick(180_000)
  assert.equal(f.store.get('dailyClosures'), undefined)
  f.setDailyFailing(false)
  await f.tick(60_000)
  assert.equal(f.store.get('dailyClosures').count, 1)
})

test('não conta fechamento quando o close falha, mesmo se o terminal saiu da lista', async () => {
  const f = await fixture({ failClose: true, closeFailsAfterRemoval: true })
  await f.tick(180_000)
  assert.equal(f.store.get('dailyClosures'), undefined)
  assert.equal(f.store.get('closureHistory'), undefined)
  assert.ok(f.logs.some((line) => line.includes('sem prova de encerramento')))
})

test('disparo do timer durante uma varredura lenta não agenda outra varredura', async () => {
  const f = await fixture({ onMemory: () => { void f.fire() } })
  await f.tick(180_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.status.length, 2)
})

test('avisa uma vez quando a gravação do contador falha seguidamente', async () => {
  const f = await fixture({ failDailySet: true })
  await f.tick(180_000)
  await f.tick(60_000)
  await f.tick(60_000)
  assert.equal(f.logs.filter((line) => line.includes('Não foi possível salvar o contador diário')).length, 1)
})

test('descarta dias pendentes em viradas seguidas sem gravação', async () => {
  const runs = [completed]
  const other = { ...terminal, handle: 'term_2', ptyId: 'pty-2', tabId: 'tab-2', leafId: 'leaf-2', incarnationId: 'instance-2' }
  const completedOther = { ...completed, id: 'run-2', terminalPaneKey: 'tab-2:leaf-2' }
  const f = await fixture({ runs, failDailySet: true })
  await f.tick(180_000) // dia A: term_1 fecha, gravação falha
  runs.push(completedOther)
  f.state.terminals.push(other)
  await f.tick(86_400_000) // dia A+1: virada, dia A fica pendente; term_2 começa a ser observado
  await f.tick(180_000) // dia A+1: term_2 fecha, gravação falha
  await f.tick(86_400_000) // dia A+2: virada, dia A+1 fica pendente
  f.setDailyFailing(false)
  await f.tick(60_000)
  // A contagem do dia anterior não gravada não é recuperada; só o dia atual, sem contagem, existe no storage.
  assert.deepEqual(f.writes, [])
  assert.match(f.status.at(-1).tooltip, /Um dia sem gravação foi descartado/)
})

test('falha na revalidação de um terminal não reinicia a carência dos outros', async () => {
  const runs = [completed, { ...completed, id: 'run-2', terminalPaneKey: 'tab-2:leaf-2' }]
  const other = { ...terminal, handle: 'term_2', ptyId: 'pty-2', tabId: 'tab-2', leafId: 'leaf-2', incarnationId: 'instance-2' }
  let armed = false
  const f = await fixture({
    runs,
    terminals: [terminal, other],
    onMemory: (state) => {
      if (armed) return
      armed = true
      state.failNextList = true
    }
  })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_2'])
  await f.tick(60_000)
  assert.deepEqual(f.closed, ['term_2', 'term_1'])
})

test('mudança de configuração durante uma varredura gera nova varredura ao terminar', async () => {
  let changed = false
  const f = await fixture({
    onStatus: (_value, emit, values) => {
      if (changed) return
      changed = true
      values.showCounter = false
      emit('showCounter')
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.status.length, 2)
  assert.equal(f.status.at(-1).visible, false)
})

test('não fecha se não consegue ler o contador', async () => {
  const f = await fixture({ failDailyGet: true })
  await f.tick(180_000)
  assert.deepEqual(f.closed, [])
  assert.match(f.status.at(-1).text, /indisponível/)
})

test('grava o histórico mesmo se o storage lançar de forma síncrona ao salvar o contador', async () => {
  const f = await fixture({ failDailySet: true, syncDailySet: true })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
  assert.equal(f.store.get('closureHistory').length, 1)
  assert.match(f.status.at(-1).text, /1 aba fechada hoje/)
})

test('não conta sem prova de encerramento quando o terminal sai da lista depois', async () => {
  const f = await fixture({ closeReceipt: { ptyKilled: false }, failListAfterClose: true })
  await f.tick(180_000)
  assert.deepEqual(f.closed, ['term_1'])
  await f.tick(60_000)
  assert.equal(f.closed.length, 1)
  assert.equal(f.store.get('dailyClosures'), undefined)
  assert.equal(f.store.get('closureHistory'), undefined)
})

test('tenta de novo após nova carência se o processo segue listado e a listagem falhou', async () => {
  const f = await fixture({ closeReceipt: { ptyKilled: false }, failListAfterClose: true, keepAfterClose: true })
  await f.tick(180_000)
  assert.equal(f.closed.length, 1)
  await f.tick(60_000)
  assert.equal(f.closed.length, 1)
  await f.tick(180_000)
  assert.equal(f.closed.length, 2)
  assert.equal(f.store.get('dailyClosures'), undefined)
})

test('tooltip separa o terminal já fechado que o Orca ainda lista dos demais listados', async () => {
  const f = await fixture({ keepAfterClose: true })
  await f.tick(180_000)
  assert.match(f.status.at(-1).tooltip, /0 terminais com automação na varredura \(1 já fechado pela limpeza\)/)
})

test('falha de leitura do contador só depois do close não perde a contagem', async () => {
  // Com prazo zero, a primeira varredura fecha logo após carregar o contador antes do close.
  // Depois do close, nenhuma leitura de dailyClosures pode ocorrer: a contagem vem do cache.
  const f = await fixture({ idleMinutes: 0, failDailyGetAfterClose: true })
  assert.deepEqual(f.closed, ['term_1'])
  assert.equal(f.reads.afterClose, 0)
  assert.equal(f.store.get('dailyClosures').count, 1)
  assert.equal(f.store.get('closureHistory').length, 1)
})

test('virada durante o close descarta o dia anterior sem gravação e grava só o atual', async () => {
  const runs = [completed]
  const other = { ...terminal, handle: 'term_2', ptyId: 'pty-2', tabId: 'tab-2', leafId: 'leaf-2', incarnationId: 'instance-2' }
  const completedOther = { ...completed, id: 'run-2', terminalPaneKey: 'tab-2:leaf-2' }
  let closes = 0
  const f = await fixture({
    runs,
    failDailySet: true,
    onClose: (advance) => {
      closes += 1
      if (closes === 2) advance(2 * 86_400_000)
    }
  })
  await f.tick(180_000) // dia A: term_1 fecha, gravação falha
  runs.push(completedOther)
  f.state.terminals.push(other)
  await f.tick(180_000) // term_2 passa a ser observado
  await f.tick(180_000) // term_2 fecha e a virada acontece durante o close
  f.setDailyFailing(false)
  await f.tick(60_000)
  assert.deepEqual(f.writes.map((w) => [w.day, w.count]), [
    [new Date(540_000 + 2 * 86_400_000).toLocaleDateString('en-CA'), 1]
  ])
  assert.match(f.status.at(-1).tooltip, /Um dia sem gravação foi descartado/)
})

test('fechamento que cruza a meia-noite é contado no dia em que terminou', async () => {
  let crossed = false
  const f = await fixture({
    onClose: (advance) => {
      if (crossed) return
      crossed = true
      advance(2 * 86_400_000)
    }
  })
  await f.tick(180_000)
  assert.equal(f.store.get('dailyClosures').day, new Date(180_000 + 2 * 86_400_000).toLocaleDateString('en-CA'))
  assert.equal(f.store.get('dailyClosures').count, 1)
})

test('trata listagem posterior malformada como falha de listagem', async () => {
  const f = await fixture({ malformedListAfterClose: true })
  await f.tick(180_000)
  assert.equal(f.store.get('dailyClosures').count, 1)
  assert.equal(f.store.get('closureHistory').length, 1)
  assert.match(f.status.at(-1).text, /1 aba fechada/)
})

test('desligar a limpeza no meio da varredura não pula outras sessões', async () => {
  // A automação vem primeiro na lista: com break, as duas outras sessões seriam puladas.
  const other = { ...terminal, handle: 'term_2', ptyId: 'pty-2', tabId: 'tab-2', leafId: 'leaf-2', incarnationId: 'instance-2' }
  const other2 = { ...terminal, handle: 'term_3', ptyId: 'pty-3', tabId: 'tab-3', leafId: 'leaf-3', incarnationId: 'instance-3' }
  let disabled = false
  const f = await fixture({
    terminals: [terminal, other, other2],
    settings: { otherObservationEnabled: true, otherIdleMinutes: 0 },
    onMemory: (_state, values) => {
      if (disabled) return
      disabled = true
      values.automationCleanupEnabled = false
    }
  })
  await f.tick(180_000)
  assert.deepEqual(f.closed, [])
  assert.match(f.status.at(-1).tooltip, /Limpeza pausada/)
  assert.match(f.status.at(-1).tooltip, /2 de 2 outras sessões/)
})

test('mede RAM e grava o total e o histórico', async () => {
  const f = await fixture({
    memorySessions: [{ sessionId: 'pty-1', paneKey: 'tab-1:leaf-1', memory: 123456 }]
  })
  await f.tick(180_000)
  const daily = f.store.get('dailyClosures')
  assert.equal(daily.memoryBytes, 123456)
  assert.equal(daily.measuredCount, 1)
  assert.equal(f.store.get('closureHistory')[0].estimatedMemoryBytes, 123456)
})

test('automação desligada não fecha nada', async () => {
  const f = await fixture({ settings: { automationCleanupEnabled: false } })
  await f.tick(600_000)
  assert.deepEqual(f.closed, [])
  assert.match(f.status.at(-1).tooltip, /Limpeza pausada/)
})

test('outras sessões são destacadas e nunca fechadas', async () => {
  const f = await fixture({
    runs: [],
    settings: { otherObservationEnabled: true, otherIdleMinutes: 0 }
  })
  assert.match(f.status.at(-1).tooltip, /1 de 1 outras sessões/)
  assert.match(f.status.at(-1).tooltip, /0 terminais com automação na varredura/)
  await f.tick(180_000)
  assert.deepEqual(f.closed, [])
})

test('ignora minutos inválidos de outras sessões e usa o padrão de 15', async () => {
  const f = await fixture({
    runs: [],
    settings: { otherObservationEnabled: true, otherIdleMinutes: -1 }
  })
  await f.tick(180_000)
  assert.match(f.status.at(-1).tooltip, /0 de 1 outras sessões/)
  assert.deepEqual(f.closed, [])
})
