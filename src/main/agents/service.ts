import { randomUUID } from 'crypto'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PushChannel, PushContract } from '@shared/ipc'
import type { AgentEvent, AgentId, ChatItem, RouteDecision, RunInfo, RunStatus, SessionMeta, SessionTotals } from '@shared/types'
import { UNRESTRICTED } from '@shared/types'
import { finalizeTurn, reduceEvent, titleFromPrompt } from '@shared/chat'
import type { Store } from '../db/store'
import type { Adapter, Parser } from './types'
import { killGroup, ManagedProcess, pidMatches } from './runner'

export interface ServiceDeps {
  store: Store
  push: <K extends PushChannel>(channel: K, payload: PushContract[K]) => void
  adapters: Record<AgentId, Adapter>
  resolveBin: (agent: AgentId) => string | undefined
  env: () => NodeJS.ProcessEnv
  // modelo a usar cuando la conversación no fija uno (p. ej. si config.toml de Codex apunta a uno inválido)
  defaultModel: (agent: AgentId) => string | undefined
  allowUnrestricted: () => boolean
  extraArgs?: (agent: AgentId) => string[]
  // comprueba que una imagen adjunta es de la app y devuelve su ruta real
  checkImage?: (path: string) => string
  // foto de los ficheros de la carpeta (tree de Git) antes y después de cada turno, para poder deshacerlo
  checkpoint?: (cwd: string) => Promise<string | null>
  forkIfLive?: (agent: AgentId, agentSessionId: string) => boolean
  // herramientas extra del turno (p. ej. la Web del proyecto por MCP): argumentos, entorno y cómo retirarlas al acabar
  tools?: (ctx: { projectId: string; runId: string; agent: AgentId }) => { extra: string[]; env: Record<string, string>; allowedTools?: string[]; release: () => void } | undefined
  onFinished?: (run: RunInfo, session: SessionMeta) => void
  // la conversación ha quedado libre (para procesar la cola)
  onIdle?: (session: SessionMeta) => void
  uiThrottleMs?: number
  dbThrottleMs?: number
  cancelGraceMs?: number
}

interface ActiveRun {
  id: string
  sessionId: string
  projectId: string
  agent: AgentId
  cwd: string
  startedAt: number
  proc?: ManagedProcess
  items: ChatItem[] // turno actual, empezando por el mensaje del usuario
  seqOf: Map<string, number>
  nextSeq: number
  dirtyUi: Map<string, ChatItem>
  dirtyDb: Map<string, ChatItem>
  uiTimer?: NodeJS.Timeout
  dbTimer?: NodeJS.Timeout
  stderrTail: string
  totals: SessionTotals
  lastText: string
  structured?: unknown
  schemaFile?: string
  // detenida antes de que llegara a arrancar el proceso
  cancelled?: boolean
  releaseTools?: () => void
  resolve: (o: RunOutcome) => void
}

export interface RunOutcome {
  runId: string
  sessionId: string
  status: RunStatus
  // último mensaje del agente en el turno
  text: string
  structured?: unknown
  error?: string
}

export interface SendOptions {
  schema?: object
  route?: RouteDecision
  allowedTools?: string[]
  images?: string[]
}

const NEW_TITLE = 'Nueva conversación'

export class SessionService {
  private active = new Map<string, ActiveRun>() // sessionId → ejecución

  constructor(private d: ServiceDeps) {}

  isRunning(sessionId: string) {
    return this.active.has(sessionId)
  }

  runningCount() {
    return this.active.size
  }

  withRunState(s: SessionMeta): SessionMeta {
    const run = this.active.get(s.id)
    return run ? { ...s, running: true, runId: run.id } : s
  }

  listSessions(projectId: string): SessionMeta[] {
    return this.d.store.listSessions(projectId).map((s) => this.withRunState(s))
  }

  getSession(id: string): SessionMeta | undefined {
    const s = this.d.store.getSession(id)
    return s && this.withRunState(s)
  }

  // ---------- envío ----------

