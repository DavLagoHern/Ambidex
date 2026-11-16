import { killGroup, ManagedProcess, type AgentProcess, type ExitInfo, type ProcessHandlers, type ProcessSpec } from './runner'
import { parseJson, type RunRequest } from './types'
import {
  codexApprovalResponse, isApprovalContextValid, isCodexApprovalMethod, isCodexRequestId,
  type CodexApprovalEnd, type CodexApprovalHandler, type CodexApprovalRequest, type CodexRequestId
} from './codex-approvals'

class RpcRejectedError extends Error {}

// El app-server conserva el turno abierto; turn/steer añade entrada al mismo turno.
// Traducimos sus notificaciones al formato de exec para compartir el parser y la persistencia.
export class CodexLiveProcess implements AgentProcess {
  private proc: ManagedProcess
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private approvals = new Map<CodexRequestId, { request: CodexApprovalRequest; abort: AbortController }>()
  private approvalIds = new Set<CodexRequestId>()
  private items = new Map<string, Record<string, unknown>>()
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

  constructor(spec: ProcessSpec, private req: RunRequest, private handlers: ProcessHandlers, private approvalHandler?: CodexApprovalHandler) {
    this.proc = new ManagedProcess({ ...spec, stdin: '', keepOpen: true }, {
      onStdout: (line) => this.onLine(line),
      onStderr: handlers.onStderr
    })
    this.done = this.proc.done.then((exit) => {
      this.closing = true
      this.expireApprovals('process-exited')
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Se cerró la conexión con Codex')) }
      this.pending.clear()
      if (this.cancelled) return { ...exit, cancelled: true }
      if (!this.completed && !this.failed) {
        // Un fallo real conserva stderr, código y señal para que SessionService
        // muestre su causa. Solo un EOF aparentemente correcto necesita aviso.
        if (exit.code !== 0 || exit.spawnError) return exit
        this.failed = true
        this.emit({ type: 'turn.failed', error: { message: 'Codex se cerró antes de completar el turno.' } })
      }
      return { ...exit, code: this.failed ? 1 : 0, signal: null }
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
  cancel(graceMs?: number) {
    this.cancelled = true
    this.closing = true
    this.expireApprovals('cancelled')
    return this.proc.cancel(graceMs)
  }

  private get interactiveApprovals() {
    return !!this.approvalHandler && !this.req.schema && this.req.permission !== 'danger-full-access'
  }

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
      cwd: r.cwd, model: r.model,
      approvalPolicy: this.interactiveApprovals ? 'on-request' : 'never',
      ...(this.interactiveApprovals ? { approvalsReviewer: 'user' } : {}),
      sandbox: r.permission || 'workspace-write'
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
    this.expireApprovals('turn-ended')
    this.proc.endInput()
    // EOF normalmente termina el servidor; limita la espera si quedó un plugin abierto.
    const timer = setTimeout(() => killGroup(this.pid, 'SIGKILL'), 3000)
    void this.proc.done.finally(() => clearTimeout(timer))
  }

  private expireApproval(id: CodexRequestId, reason: CodexApprovalEnd) {
    const pending = this.approvals.get(id)
    if (!pending) return
    this.approvals.delete(id)
    if (reason !== 'answered') pending.abort.abort(reason)
    try { this.approvalHandler?.resolved?.(pending.request, reason) } catch { /* una tarjeta no bloquea el transporte */ }
  }

  private expireApprovals(reason: CodexApprovalEnd) {
    for (const id of this.approvals.keys()) this.expireApproval(id, reason)
    this.items.clear()
  }

  private handleApproval(d: { id: CodexRequestId; method: string; params?: unknown }) {
    if (!isCodexApprovalMethod(d.method)) return false
    if (this.approvalIds.has(d.id)) return true
    this.approvalIds.add(d.id)
    const params = d.params && typeof d.params === 'object' && !Array.isArray(d.params) ? d.params as Record<string, unknown> : {}
    const request: CodexApprovalRequest = {
      id: d.id, method: d.method, params,
      ...(typeof params.itemId === 'string' && this.items.has(params.itemId) ? { item: this.items.get(params.itemId) } : {})
    }
    const deny = () => this.send({ id: d.id, result: codexApprovalResponse(request, { action: 'deny' }) })
    if (!this.interactiveApprovals || !isApprovalContextValid(request, this.threadId, this.turnId)) {
      deny()
      return true
    }
    const abort = new AbortController()
    this.approvals.set(d.id, { request, abort })
    void Promise.resolve().then(() => {
      if (abort.signal.aborted) return
      return this.approvalHandler!.request(request, abort.signal)
    }).then(decision => {
      if (abort.signal.aborted || this.closing) return
      if (!decision || !['allow', 'deny', 'cancel'].includes(decision.action)) throw new Error('Respuesta de permiso no válida')
      const result = codexApprovalResponse(request, decision)
      if (decision.action === 'cancel') this.cancelled = true
      this.send({ id: d.id, result })
      this.expireApproval(d.id, 'answered')
      if (decision.action === 'cancel' && request.method === 'item/permissions/requestApproval') {
        void this.request('turn/interrupt', { threadId: params.threadId, turnId: params.turnId }).catch(() => {
          if (!this.closing) void this.cancel()
        })
      }
    }).catch(() => {
      if (abort.signal.aborted || this.closing) return
      deny()
      this.expireApproval(d.id, 'answered')
      this.emit({ type: 'ambidex.permission_error', message: 'No se pudo contestar el permiso; se ha denegado la acción.' })
    })
    return true
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
      if (!isCodexRequestId(d.id)) return
      if (!this.handleApproval(d)) this.send({ id: d.id, error: { code: -32601, message: 'Solicitud interactiva no disponible en Ambidex' } })
      return
    }
    const p = d.params ?? {}
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return
    switch (d.method) {
      case 'serverRequest/resolved':
        if (isCodexRequestId(p.requestId)) this.expireApproval(p.requestId, 'server-resolved')
        break
      case 'turn/started': this.turnId = p.turn.id; break
      case 'item/started':
      case 'item/completed': {
        const i = p.item ?? {}
        if (typeof i.id === 'string') {
          if (d.method === 'item/started') this.items.set(i.id, i)
          else this.items.delete(i.id)
        }
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
        this.expireApprovals('turn-ended')
        this.completed = true
        this.failed = p.turn.status !== 'completed'
        if (this.failed && !this.cancelled) this.emit({ type: 'turn.failed', error: { message: p.turn.error?.message || 'El turno de Codex se interrumpió' } })
        const u = this.usage
        this.emit({ type: 'turn.completed', usage: { input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens, output_tokens: u.outputTokens, reasoning_output_tokens: u.reasoningOutputTokens } })
        this.shutdown()
        break
      }
    }
  }
}
