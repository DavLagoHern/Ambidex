import type { PushChannel, PushContract } from '@shared/ipc'
import type { AgentId, ChatItem, QueuedMessage, RouteDecision, SessionMeta, Settings, ThreadMeta } from '@shared/types'
import { AGENT_NAMES, DEFAULT_ROUTE_PREFS } from '@shared/types'
import { titleFromPrompt } from '@shared/chat'
import { aiRoutePrompt, Classification, decideRoute, RouteContext } from '@shared/router'
import type { Store } from '../db/store'
import type { SessionService } from './service'

const NEW_TITLE = 'Nueva conversación'

export interface DispatcherDeps {
  store: Store
  service: SessionService
  push: <K extends PushChannel>(channel: K, payload: PushContract[K]) => void
  settings: () => Settings
  available: (agent: AgentId) => boolean
  // enrutado con IA: devuelve el texto de un modelo rápido
  aiRoute?: (prompt: string, cwd: string) => Promise<string>
  // enrutado con Jev (modelo local de decisiones): tipo de tarea y si continúa la conversación
  jev?: { classify: (text: string, ctx: { previousAgent?: string; previousRequest?: string }) => Promise<Classification> }
}

// Tiempo máximo que se espera a Jev; si no contesta (p. ej. arrancando), deciden las reglas y Jev sigue arrancando
const JEV_BUDGET = { send: 3000, preview: 1200 }

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])
}

export interface ThreadSendResult {
  decision?: RouteDecision
  sessionId?: string
  queued?: QueuedMessage
}

// Chat único con dos agentes (enrutado) y colas de mensajes
export class Dispatcher {
  private processing = new Set<string>()

  constructor(private d: DispatcherDeps) {}

  // ---------- hilos ----------

  createThread(projectId: string): ThreadMeta {
    const t = this.d.store.createThread(projectId)
    this.d.push('thread:meta', t)
    return t
  }

  private sessionOf(thread: ThreadMeta, agent: AgentId): SessionMeta | undefined {
    const id = thread.sessions[agent]
    return id ? this.d.service.getSession(id) : undefined
  }

  private lastAgent(thread: ThreadMeta): AgentId | undefined {
    let best: { agent: AgentId; at: number } | undefined
    for (const agent of ['claude', 'codex'] as AgentId[]) {
      const s = this.sessionOf(thread, agent)
      if (!s || !s.messageCount) continue
      if (!best || s.updatedAt > best.at) best = { agent, at: s.updatedAt }
    }
    return best?.agent
  }

  routeContext(thread?: ThreadMeta): RouteContext {
    const s = this.d.settings()
    const limits = this.d.store.getLimits()
    const usage: Partial<Record<AgentId, number>> = {}
    for (const a of ['claude', 'codex'] as AgentId[]) {
      const w = limits[a]?.windows
      if (w?.length) usage[a] = Math.max(...w.map((x) => x.usedPercent))
    }
    return {
      available: { claude: this.d.available('claude'), codex: this.d.available('codex') },
      busy: {
        claude: !!thread && !!this.sessionOf(thread, 'claude')?.running,
        codex: !!thread && !!this.sessionOf(thread, 'codex')?.running
      },
      usage,
      lastAgent: thread ? this.lastAgent(thread) : undefined,
      prefs: { ...DEFAULT_ROUTE_PREFS, ...(s.routePrefs ?? {}) },
      defaultAgent: s.defaultAgent
    }
  }

  // Vista previa mientras el usuario escribe: con Jev si está activo (unas decenas de ms), si no por reglas
  async preview(threadId: string | null, text: string): Promise<RouteDecision> {
    const thread = threadId ? this.d.store.getThread(threadId) ?? undefined : undefined
    const ctx = this.routeContext(thread)
    return decideRoute(text, ctx, await this.understand(thread, text, ctx, JEV_BUDGET.preview))
  }