  // `context` (fichero abierto, selección…) se envía al agente pero se guarda aparte del texto del usuario
  send(sessionId: string, prompt: string, context?: string, opts: SendOptions = {}): { runId: string; done: Promise<RunOutcome> } {
    const { store } = this.d
    const session = store.getSession(sessionId)
    if (!session) throw new Error('Conversación no encontrada')
    if (this.active.has(sessionId)) throw new Error('El agente ya está trabajando en esta conversación')
    if (!prompt.trim()) throw new Error('El mensaje está vacío')
    if (!existsSync(session.cwd)) throw new Error(`La carpeta de trabajo ya no existe: ${session.cwd}`)
    if (session.permission && UNRESTRICTED.includes(session.permission) && !this.d.allowUnrestricted())
      throw new Error('Los modos sin restricciones están desactivados en Ajustes')
    const adapter = this.d.adapters[session.agent]
    const bin = this.d.resolveBin(session.agent)
    if (!bin) throw new Error(`No se encontró el CLI de ${session.agent === 'claude' ? 'Claude Code' : 'Codex'}. Revisa la ruta en Ajustes.`)

    const images = (opts.images ?? []).slice(0, 10).map((p) => {
      if (!this.d.checkImage) throw new Error('Esta conversación no admite imágenes')
      return this.d.checkImage(p)
    })
    const now = Date.now()
    const runId = randomUUID()
    let schema: { json: string; file: string } | undefined
    if (opts.schema) {
      const json = JSON.stringify(opts.schema)
      const file = join(tmpdir(), `ambidex-schema-${runId}.json`)
      writeFileSync(file, json)
      schema = { json, file }
    }
    const tools = this.d.tools?.({ projectId: session.projectId, runId, agent: session.agent })
    const req = {
      cwd: session.cwd,
      resumeId: session.agentSessionId,
      model: session.model || this.d.defaultModel(session.agent),
      effort: session.effort,
      permission: session.permission,
      schema,
      extra: [...(this.d.extraArgs?.(session.agent) ?? []), ...(tools?.extra ?? [])],
      allowedTools: opts.allowedTools || tools?.allowedTools ? [...(opts.allowedTools ?? []), ...(tools?.allowedTools ?? [])] : undefined,
      images: images.length ? images : undefined,
      fork: !!session.agentSessionId && !!this.d.forkIfLive?.(session.agent, session.agentSessionId)
    }
    const args = adapter.buildArgs(req)
    const text = context ? `${prompt}\n\n${context}` : prompt
    let resolve!: (o: RunOutcome) => void
    const done = new Promise<RunOutcome>((r) => (resolve = r))

    const run: ActiveRun = {
      id: runId,
      sessionId,
      projectId: session.projectId,
      agent: session.agent,
      cwd: session.cwd,
      startedAt: now,
      items: [],
      seqOf: new Map(),
      nextSeq: store.nextSeq(sessionId),
      dirtyUi: new Map(),
      dirtyDb: new Map(),
      stderrTail: '',
      totals: { ...session.totals },
      lastText: '',
      schemaFile: schema?.file,
      releaseTools: tools?.release,
      resolve
    }
    this.active.set(sessionId, run)

    const user: ChatItem = { id: randomUUID(), type: 'user', text: prompt, context: context || undefined, route: opts.route, images: req.images, at: now }
    this.track(run, [user], true)
    store.updateSession(sessionId, {
      title: session.messageCount === 0 && session.title === NEW_TITLE ? titleFromPrompt(prompt) : undefined,
      updatedAt: now
    })
    // el prompt no se guarda en los argumentos: va por stdin
    store.createRun({ id: runId, sessionId, projectId: session.projectId, agent: session.agent, cwd: session.cwd, bin, args, startedAt: now })
    store.audit(session.projectId, 'user', 'agent.run', { agent: session.agent, sessionId, runId, permission: session.permission ?? null })
    this.flushUi(run)
    this.pushMeta(sessionId)

    const parser = adapter.createParser()
    const start = () => {
      if (run.cancelled) return this.finish(run, { code: null, signal: null, cancelled: true })
      this.startProcess(run, parser, { bin, args, cwd: session.cwd, stdin: adapter.stdin ? adapter.stdin(text, req) : text, env: tools?.env }, adapter)
    }
    // foto de cómo están los ficheros antes de que el agente toque nada
    if (this.d.checkpoint)
      this.d
        .checkpoint(session.cwd)
        .then((tree) => tree && store.setCheckpoint(runId, 'before', tree))
        .catch(() => {})
        .finally(start)
    else start()
    return { runId, done }
  }

