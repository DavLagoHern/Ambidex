import { ManagedProcess, type AgentProcess, type ExitInfo, type ProcessHandlers, type ProcessSpec } from './runner'
import { parseJson, short, type RunRequest } from './types'

export class ClaudeLiveProcess implements AgentProcess {
  private proc: ManagedProcess
  private waiting = new Map<string, AbortController>()
  private background = new Set<string>()
  private result?: string
  private delivered = false
  private cancelled = false
  private closing = false
  readonly done: Promise<ExitInfo>

  constructor(spec: ProcessSpec, private req: RunRequest, private handlers: ProcessHandlers) {
    this.proc = new ManagedProcess({ ...spec, keepOpen: true }, {
      onStdout: line => this.onLine(line), onStderr: handlers.onStderr
    })
    this.done = this.proc.done.then(exit => {
      this.closing = true
      this.expire(this.cancelled ? 'cancelled' : 'process-exited')
      if (this.cancelled) return { ...exit, cancelled: true }
      if (exit.code === 0 && !this.delivered) {
        this.handlers.onStdout(JSON.stringify({ type: 'result', is_error: true, result: 'Claude se cerró antes de completar el trabajo pendiente.' }))
        return { ...exit, code: 1 }
      }
      return exit
    })
  }

  get pid() { return this.proc.pid }
  get inputOpen() { return !this.closing && this.proc.inputOpen }
  write(data: string) {
    if (!this.inputOpen) return false
    const accepted = this.proc.write(data)
    if (accepted && parseJson(data)?.type === 'user') this.result = undefined
    return accepted
  }
  endInput() { if (!this.background.size && !this.waiting.size) this.proc.endInput() }
  cancel(graceMs?: number) {
    this.cancelled = true; this.closing = true; this.expire('cancelled')
    return this.proc.cancel(graceMs)
  }

  private expire(reason: string) {
    for (const abort of this.waiting.values()) abort.abort(reason)
    this.waiting.clear()
  }

  private maybeFinish() {
    // Agrupar los mensajes recibidos en el mismo bloque de stdout: una petición
    // o un aviso de tareas en segundo plano puede acompañar al result.
    queueMicrotask(() => {
      if (this.closing || !this.result || this.waiting.size || this.background.size) return
      const line = this.result
      this.result = undefined; this.delivered = true; this.closing = true
      this.handlers.onStdout(line)
      this.proc.endInput()
    })
  }

  private permission(id: string, request: any) {
    if (this.waiting.has(id)) return
    const abort = new AbortController(); this.waiting.set(id, abort)
    const input = request.input && typeof request.input === 'object' ? request.input : {}
    const tool = String(request.tool_name ?? 'Herramienta')
    const updates = (Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [])
      .filter((s: any) => s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules))
      .map((s: any) => ({ ...s, rules: s.rules.filter((r: any) => typeof r?.toolName === 'string' && /^[\w-]+$/.test(r.toolName) && typeof r.ruleContent === 'string' && r.ruleContent.length > 0) }))
      .filter((s: any) => s.rules.length > 0)
    const rules: string[] = updates.flatMap((s: any) => s.rules.map((r: any) => `${r.toolName}(${r.ruleContent})`))
    const command = typeof input.command === 'string' ? input.command : undefined
    const paths = [input.file_path, input.notebook_path].filter((p): p is string => typeof p === 'string')
    const inputRequest = {
      nativeId: id, kind: (tool === 'Bash' ? 'command' : paths.length ? 'file' : 'tool') as 'command' | 'file' | 'tool',
      title: tool === 'Bash' ? 'Ejecutar un comando' : `Permitir ${tool}`, tool, command,
      cwd: this.req.cwd, paths, reason: typeof request.decision_reason === 'string' ? request.decision_reason : short(input, 2000),
      subagent: typeof request.agent_id === 'string' ? request.agent_id : undefined,
      grantKey: rules.length ? JSON.stringify(['claude', tool, input, this.req.cwd]) : undefined,
      claudeRules: rules
    }
    const ask = Promise.resolve().then(() => this.req.approvals?.request(inputRequest, abort.signal) ?? { allow: false, scope: 'once' as const, message: 'Permiso denegado en Ambidex' })
    void ask.then(decision => {
      if (abort.signal.aborted || this.closing || this.waiting.get(id) !== abort) return
      const response = decision.allow
        ? { behavior: 'allow', updatedInput: input, ...(decision.scope === 'session' && rules.length ? { updatedPermissions: updates.map((u: any) => ({ ...u, destination: 'session' })) } : {}) }
        : { behavior: 'deny', message: decision.message || 'Permiso denegado en Ambidex' }
      this.proc.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }) + '\n')
      this.waiting.delete(id)
      this.maybeFinish()
    }).catch(() => {
      if (!abort.signal.aborted && !this.closing) {
        this.proc.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: 'No se pudo contestar el permiso en Ambidex' } } }) + '\n')
        this.waiting.delete(id); this.maybeFinish()
      }
    })
  }

  private onLine(line: string) {
    const d = parseJson(line)
    if (!d) { this.handlers.onStdout(line); return }
    if (d.type === 'control_request' && typeof d.request_id === 'string') {
      if (d.request?.subtype === 'can_use_tool') this.permission(d.request_id, { ...d.request, agent_id: d.request.agent_id ?? d.agent_id })
      else this.proc.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: d.request_id, error: 'Solicitud interactiva no disponible en Ambidex' } }) + '\n')
      return
    }
    if (d.type === 'control_cancel_request') {
      this.waiting.get(d.request_id)?.abort('server-resolved'); this.waiting.delete(d.request_id)
      this.maybeFinish(); return
    }
    if (d.type === 'system' && d.subtype === 'background_tasks_changed') {
      const tasks = Array.isArray(d.tasks) ? d.tasks : Array.isArray(d.background_tasks) ? d.background_tasks : null
      if (tasks) this.background = new Set(tasks.map((t: any, i: number) => String(t?.id ?? t?.task_id ?? i)))
    } else if (d.type === 'system' && d.subtype === 'task_started') this.background.add(String(d.task_id ?? d.taskId ?? d.uuid ?? 'background'))
    if (d.type === 'result') { this.result = line; this.maybeFinish(); return }
    this.handlers.onStdout(line)
    this.maybeFinish()
  }
}