  private async understand(thread: ThreadMeta | undefined, text: string, ctx: RouteContext, budget: number): Promise<Classification | undefined> {
    if (this.d.settings().routerMode !== 'jev' || !this.d.jev || !text.trim() || /^@(claude|codex)\b/i.test(text.trim())) return
    const last = ctx.lastAgent && thread ? this.sessionOf(thread, ctx.lastAgent) : undefined
    const previousRequest = last ? this.d.store.lastUserText(last.id) : undefined
    return within(this.d.jev.classify(text, { previousAgent: ctx.lastAgent && AGENT_NAMES[ctx.lastAgent], previousRequest }), budget)
  }

  private async decide(thread: ThreadMeta, text: string, override?: AgentId): Promise<RouteDecision> {
    if (override) return { agent: override, reason: `Elegido por ti → ${AGENT_NAMES[override]}`, method: 'manual' }
    const ctx = this.routeContext(thread)
    if (this.d.settings().routerMode === 'jev') return decideRoute(text, ctx, await this.understand(thread, text, ctx, JEV_BUDGET.send))
    const rules = decideRoute(text, ctx)
    if (rules.method === 'mention' || this.d.settings().routerMode !== 'ai' || !this.d.aiRoute) return rules
    try {
      const cwd = this.d.store.getProject(thread.projectId)?.path ?? process.cwd()
      const out = await this.d.aiRoute(aiRoutePrompt(text, ctx), cwd)
      const m = out.match(/\{[\s\S]*\}/)
      const j = m ? JSON.parse(m[0]) : null
      if (j?.agent === 'claude' || j?.agent === 'codex') {
        const agent = j.agent as AgentId
        if (!ctx.available[agent]) return rules
        return { agent, reason: String(j.reason || `Decidido por IA → ${AGENT_NAMES[agent]}`).slice(0, 160), method: 'ai', category: rules.category }
      }
    } catch {
      /* si falla, se usan las reglas */
    }
    return rules
  }

  // Lo que el otro agente ha hecho en este hilo desde la última vez que habló este, para no perder el hilo
  private crossContext(thread: ThreadMeta, agent: AgentId): string {
    const mine = this.sessionOf(thread, agent)
    const otherId = thread.sessions[agent === 'claude' ? 'codex' : 'claude']
    if (!otherId) return ''
    const myItems = mine ? this.d.store.messages(mine.id) : []
    const since = [...myItems].reverse().find((i) => i.type === 'user')?.at ?? 0
    const items = this.d.store.messages(otherId)
    const turns: { user: string; answer: string }[] = []
    let cur: { user: string; answer: string; at: number } | null = null
    for (const it of items as ChatItem[]) {
      if (it.type === 'user') {
        if (cur && cur.at > since) turns.push(cur)
        cur = { user: it.text, answer: '', at: it.at }
      } else if (it.type === 'assistant' && cur) cur.answer = it.text
    }
    if (cur && cur.at > since) turns.push(cur)
    if (!turns.length) return ''
    const otherName = AGENT_NAMES[agent === 'claude' ? 'codex' : 'claude']
    const body = turns
      .slice(-4)
      .map((t) => `Usuario: ${t.user.slice(0, 800)}\n${otherName}: ${t.answer.slice(-1500)}`)
      .join('\n\n')
    return `<conversacion_previa>\nEn esta conversación también participa ${otherName}. Esto es lo último que se habló con él:\n\n${body}\n</conversacion_previa>`
  }

  private ensureSession(thread: ThreadMeta, agent: AgentId): SessionMeta {
    const existing = this.sessionOf(thread, agent)
    if (existing) return existing
    const s = this.d.settings()
    const project = this.d.store.getProject(thread.projectId)
    if (!project) throw new Error('Proyecto no encontrado')
    const session = this.d.store.createSession(thread.projectId, project.path, {
      agent,
      title: thread.title,
      threadId: thread.id,
      model: agent === 'claude' ? s.claudeModel : s.codexModel,
      effort: agent === 'claude' ? s.claudeEffort : s.codexEffort,
      permission: agent === 'claude' ? s.claudeMode : s.codexSandbox
    })
    this.d.push('session:meta', session)
    return session
  }