  private startProcess(run: ActiveRun, parser: Parser, spec: { bin: string; args: string[]; cwd: string; stdin: string; env?: Record<string, string> }, adapter: Adapter) {
    const { store } = this.d
    const runId = run.id
    try {
      run.proc = new ManagedProcess(
        { bin: spec.bin, args: spec.args, cwd: spec.cwd, stdin: spec.stdin, env: { ...this.d.env(), ...spec.env } },
        {
          onStdout: (line) => {
            if (!line.includes('"content_block_delta"')) store.appendLog(runId, 'event', line)
            for (const ev of parser.onLine(line)) this.apply(run, ev)
          },
          onStderr: (line) => {
            store.appendLog(runId, 'stderr', line)
            if (!adapter.isNoise(line)) run.stderrTail = (run.stderrTail + line + '\n').slice(-4000)
          }
        }
      )
    } catch (e) {
      this.finish(run, { code: null, signal: null, cancelled: false, spawnError: (e as Error).message })
      return
    }
    if (run.proc.pid) store.setRunPid(runId, run.proc.pid)
    this.d.push('run:status', this.runInfo(run, 'running'))

    run.proc.done.then(async (exit) => {
      try {
        for (const ev of (await parser.onExit?.()) ?? []) this.apply(run, ev)
      } catch {
        /* los límites son opcionales */
      }
      this.finish(run, exit)
    })
  }

  async cancel(sessionId: string) {
    const run = this.active.get(sessionId)
    if (!run) return
    // aún no había arrancado (estaba haciendo la foto de los ficheros): ya no arrancará
    if (!run.proc) return void (run.cancelled = true)
    this.d.store.audit(run.projectId, 'user', 'agent.cancel', { sessionId, runId: run.id })
    await run.proc.cancel(this.d.cancelGraceMs)
  }

