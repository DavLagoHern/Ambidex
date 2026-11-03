import { killGroup, ManagedProcess, type AgentProcess, type ExitInfo, type ProcessHandlers, type ProcessSpec } from './runner'
import { parseJson, type RunRequest } from './types'

class RpcRejectedError extends Error {}

// El app-server conserva el turno abierto; turn/steer añade entrada al mismo turno.
// Traducimos sus notificaciones al formato de exec para compartir el parser y la persistencia.
export class CodexLiveProcess implements AgentProcess {
  private proc: ManagedProcess
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private threadId?: string
  private turnId?: string
  private closing = false
  private completed = false
  private cancelled = false
  private failed = false
  private usage: Record<string, number> = {}
  private baseUsage?: Record<string, number>
  private ready: Promise<void>
  readonly done: Promise<ExitInfo>

  constructor(spec: ProcessSpec, private req: RunRequest, private handlers: ProcessHandlers) {
    this.proc = new ManagedProcess({ ...spec, stdin: '', keepOpen: true }, {
      onStdout: (line) => this.onLine(line),
      onStderr: handlers.onStderr
    })
    this.done = this.proc.done.then((exit) => {
      this.closing = true
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Se cerró la conexión con Codex')) }
      this.pending.clear()
      return (this.completed || this.failed) && !this.cancelled ? { ...exit, code: this.failed ? 1 : 0, signal: null } : exit
    })
    this.ready = this.start(spec.stdin ?? '').catch((e) => {
      if (this.closing) return
      this.emit({ type: 'turn.failed', error: { message: e.message } })
      this.failed = true
      this.shutdown()
    })
  }

  get pid() { return this.proc.pid }
  get inputOpen() { return !this.closing && this.proc.inputOpen }
  write(_data: string) { return false } // el protocolo exige confirmación, no escritura de texto libre
  endInput() { this.shutdown() }
  cancel(graceMs?: number) { this.cancelled = true; this.closing = true; return this.proc.cancel(graceMs) }

  private emit(value: unknown) { this.handlers.onStdout(JSON.stringify(value)) }
  private send(value: unknown) { return this.proc.write(JSON.stringify(value) + '\n') }
  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex no respondió a ${method}`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send({ id, method, params })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('La entrada de Codex está cerrada'))
      }
    })
  }

  private input(text: string, images?: string[]) {
    return [{ type: 'text', text }, ...(images ?? []).map((path) => ({ type: 'localImage', path }))]
  }

  private async start(text: string) {
    await this.request('initialize', { clientInfo: { name: 'ambidex', title: 'Ambidex', version: '0.2.0' } })
    this.send({ method: 'initialized' })
    const r = this.req
    const method = r.resumeId ? r.fork ? 'thread/fork' : 'thread/resume' : 'thread/start'
    const result = await this.request(method, {
      ...(r.resumeId ? { threadId: r.resumeId } : {}),
      cwd: r.cwd, model: r.model, approvalPolicy: 'never', sandbox: r.permission || 'workspace-write'
    })
    this.threadId = result.thread.id
    this.emit({ type: 'thread.started', thread_id: this.threadId })
    const started = await this.request('turn/start', {
      threadId: this.threadId, input: this.input(text, r.images), model: r.model, effort: r.effort
    })
    if (!this.closing) this.turnId = started.turn.id
  }

  async steer(text: string, images?: string[]): Promise<boolean> {
    await this.ready
    if (!this.inputOpen || !this.threadId || !this.turnId) return false
    try {
      const accepted = await this.request('turn/steer', {
        threadId: this.threadId, expectedTurnId: this.turnId, input: this.input(text, images)
      })
      return accepted.turnId === this.turnId
    } catch (e) {
      if (e instanceof RpcRejectedError) return false // rechazo explícito: puede permanecer en cola
      // Nunca reintentamos una entrada cuyo recibo es ambiguo: podría duplicarla.
      throw new Error('Codex no confirmó el mensaje. Revisa el turno antes de reenviarlo.')
    }
  }

  private shutdown() {
    if (this.closing) return
    this.closing = true
    this.proc.endInput()
    // EOF normalmente termina el servidor; limita la espera si quedó un plugin abierto.
    const timer = setTimeout(() => killGroup(this.pid, 'SIGKILL'), 3000)
    void this.proc.done.finally(() => clearTimeout(timer))
  }

  private onLine(line: string) {
    const d = parseJson(line)
    if (!d) return
    if (d.id !== undefined && !d.method) {
      const p = this.pending.get(d.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(d.id)
      if (d.error) p.reject(new RpcRejectedError(d.error.message || 'Error del protocolo de Codex'))
      else p.resolve(d.result)
      return
    }
    // Nunca dejamos al servidor esperando una aprobación que esta interfaz no puede contestar.
    if (d.id !== undefined && d.method) {
      if (/requestApproval$/.test(d.method)) this.send({ id: d.id, result: { decision: 'decline' } })
      else this.send({ id: d.id, error: { code: -32601, message: 'Solicitud interactiva no disponible en Ambidex' } })
      return
    }
    const p = d.params ?? {}
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return
    switch (d.method) {
      case 'turn/started': this.turnId = p.turn.id; break
      case 'item/started':
      case 'item/completed': {
        const i = p.item ?? {}
        const names: Record<string, string> = {
          agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change',
          mcpToolCall: 'mcp_tool_call', collabAgentToolCall: 'collab_tool_call', webSearch: 'web_search'
        }
        this.emit({ type: d.method.replace('/', '.'), item: {
          ...i, type: names[i.type] ?? i.type,
          ...(i.type === 'reasoning' ? { text: (i.summary?.length ? i.summary : i.content ?? []).join('\n') } : {}),
          exit_code: i.exitCode, aggregated_output: i.aggregatedOutput,
          changes: i.changes?.map((c: any) => ({ ...c, kind: typeof c.kind === 'string' ? c.kind : c.kind?.type }))
        } })
        break
      }
      case 'turn/plan/updated':
        this.emit({ type: 'item.updated', item: { type: 'todo_list', items: (p.plan ?? []).map((x: any) => ({ text: x.step, completed: x.status === 'completed' })) } })
        break
      case 'thread/tokenUsage/updated': {
        const { total, last } = p.tokenUsage
        if (!this.baseUsage) this.baseUsage = Object.fromEntries(Object.keys(total).map((k) => [k, total[k] - (last[k] ?? 0)]))
        this.usage = Object.fromEntries(Object.keys(total).map((k) => [k, Math.max(0, total[k] - (this.baseUsage?.[k] ?? 0))]))
        break
      }
      case 'error':
        if (!p.willRetry) this.emit({ type: 'error', message: p.error?.message ?? p.message })
        break
      case 'turn/completed': {
        this.completed = true
        this.failed = p.turn.status !== 'completed'
        if (this.failed) this.emit({ type: 'turn.failed', error: { message: p.turn.error?.message || 'El turno de Codex se interrumpió' } })
        const u = this.usage
        this.emit({ type: 'turn.completed', usage: { input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens, output_tokens: u.outputTokens, reasoning_output_tokens: u.reasoningOutputTokens } })
        this.shutdown()
        break
      }
    }
  }
}