  async sendThread(threadId: string, text: string, opts: { agent?: AgentId; context?: string; images?: string[]; fromQueue?: boolean } = {}): Promise<ThreadSendResult> {
    const thread = this.d.store.getThread(threadId)
    if (!thread) throw new Error('Conversación no encontrada')
    const decision = await this.decide(thread, text, opts.agent)
    const target = this.sessionOf(thread, decision.agent)
    // si el agente elegido está ocupado (o los dos), el mensaje espera en la cola del hilo
    if (target?.running) {
      if (opts.fromQueue) return {}
      const queued = this.d.store.enqueue({
        projectId: thread.projectId,
        threadId,
        prompt: text,
        context: opts.context,
        images: opts.images,
        agent: decision.method === 'rules' ? undefined : decision.agent
      })
      this.pushQueue(thread.projectId)
      return { queued, decision }
    }
    const session = this.ensureSession(thread, decision.agent)
    const cross = this.crossContext(thread, decision.agent)
    const context = [cross, opts.context].filter(Boolean).join('\n\n') || undefined
    const prompt = text.replace(/^@(claude|codex)\b\s*/i, '') || text
    this.d.service.send(session.id, prompt, context, { route: decision, images: opts.images })
    const updated = this.d.store.updateThread(threadId, {
      title: thread.title === NEW_TITLE ? titleFromPrompt(prompt) : undefined,
      updatedAt: Date.now()
    })
    if (updated.title !== thread.title) for (const sid of Object.values(updated.sessions)) if (sid) this.d.store.updateSession(sid, { title: updated.title })
    this.d.push('thread:meta', updated)
    return { decision, sessionId: session.id }
  }

  // ---------- cola ----------

  enqueue(m: { projectId: string; sessionId?: string; threadId?: string; prompt: string; context?: string; images?: string[] }): QueuedMessage {
    const q = this.d.store.enqueue(m)
    this.pushQueue(m.projectId)
    return q
  }

  remove(id: string) {
    const q = this.d.store.getQueued(id)
    this.d.store.removeQueued(id)
    if (q) this.pushQueue(q.projectId)
  }

  update(id: string, prompt: string) {
    const q = this.d.store.getQueued(id)
    if (!q) return
    this.d.store.updateQueued(id, prompt)
    this.pushQueue(q.projectId)
  }

  // Envía ya un mensaje de la cola (si su destino está libre)
  async sendNow(id: string) {
    const q = this.d.store.getQueued(id)
    if (!q) return
    if (q.threadId) {
      this.d.store.removeQueued(id)
      const r = await this.sendThread(q.threadId, q.prompt, { agent: q.agent, context: q.context, images: q.images })
      if (!r.queued) this.pushQueue(q.projectId)
      return
    }
    if (q.sessionId) {
      if (this.d.service.isRunning(q.sessionId)) throw new Error('El agente sigue trabajando; se enviará cuando termine')
      this.d.store.removeQueued(id)
      this.pushQueue(q.projectId)
      this.d.service.send(q.sessionId, q.prompt, q.context, { images: q.images })
    }
  }

  // Una conversación ha quedado libre: siguiente mensaje de su cola
  async onIdle(session: SessionMeta) {
    try {
      if (session.threadId) {
        // los dos agentes del hilo pueden quedar libres a la vez: un solo procesado
        const key = session.threadId
        if (this.processing.has(key)) return
        this.processing.add(key)
        try {
          const next = this.d.store.nextQueued({ threadId: key })
          if (!next) return
          const r = await this.sendThread(key, next.prompt, { agent: next.agent, context: next.context, images: next.images, fromQueue: true })
          // si el destino sigue ocupado, el mensaje se queda en su sitio de la cola
          if (r.sessionId) this.d.store.removeQueued(next.id)
        } finally {
          this.processing.delete(key)
          this.pushQueue(session.projectId)
        }
      } else if (!session.orchestrationId) {
        const next = this.d.store.nextQueued({ sessionId: session.id })
        if (!next) return
        this.d.store.removeQueued(next.id)
        this.pushQueue(session.projectId)
        this.d.service.send(session.id, next.prompt, next.context, { images: next.images })
      }
    } catch {
      this.pushQueue(session.projectId)
    }
  }

  pushQueue(projectId: string) {
    this.d.push('queue:changed', { projectId, items: this.d.store.listQueue(projectId) })
  }
}