  async cancelAll() {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)))
  }

  // ---------- eventos ----------

  private apply(run: ActiveRun, ev: AgentEvent) {
    const { store } = this.d
    if (ev.kind === 'limits') {
      store.saveLimits(ev.limits)
      this.d.push('limits', ev.limits)
      return
    }
    if (ev.kind === 'structured') {
      run.structured = ev.data
      return
    }
    if (ev.kind === 'text' && !ev.streaming) run.lastText = ev.text
    const res = reduceEvent(run.items, ev, { cwd: run.cwd, newId: randomUUID, now: Date.now() })
    if (res.agentSessionId) store.updateSession(run.sessionId, { agentSessionId: res.agentSessionId })
    if (res.usage) {
      const t = run.totals
      run.totals = {
        input: t.input + res.usage.inputTokens,
        output: t.output + res.usage.outputTokens,
        cached: t.cached + res.usage.cachedTokens,
        cost: t.cost + (res.usage.costUsd ?? 0),
        turns: t.turns + 1,
        ms: t.ms + (res.usage.durationMs ?? 0)
      }
    }
    this.track(run, res.changed, false)
  }

  // Asigna orden a los elementos nuevos y los marca para guardar y enviar a la UI
  private track(run: ActiveRun, items: ChatItem[], immediate: boolean) {
    for (const it of items) {
      if (it.type === 'user') run.items.push(it)
      if (!run.seqOf.has(it.id)) run.seqOf.set(it.id, run.nextSeq++)
      run.dirtyUi.set(it.id, it)
      const streaming = it.type === 'assistant' && it.streaming
      if (streaming && !immediate) run.dirtyDb.set(it.id, it)
      else {
        run.dirtyDb.delete(it.id)
        this.d.store.upsertMessage(run.sessionId, run.seqOf.get(it.id)!, run.id, it)
      }
    }
    if (!run.uiTimer) run.uiTimer = setTimeout(() => this.flushUi(run), this.d.uiThrottleMs ?? 40)
    if (run.dirtyDb.size && !run.dbTimer) run.dbTimer = setTimeout(() => this.flushDb(run), this.d.dbThrottleMs ?? 400)
  }

  private flushUi(run: ActiveRun) {
    if (run.uiTimer) clearTimeout(run.uiTimer)
    run.uiTimer = undefined
    if (!run.dirtyUi.size) return
    const items = [...run.dirtyUi.values()].sort((a, b) => run.seqOf.get(a.id)! - run.seqOf.get(b.id)!)
    run.dirtyUi.clear()
    this.d.push('session:items', { projectId: run.projectId, sessionId: run.sessionId, items })
  }

  private flushDb(run: ActiveRun) {
    if (run.dbTimer) clearTimeout(run.dbTimer)
    run.dbTimer = undefined
    for (const it of run.dirtyDb.values()) this.d.store.upsertMessage(run.sessionId, run.seqOf.get(it.id)!, run.id, it)
    run.dirtyDb.clear()
  }

  private finish(run: ActiveRun, exit: { code: number | null; signal: NodeJS.Signals | null; cancelled: boolean; spawnError?: string }) {
    const { store } = this.d
    const now = Date.now()
    const changed = finalizeTurn(run.items, exit.cancelled)
    const hasError = run.items.some((i) => i.type === 'error')
    let error: string | undefined
    if (exit.spawnError) error = `No se pudo lanzar el CLI: ${exit.spawnError}`
    else if (!exit.cancelled && exit.code !== 0) {
      const tail = run.stderrTail.trim().split('\n').slice(-6).join('\n')
      error = tail || `El proceso terminó con código ${exit.code ?? exit.signal}`
    }
    const extra: ChatItem[] = []
    if (exit.cancelled) extra.push({ id: randomUUID(), type: 'notice', text: 'Detenido', at: now })
    else if (error && !hasError) extra.push({ id: randomUUID(), type: 'error', text: error, at: now })
    run.items.push(...extra)
    this.track(run, [...changed, ...extra], true)
    this.flushDb(run)
    this.flushUi(run)

    run.releaseTools?.()
    const status: RunStatus = exit.cancelled ? 'cancelled' : exit.code === 0 && !exit.spawnError ? 'completed' : 'failed'
    store.finishRun(run.id, {
      status,
      endedAt: now,
      exitCode: exit.code,
      signal: exit.signal,
      error: error ?? (hasError ? (run.items.find((i) => i.type === 'error') as { text: string }).text.slice(0, 2000) : undefined),
      stderrTail: run.stderrTail || undefined
    })
    store.updateSession(run.sessionId, { totals: run.totals, updatedAt: now })
    this.active.delete(run.sessionId)
    const info = { ...this.runInfo(run, status), endedAt: now, exitCode: exit.code }
    this.d.push('run:status', info)
    const meta = this.pushMeta(run.sessionId)
    if (run.schemaFile) rmSync(run.schemaFile, { force: true })
    run.resolve({ runId: run.id, sessionId: run.sessionId, status, text: run.lastText, structured: run.structured, error })
    const next = () => {
      if (!meta) return
      this.d.onFinished?.(info, meta)
      this.d.onIdle?.(meta)
    }
    // foto de después (antes de pasar al siguiente mensaje de la cola, que volvería a tocar los ficheros)
    if (this.d.checkpoint && store.checkpoint(run.id)?.before)
      this.d
        .checkpoint(run.cwd)
        .then((tree) => {
          if (!tree) return
          store.setCheckpoint(run.id, 'after', tree)
          const updated = store.getRun(run.id)
          if (updated) this.d.push('run:status', updated)
        })
        .catch(() => {})
        .finally(next)
    else next()
  }

  private runInfo(run: ActiveRun, status: RunStatus): RunInfo {
    return {
      id: run.id,
      sessionId: run.sessionId,
      projectId: run.projectId,
      agent: run.agent,
      status,
      startedAt: run.startedAt,
      pid: run.proc?.pid,
      sessionTitle: this.d.store.getSession(run.sessionId)?.title
    }
  }

  private pushMeta(sessionId: string): SessionMeta | undefined {
    const s = this.getSession(sessionId)
    if (s) this.d.push('session:meta', s)
    return s
  }

  // ---------- recuperación tras un cierre inesperado ----------

  // Las ejecuciones que quedaron "running" en la base de datos ya no tienen quien lea su salida:
  // se marcan como interrumpidas y, si el proceso sigue vivo, se termina.
  recoverInterrupted(matches: (pid: number, bin: string | null) => boolean = pidMatches): number {
    const { store } = this.d
    const runs = store.runningRuns().filter((r) => ![...this.active.values()].some((a) => a.id === r.id))
    const now = Date.now()
    for (const r of runs) {
      let killed = false
      if (r.pid && matches(r.pid, r.bin)) {
        killGroup(r.pid, 'SIGKILL')
        killed = true
      }
      const rows = store.messagesForRun(r.id)
      const items = rows.map((x) => x.item)
      const seqOf = new Map(rows.map((x) => [x.item.id, x.seq]))
      const changed = finalizeTurn(items, true)
      for (const it of changed) store.upsertMessage(r.sessionId, seqOf.get(it.id)!, r.id, it)
      const notice: ChatItem = {
        id: randomUUID(),
        type: 'notice',
        text: killed
          ? 'Ejecución interrumpida: la aplicación se cerró y el proceso del agente se ha terminado.'
          : 'Ejecución interrumpida: la aplicación se cerró antes de que terminara.',
        at: now
      }
      store.upsertMessage(r.sessionId, store.nextSeq(r.sessionId), r.id, notice)
      store.finishRun(r.id, { status: 'interrupted', endedAt: now, exitCode: null, signal: null, error: 'La aplicación se cerró durante la ejecución' })
      store.audit(r.projectId, 'system', 'agent.interrupted', { runId: r.id, pid: r.pid ?? null, killed })
    }
    return runs.length
  }
}
