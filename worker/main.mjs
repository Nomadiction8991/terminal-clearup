import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const interval = 60_000
function minutesOrDefault(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= 999 ? value : fallback
}

async function gracePeriod(orca) {
  return minutesOrDefault(await orca.settings.get('idleMinutes'), 3) * interval
}

function localCli() {
  // O worker roda no executável Electron do Orca, inclusive nas versões portáteis.
  const entry = join(dirname(process.execPath), 'resources', 'app.asar.unpacked', 'out', 'cli', 'index.js')
  try {
    accessSync(entry, constants.R_OK)
    return [process.execPath, entry]
  } catch {
    if (process.platform === 'win32') {
      throw new Error('CLI do Orca não encontrada na instalação do Windows')
    }
    const directories = (process.env.PATH ?? '').split(':').filter(isAbsolute)
    const candidates = [...directories.map((directory) => join(directory, 'orca-ide')),
      join(homedir(), '.local', 'bin', 'orca')]
    for (const executable of candidates) {
      try {
        accessSync(executable, constants.X_OK)
        return [executable]
      } catch {
        // Tenta o próximo launcher.
      }
    }
    throw new Error('CLI do Orca não encontrada')
  }
}

async function cli(...args) {
  const [executable, ...prefix] = localCli()
  const { stdout } = await exec(executable, [
    ...prefix, ...args, '--environment', 'local', '--json'
  ], { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).catch((error) => {
    let code = error.code
    try { code = JSON.parse(error.stdout).error?.code ?? code } catch {}
    throw new Error(`${args.slice(0, 2).join(' ')}: ${code ?? error.signal ?? 'falha'}`)
  })
  const response = JSON.parse(stdout)
  if (!response.ok) throw new Error('O Orca recusou a operação')
  return response.result
}

function paneKey(workspaceId, pane) {
  return JSON.stringify([workspaceId, pane])
}

function indexRuns(runs) {
  const index = new Map()
  for (const run of runs) {
    if (!run.terminalPaneKey) continue
    const key = paneKey(run.workspaceId, run.terminalPaneKey)
    index.set(key, index.has(key) ? null : run)
  }
  return index
}

function owner(index, terminal) {
  const run = index.get(paneKey(terminal.worktreeId, `${terminal.tabId}:${terminal.leafId}`))
  if (!run) return null
  if (run.status !== 'completed' && !lostObservation(run)) return null
  if (run.terminalPtyId != null && run.terminalPtyId !== terminal.ptyId) return null
  return run
}

function lostObservation(run) {
  return run.status === 'dispatch_failed' &&
    run.error === 'Orca stopped watching this run before it reported completion.' &&
    Boolean(run.terminalPtyId)
}

export function startCleanup(orca, {
  callCli = cli,
  now = Date.now,
  schedule = setInterval,
  platform = process.platform
} = {}) {
  let observed = new Map()
  let otherObserved = new Map()
  let daily
  // Dias anteriores com contagem ainda não gravada, na ordem em que a virada aconteceu.
  const unsavedDays = []
  async function dailyTotal() {
    daily ??= await orca.storage.get('dailyClosures')
    const day = new Date(now()).toLocaleDateString('en-CA')
    if (daily?.day !== day) {
      if (dailyDirty) unsavedDays.push(daily)
      daily = { day, count: 0, lastClosedAt: null }
      dailyDirty = false
    }
    return daily
  }
  // Contagem em memória ainda não gravada; persistDaily tenta de novo a cada varredura.
  let dailyDirty = false
  let dailyWarned = false
  async function persistDaily() {
    if (!dailyDirty && unsavedDays.length === 0) return
    try {
      // Dias anteriores vão primeiro, em ordem, para não serem sobrescritos pelo atual.
      while (unsavedDays.length > 0) {
        const pending = unsavedDays[0]
        await Promise.resolve().then(() => orca.storage.set('dailyClosures', pending))
        unsavedDays.shift()
      }
      if (dailyDirty) {
        await Promise.resolve().then(() => orca.storage.set('dailyClosures', daily))
        dailyDirty = false
      }
      dailyWarned = false
    } catch {
      // Um aviso por sequência de falhas; as próximas tentativas são silenciosas.
      if (!dailyWarned) orca.log('Não foi possível salvar o contador diário')
      dailyWarned = true
    }
  }
  let lastInventory = null
  // Terminais (ptyId + incarnação) já contados como fechados e ainda listados pelo Orca.
  const closedInstances = new Set()
  let busy = false
  let rerun = false
  async function poll({ fromSettings = false } = {}) {
    if (busy) {
      // Mudança de configuração durante uma varredura agenda outra ao terminar; disparos do timer são descartados.
      if (fromSettings) rerun = true
      return
    }
    busy = true
    const startedAt = now()
    let calls = 0
    let probeFailures = 0
    let attempted = false
    const query = async (...args) => {
      calls += 1
      try {
        return await callCli(...args)
      } catch (error) {
        probeFailures += 1
        throw error
      }
    }
    const listTerminals = async () => {
      const response = await query('terminal', 'list')
      if (!Array.isArray(response?.terminals)) {
        throw new Error('resposta inesperada ao listar terminais')
      }
      return response
    }
    try {
      if (platform !== 'linux' && platform !== 'win32') {
        observed.clear()
        await orca.host.call('statusBar.update', { id: 'cleanup', visible: false })
        return
      }
      let automationEnabled = (await orca.settings.get('automationCleanupEnabled')) !== false
      const otherEnabled = (await orca.settings.get('otherObservationEnabled')) === true
      const { terminals, truncated } = await listTerminals()
      if (truncated) {
        throw new Error('lista de terminais incompleta; fechamento adiado')
      }
      const { runs } = terminals.length && (automationEnabled || otherEnabled) ? await query('automations', 'runs') : { runs: [] }
      const grace = await gracePeriod(orca)
      const cleanupUnobserved = (await orca.settings.get('cleanupUnobservedRuns')) !== false
      const current = new Map()
      const otherCurrent = new Map()
      const otherMinutes = minutesOrDefault(await orca.settings.get('otherIdleMinutes'), 15)
      const runIndex = indexRuns(runs)
      const listedInstances = new Set(terminals.map((item) => JSON.stringify([item.ptyId, item.incarnationId])))
      let refreshedIndex
      let memorySample
      let otherQuiet = 0
      let automationNames
      async function recordClosure(total, run, outcome, measuredBytes) {
        const next = { ...total, count: total.count + 1, lastClosedAt: new Date(now()).toLocaleTimeString('pt-BR') }
        if (measuredBytes) {
          next.memoryBytes = (total.memoryBytes ?? 0) + measuredBytes
          next.measuredCount = (total.measuredCount ?? 0) + 1
        }
        // A contagem fica em memória mesmo se a gravação falhar; persistDaily tenta de novo nas próximas varreduras.
        daily = next
        dailyDirty = true
        await persistDaily()
        orca.log(`${outcome} · automação ${run.automationId} · execução ${run.id}`)
        try {
          automationNames ??= await query('automations', 'list')
            .then(({ automations }) => new Map(automations.map(({ id, name }) => [id, name])))
            .catch(() => new Map())
          const entries = await orca.storage.get('closureHistory')
          const entry = {
            at: now(),
            name: automationNames.get(run.automationId) || run.title || run.automationId,
            outcome,
            ...(measuredBytes ? { estimatedMemoryBytes: measuredBytes } : {}),
            runId: run.id
          }
          await orca.storage.set('closureHistory', [entry, ...(entries ?? [])].slice(0, 50))
        } catch {
          orca.log(`Não foi possível salvar o histórico da execução ${run.id}`)
        }
      }
      for (const terminal of terminals) {
        if (!terminal.ptyId || !terminal.tabId || !terminal.leafId ||
            !terminal.handle || !terminal.incarnationId || terminal.orphaned) continue
        const pane = paneKey(terminal.worktreeId, `${terminal.tabId}:${terminal.leafId}`)
        if (otherEnabled && !runIndex.has(pane)) {
          const key = JSON.stringify([terminal.handle, terminal.incarnationId, terminal.lastOutputAt])
          const since = otherObserved.get(key) ?? now()
          otherCurrent.set(key, since)
          if (now() - since >= otherMinutes * interval) otherQuiet += 1
        }
        if (!automationEnabled) continue
        const run = owner(runIndex, terminal)
        if (!run) continue
        const instance = JSON.stringify([terminal.ptyId, terminal.incarnationId])
        if (closedInstances.has(instance)) continue
        const needsIdleProof = lostObservation(run)
        if (needsIdleProof && !cleanupUnobserved) continue
        const minimumGrace = needsIdleProof ? 3 * interval : 0
        const key = JSON.stringify([run.id, terminal.handle, terminal.incarnationId, terminal.lastOutputAt])
        const since = observed.get(key) ?? now()
        current.set(key, since)
        if (now() - since < Math.max(grace, minimumGrace)) continue
        if (needsIdleProof) {
          const idle = await query('terminal', 'wait', '--terminal', terminal.handle,
            '--for', 'tui-idle', '--timeout-ms', '1000').catch(() => null)
          if (idle?.wait?.satisfied !== true) continue
        }

        attempted = true
        if (memorySample === undefined) memorySample = await query('diagnostics', 'memory').catch(() => null)
        const memoryRow = ['rss', 'working-set'].includes(memorySample?.processMemoryMetric)
          ? memorySample.worktrees?.find((row) => row.worktreeId === terminal.worktreeId)
            ?.sessions?.find((row) => row.sessionId === terminal.ptyId &&
              row.paneKey === `${terminal.tabId}:${terminal.leafId}`)
          : null
        let freshTerminals
        try {
          refreshedIndex ??= indexRuns((await query('automations', 'runs')).runs)
          freshTerminals = await listTerminals()
        } catch (error) {
          // Falha só deste terminal: ele segue observado e os demais mantêm a contagem da carência.
          orca.log(`Revalidação adiada da execução ${run.id}: ${error.message}`)
          continue
        }
        const live = freshTerminals.terminals.find((item) => item.handle === terminal.handle)
        const refreshedRun = live && owner(refreshedIndex, live)
        if (freshTerminals.truncated || !live || live.orphaned ||
            live.ptyId !== terminal.ptyId ||
            live.incarnationId !== terminal.incarnationId ||
            live.lastOutputAt !== terminal.lastOutputAt ||
            refreshedRun?.id !== run.id ||
            refreshedRun.status !== run.status ||
            (needsIdleProof && (await orca.settings.get('cleanupUnobservedRuns')) === false) ||
            now() - since < Math.max(await gracePeriod(orca), minimumGrace)) {
          current.delete(key)
          continue
        }

        if ((await orca.settings.get('automationCleanupEnabled')) === false) {
          current.clear()
          automationEnabled = false
          continue
        }
        // Lê o contador antes do close: se a leitura falhar, nada é fechado sem registro.
        const total = await dailyTotal()
        let receipt = {}
        let closeFailed = false
        try {
          const result = await query('terminal', 'close', '--terminal', live.handle)
          receipt = result?.close ?? result ?? {}
        } catch (error) {
          // Falha no close não é prova de fechamento: a listagem abaixo só informa, sem contar.
          closeFailed = true
          orca.log(`Falha ao fechar execução ${run.id}: ${error.message}`)
        }
        let after = null
        try {
          const response = await query('terminal', 'list')
          if (Array.isArray(response?.terminals)) after = response
          else orca.log(`Resposta inesperada ao listar terminais após fechar ${run.id}`)
        } catch (error) {
          orca.log(`Não foi possível confirmar o fechamento da execução ${run.id}: ${error.message}`)
        }
        const stillListed = after
          ? after.terminals.some((item) => item.ptyId === live.ptyId && item.incarnationId === live.incarnationId)
          : null
        // ptyKilled é a prova no nível do processo; uma listagem atrasada não pode ocultá-la.
        const closed = !closeFailed && (receipt.ptyKilled === true || (stillListed === false && !after.truncated))
        if (closed) {
          closedInstances.add(instance)
          const measuredBytes = receipt.ptyKilled === true &&
            Number.isFinite(memoryRow?.memory) && memoryRow.memory > 0 ? memoryRow.memory : 0
          await recordClosure(total, run,
            receipt.ptyKilled === true ? 'Processo encerrado' : 'Terminal saiu da lista de ativos', measuredBytes)
        } else {
          orca.log(closeFailed
            ? (stillListed === false
              ? `Terminal saiu da lista após falha do close; sem prova de encerramento, não contado · execução ${run.id}`
              : `Fechamento não confirmado após falha do close · execução ${run.id}`)
            : after === null
              ? `Não foi possível confirmar o encerramento (listagem indisponível) · execução ${run.id}`
              : `Encerramento do processo não confirmado · execução ${run.id}`)
          current.delete(key)
          continue
        }
        current.delete(key)
      }
      observed = current
      otherObserved = otherCurrent
      for (const instance of closedInstances) {
        if (!listedInstances.has(instance)) closedInstances.delete(instance)
      }
      const alreadyClosed = terminals.filter((item) => closedInstances.has(JSON.stringify([item.ptyId, item.incarnationId]))).length
      const inventory = `${terminals.length - alreadyClosed} abertos na varredura · ${current.size} de automação em observação · ${otherQuiet} de ${otherCurrent.size} outras sessões sem saída pelo prazo configurado`
      if (inventory !== lastInventory) {
        orca.log(`Varredura: ${inventory}`)
        lastInventory = inventory
      }
      await persistDaily()
      const { count, lastClosedAt, memoryBytes = 0, measuredCount = 0 } = await dailyTotal()
      const unit = memoryBytes >= 1024 ** 3 ? 'GiB' : 'MiB'
      const memory = measuredCount > 0
        ? `≈ ${(memoryBytes / (unit === 'GiB' ? 1024 ** 3 : 1024 ** 2)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${unit}`
        : 'RAM sem medição'
      const tabs = count === 1 ? '1 aba fechada' : `${count} abas fechadas`
      await orca.host.call('statusBar.update', {
        id: 'cleanup',
        visible: (await orca.settings.get('showCounter')) !== false,
        tone: 'neutral',
        text: `${memory} · ${tabs} hoje`,
        tooltip: `Hoje: ${tabs}. RAM estimada em ${measuredCount} de ${count} fechamentos. ${inventory}.${automationEnabled ? '' : ' Limpeza pausada.'}${
          lastClosedAt ? ` Último fechamento: ${lastClosedAt}.` : ''
        }`
      })
    } catch (error) {
      observed.clear()
      otherObserved.clear()
      orca.log(`Limpeza de automações: ${error.message}`)
      await orca.host.call('statusBar.update', {
        id: 'cleanup', visible: true, text: 'Limpeza de automações indisponível', tone: 'warning'
      }).catch(() => {})
    } finally {
      busy = false
      if (rerun) {
        rerun = false
        void poll()
      }
      if (attempted || probeFailures) {
        orca.log(`Custo da varredura: ${now() - startedAt} ms · ${calls} chamadas à CLI · ${probeFailures} falhas em chamadas`)
      }
    }
  }
  orca.settings.onDidChange(({ key }) => {
    if (key === 'idleMinutes' || key === 'showCounter' || key === 'otherIdleMinutes' ||
        key === 'cleanupUnobservedRuns' || key === 'automationCleanupEnabled' || key === 'otherObservationEnabled') void poll({ fromSettings: true })
  })
  schedule(() => poll(), interval)
  return poll()
}

export default function activate(orca) {
  void startCleanup(orca)
}
